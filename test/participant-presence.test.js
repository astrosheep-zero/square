import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { buildSquare, closeOpenSquare } from '../dist/open-square.js';
import { FileHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { catchUp, express, join, takeover } from '../dist/square-actions.js';
import { identityRouteDraft, publishCommittedIdentity } from '../dist/participant-host.js';
import { defaultWakeRouteCapabilities, ROUTE_FRESH_MS } from '../dist/routes.js';

test('route drafting loads adapters only when a host-backed candidate exists', () => {
  // A fresh process makes cold module loading observable; route discovery catches import failures.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const loaded = new Set();
    registerHooks({ load(url, context, nextLoad) {
      if (url.endsWith('/codex-queue.js') || url.endsWith('/paseo-delivery.js')) loaded.add(url);
      return nextLoad(url, context);
    } });
    const { identityRouteDraft } = await import(${JSON.stringify(new URL('../dist/participant-host.js', import.meta.url).href)});
    const base = { location: '/square', hostLedger: {} };
    assert.equal(await identityRouteDraft({ ...base, env: { PI_SESSION_ID: 'pi-local', PASEO_AGENT_ID: ' ' } }, 'Alice'), undefined);
    assert.equal(await identityRouteDraft({ ...base, env: { CLAUDE_CODE_SESSION_ID: 'claude-local' } }, 'Alice'), undefined);
    assert.equal(await identityRouteDraft({ ...base, hostLedger: undefined, env: { CODEX_THREAD_ID: 'thread-local' } }, 'Alice'), undefined);
    assert.equal(loaded.size, 0, 'no possible route means no optional adapter imports');
    const native = await identityRouteDraft({ ...base, env: { CODEX_THREAD_ID: 'thread-local' } }, 'Alice');
    assert.equal(native.kind, 'codex-queue');
    assert.deepEqual(native.address, { threadId: 'thread-local' });
    const paseo = await identityRouteDraft({ ...base, env: { PI_SESSION_ID: 'pi-local', PASEO_AGENT_ID: ' agent-local ' } }, 'Alice');
    assert.equal(paseo.kind, 'paseo');
    assert.equal(paseo.channel, 'pi');
    assert.equal(paseo.sessionId, 'pi-local');
    assert.deepEqual(paseo.address, { agentId: 'agent-local' });
    assert.equal(loaded.size, 2, 'real candidates still load and check installed adapters');
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, `${child.error ?? ''}${child.stderr}`);
});

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-publication-'));
  const ledger = new FileHostLedgerPort({ rootPath: path.join(root, 'ledger') });
  const square = await buildSquare(path.join(root, 'PUBLIC.square'), {
    markdown: 'publication', hardCap: null, clock: () => 100, hostLedger: ledger,
    env: { CODEX_THREAD_ID: 'local', PI_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', OPENCODE_SESSION_ID: '', PASEO_AGENT_ID: '' },
  });
  t.after(async () => { await closeOpenSquare(square); fs.rmSync(root, { recursive: true, force: true }); });
  await join(square, 'Alice');
  await join(square, 'Bob');
  await express(square, 'Bob', 'pending for Alice', { mentions: ['Alice'], force: true });
  const presence = () => ledger.listPresence({ location: square.location, participant: 'Alice' });
  const routes = async () => (await square.artifact.read((facts) => facts.routes().filter((route) => route.participant === 'Alice'))).value;
  return { square, ledger, presence, routes };
}

test('catch admits independently, then observes the participant once after committing without rewriting fresh presence', async (t) => {
  const { square, ledger, presence, routes } = await fixture(t);
  const before = await presence(), beforeRoutes = await routes();
  const list = ledger.listPresence.bind(ledger), transact = square.artifact.transact.bind(square.artifact);
  const events = [], lookups = [];
  ledger.listPresence = async (lookup) => { events.push('observe'); lookups.push(lookup); return list(lookup); };
  ledger.ensurePresence = async () => { assert.fail('fresh presence must not be rewritten'); };
  square.artifact.transact = async (...args) => { const result = await transact(...args); events.push('commit'); return result; };

  const caught = await catchUp(square, 'Alice');
  assert.equal(caught.participant, 'Alice');
  assert.ok(caught.activities.some((activity) => activity.body === 'pending for Alice'));
  assert.equal(caught.remaining, 0);
  assert.deepEqual(events, ['observe', 'commit', 'observe', 'commit']);
  assert.equal(lookups.length, 2, 'one admission and one postcommit publication observation');
  for (const lookup of lookups) {
    assert.equal(lookup.location, fs.realpathSync.native(square.location));
    assert.equal(lookup.participant, 'Alice');
    assert.equal(lookup.session, undefined, 'owner and local binding come from the same all-session observation');
    assert.ok(lookup.now > 100, 'presence expiry uses wall time, not the artifact clock');
  }
  assert.deepEqual(await list({ location: square.location, participant: 'Alice' }), before);
  assert.deepEqual(await routes(), beforeRoutes);
  // Route publication still enters a transaction even when its facts are unchanged.
});

test('stale publication refreshes at the observed owner epoch and retains cancellation written after observation', async (t) => {
  const { square, ledger, presence, routes } = await fixture(t);
  const owner = (await presence())[0];
  await ledger.ensurePresence({ ...owner, epoch: 7, updatedAt: Date.now() - ROUTE_FRESH_MS - 1 });
  // A newer timestamp on another channel must not beat the higher epoch.
  await ledger.ensurePresence({ ...owner, channel: 'pi', epoch: 6, updatedAt: Date.now() });
  const ensure = ledger.ensurePresence.bind(ledger);
  let writes = 0;
  ledger.ensurePresence = async (input) => {
    writes += 1;
    assert.equal(input.epoch, 7);
    await ledger.suppressPresence({ ...owner, epoch: 7 }, 42);
    return ensure(input);
  };
  const refreshed = { ...square, clock: () => 100 + ROUTE_FRESH_MS, env: { ...square.env, PASEO_AGENT_ID: 'new-address' } };
  await publishCommittedIdentity(refreshed, 'Alice');
  assert.equal(writes, 1);
  const local = (await presence()).find((row) => row.channel === 'codex');
  assert.equal(local.epoch, 7);
  assert.equal(local.cancelledThrough, 42);
  assert.ok(local.updatedAt > Date.now() - 1000);
  assert.deepEqual((await routes()).map((route) => [route.epoch, route.kind, route.address, route.updatedAt]),
    [[7, 'paseo', { agentId: 'new-address' }, 100 + ROUTE_FRESH_MS]]);
});

test('takeover publishes the explicit claim epoch while its old standing owner remains visible', async (t) => {
  const { square, ledger, routes } = await fixture(t);
  const ensure = ledger.ensurePresence.bind(ledger), list = ledger.listPresence.bind(ledger);
  let publishedDuringClaim = false;
  ledger.ensurePresence = async (input) => {
    if (!publishedDuringClaim) {
      const standing = await list({ location: square.location, participant: 'Alice' });
      assert.deepEqual(standing.map((row) => [row.session, row.epoch]), [['local', 1]]);
      assert.equal(input.epoch, 2);
      publishedDuringClaim = true;
    }
    return ensure(input);
  };
  const result = await takeover({ ...square, env: { ...square.env, CODEX_THREAD_ID: 'replacement' } }, 'Alice');
  assert.equal(result.epoch, 2);
  assert.equal(publishedDuringClaim, true);
  assert.deepEqual((await routes()).map((route) => [route.sessionId, route.epoch]), [['replacement', 2]]);
});

test('unreadable observation cannot invent an owner; readable presence and route failures remain independent of committed results', async (t) => {
  const { square, ledger, routes } = await fixture(t);
  const list = ledger.listPresence.bind(ledger), ensure = ledger.ensurePresence.bind(ledger);
  const beforeRoutes = await routes();
  const warnings = [];
  t.mock.method(process.stderr, 'write', (text) => { warnings.push(String(text)); return true; });
  let reads = 0;
  ledger.listPresence = async (lookup) => {
    if (++reads > 1) throw new Error('observation unavailable');
    return list(lookup);
  };
  ledger.ensurePresence = async () => { assert.fail('failed observation cannot manufacture a generation'); };
  // Admission succeeds, publication fails after the receipt transaction.
  const caught = await catchUp(square, 'Alice');
  assert.equal(caught.participant, 'Alice');
  const consumed = caught.activities.find((activity) => activity.body === 'pending for Alice');
  assert.ok(consumed);
  assert.deepEqual((await square.artifact.read((facts) => facts.receipt('Alice', consumed.index))).value, { at: 100 });
  assert.equal(caught.remaining, 0);
  assert.equal(reads, 2);
  assert.deepEqual(await routes(), beforeRoutes);
  assert.match(warnings.join(''), /host presence degraded: observation unavailable/);
  await identityRouteDraft(square, 'Alice');
  assert.equal(reads, 2, 'lifecycle route drafting only discovers installed adapters');
  assert.equal((await defaultWakeRouteCapabilities()).canUse('codex-queue', { threadId: 'local' }), false);

  ledger.listPresence = list;
  const owner = (await list({ location: square.location, participant: 'Alice' }))[0];
  await ensure({ ...owner, updatedAt: Date.now() - ROUTE_FRESH_MS - 1 });
  ledger.ensurePresence = async () => { throw new Error('presence write unavailable'); };
  const changed = { ...square, env: { ...square.env, PASEO_AGENT_ID: 'changed' } };
  const expressed = await express(changed, 'Alice', 'committed despite presence failure', { force: true });
  assert.equal(expressed.activity.body, 'committed despite presence failure');
  assert.equal((await routes())[0].kind, 'paseo', 'readable observation still allows the independent route attempt');
  assert.match(warnings.join(''), /host presence degraded: presence write unavailable/);

  const transact = square.artifact.transact.bind(square.artifact);
  let transactions = 0;
  square.artifact.transact = async (...args) => {
    if (++transactions === 2) throw new Error('route write unavailable');
    return transact(...args);
  };
  const second = await express(square, 'Alice', 'committed despite route failure', { force: true });
  assert.equal(second.activity.body, 'committed despite route failure');
  assert.equal(transactions, 2, 'authoritative commit precedes optional route publication');
  const last = (await square.artifact.read((facts) => facts.activity(Number(second.activity.id.slice(4))))).value;
  assert.equal(last.body, second.activity.body);
});
