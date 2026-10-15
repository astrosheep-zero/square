import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { nativePayload, observeClaudeDelivery } from '../dist/claude-delivery.js';
import { seedLedger, readLedgerRecords, readLedgerRevisions, interceptLedgerSql } from './host-ledger-fixtures.js';

const DAY = 86400000;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-retire-'));
  let now = 1;
  const ledgerRoot = path.join(root, 'ledger');
  const ledger = createHostLedgerPort({ rootPath: ledgerRoot, now: () => now });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, ledgerRoot, ledger, advance: value => { now = value; }, env: { ...process.env, SQUARE_HOST_LEDGER_ROOT: ledgerRoot } };
}
async function prepared(f, index, outcome = 'unknown', harness = 'claude') {
  const coordinate = { location: path.join(f.root, 'missing.square'), participant: 'Bob', session: 'receiver', activity: `act/${index}`, kind: 'wake' };
  const claim = await f.ledger.claimWakeAttempt({ attention: { squarePath: coordinate.location, recipient: coordinate.participant, actIndex: index }, session: coordinate.session, routeKind: harness === 'claude' ? 'claude-native' : 'opencode-native', leaseMs: 50, now: 1 });
  assert.equal(claim.status, 'acquired');
  const nativeDelivery = harness === 'claude' ? { harness, epoch: 1, endpoint: '/private/native.sock', payload: nativePayload(claim.claimToken, 'private body') } : { harness, epoch: 1, inputId: 'private-input', payload: 'private body' };
  const row = { ...coordinate, claimToken: claim.claimToken, attemptN: claim.attemptN, routeKind: harness === 'claude' ? 'claude-native' : 'opencode-native', nativeDelivery };
  assert.equal(await f.ledger.prepareNativeWake({ ...row, outcome: 'dispatching' }), true);
  if (outcome === 'released') await f.ledger.releaseEvidence({ ...row, now: 1 });
  else if (outcome !== 'dispatching') await f.ledger.appendEvidence({ ...row, outcome, at: 1 });
  return (await f.ledger.listEvidence({ activity: row.activity, includeReleased: true, includeExpired: true, now: 1 }))[0];
}

test('prepared Claude correlations survive logical TTL and mutation housekeeping across outcomes', async t => {
  const f = fixture(t);
  const outcomes = ['dispatching', 'unknown', 'accepted', 'failed', 'released'];
  const rows = [];
  for (const [index, outcome] of outcomes.entries()) rows.push(await prepared(f, index, outcome));
  await prepared(f, 20, 'failed', 'opencode');
  const claim = await f.ledger.claimEvidence({ location: rows[0].location, participant: 'Bob', session: 'receiver', activity: 'act/21', kind: 'presentation', leaseMs: 50, now: 1 });
  await f.ledger.appendEvidence({ location: rows[0].location, participant: 'Bob', session: 'receiver', activity: 'act/21', kind: 'presentation', outcome: 'clipped', claimToken: claim.claimToken, at: 1 });
  f.advance(10 * DAY);
  assert.deepEqual((await f.ledger.listEvidence({ includeReleased: true })).map(row => row.outcome), outcomes);
  assert.equal((await f.ledger.listEvidence({ includeExpired: true, includeReleased: true })).length, 7);
  // A real evidence mutation may prune ordinary expired rows, never receive-veto credentials.
  await f.ledger.claimEvidence({ location: rows[0].location, participant: 'New', session: 'other', activity: 'act/30', kind: 'presentation', leaseMs: 50 });
  assert.deepEqual((await f.ledger.listEvidence({ session: 'receiver', includeExpired: true, includeReleased: true })).map(row => row.outcome), outcomes);
  const lookup = await f.ledger.lookupNativeTokens({ harness: 'claude', session: 'receiver', tokens: rows.map(row => row.claimToken) });
  assert.deepEqual(lookup.deliveries.map(row => row.outcome), outcomes);
  assert.deepEqual(lookup.retired, []);
  assert.deepEqual(await f.ledger.lookupNativeTokens({ harness: 'claude', session: 'other', tokens: rows.map(row => row.claimToken) }), { deliveries: [], retired: [] });
  assert.equal(await f.ledger.nextExpiry('receiver'), Infinity);
  for (const row of rows.filter(row => ['failed', 'released'].includes(row.outcome))) {
    assert.deepEqual(await observeClaudeDelivery('receiver', row.nativeDelivery.payload, 'stored', f.env), { recognized: true, current: false });
  }
});

test('maintenance age bypass still excludes future evidence and released rows require explicit enumeration', async t => {
  const f = fixture(t);
  const coordinate = { location: path.join(f.root, 'S.square'), participant: 'Bob', session: 'receiver', kind: 'presentation' };
  for (const [activity, at] of [['act/2', 20 * DAY], ['act/1', 1]]) {
    const claim = await f.ledger.claimEvidence({ ...coordinate, activity, leaseMs: 1, now: at });
    assert.equal(claim.status, 'acquired');
    await f.ledger.releaseEvidence({ ...coordinate, activity, claimToken: claim.claimToken, now: at });
  }
  f.advance(10 * DAY);
  assert.deepEqual(await f.ledger.listEvidence({ includeExpired: true }), []);
  assert.deepEqual(await f.ledger.listEvidence({ includeReleased: true }), []);
  assert.deepEqual((await f.ledger.listEvidence({ includeExpired: true, includeReleased: true })).map(row => row.activity), ['act/1']);
});

test('exact-record retirement fences every persisted field, refuses dispatching, and never resurrects', async t => {
  const f = fixture(t);
  const active = await prepared(f, 1, 'dispatching');
  assert.equal(await f.ledger.retireEvidenceIfUnchanged(active), false);
  const expected = await prepared(f, 2);
  const observers = await f.ledger.observeChanges();
  t.after(() => { observers.presence.close(); observers.evidence.close(); });
  const revision = await observers.evidence.read();
  for (const change of [
    { at: 2 }, { outcome: 'accepted' }, { unknownSource: 'interrupted' }, { expiresAt: 10 },
    { signature: 'changed' }, { nativeDelivery: { ...expected.nativeDelivery, payload: 'changed' } },
    { claimToken: 'different' }, { ownerPid: 999999 }, { diagnostic: { changed: true } },
  ]) assert.equal(await f.ledger.retireEvidenceIfUnchanged({ ...expected, ...change }), false);
  assert.equal(await observers.evidence.read(), revision, 'CAS misses cannot advance revision');
  assert.equal(await f.ledger.confirmWakeAdmission(expected), true);
  assert.equal(await f.ledger.retireEvidenceIfUnchanged(expected), false, 'a real concurrent admission wins over captured GC');
  const latest = (await f.ledger.listEvidence({ activity: 'act/2' }))[0];
  assert.equal(await f.ledger.retireEvidenceIfUnchanged(latest), true);
  assert.equal(await f.ledger.retireEvidenceIfUnchanged(latest), false);
  await f.ledger.appendEvidence({ ...expected, outcome: 'accepted' });
  await f.ledger.releaseEvidence({ ...expected, now: 100 });
  assert.equal(await f.ledger.confirmWakeAdmission(expected), false);
  assert.deepEqual(await f.ledger.listEvidence({ activity: 'act/2', includeExpired: true, includeReleased: true }), []);
  assert.deepEqual(await f.ledger.lookupNativeTokens({ harness: 'claude', session: 'receiver', tokens: [latest.claimToken] }), { deliveries: [], retired: [latest.claimToken] });
  assert.equal((await f.ledger.listWakeAttempts()).length, 1, 'retired tokens are not wake attempts');
});

test('retirement touches only the exact row, retains unusable Claude correlations, and creates no OpenCode tokens', async t => {
  const f = fixture(t);
  const native = await prepared(f, 1);
  const opencode = await prepared(f, 2, 'unknown', 'opencode');
  const broken = { ...native, activity: 'act/3', claimToken: undefined };
  const unrelated = { ...native, activity: 'act/4', kind: 'presentation', outcome: 'clipped', nativeDelivery: undefined };
  seedLedger(f.ledgerRoot, { evidence: [broken, unrelated] });
  f.advance(10 * DAY);
  const malformed = (await f.ledger.listEvidence({ activity: 'act/3', includeExpired: true }))[0];
  const before = await readLedgerRevisions(f.ledgerRoot);
  assert.equal(await f.ledger.retireEvidenceIfUnchanged(malformed), false);
  assert.deepEqual(await readLedgerRevisions(f.ledgerRoot), before);
  assert.equal(await f.ledger.retireEvidenceIfUnchanged(native), true);
  assert.equal(await f.ledger.retireEvidenceIfUnchanged(opencode), true);
  assert.deepEqual(readLedgerRecords(f.ledgerRoot, 'evidence').map(row => row.activity), ['act/3', 'act/4'], 'no incidental TTL housekeeping');
  assert.deepEqual(await f.ledger.lookupNativeTokens({ harness: 'claude', session: 'receiver', tokens: [native.claimToken, opencode.claimToken] }), { deliveries: [], retired: [native.claimToken] });
});

test('atomic live-to-token lookup never returns a recognition gap and tokens persist on reopening', async t => {
  const f = fixture(t);
  const row = await prepared(f, 1);
  const input = { harness: 'claude', session: 'receiver', tokens: [row.claimToken] };
  const second = createHostLedgerPort({ rootPath: f.ledgerRoot, now: () => 20 * DAY });
  const lookups = await Promise.all([
    ...Array.from({ length: 4 }, () => second.lookupNativeTokens(input)),
    f.ledger.retireEvidenceIfUnchanged(row),
    ...Array.from({ length: 4 }, () => second.lookupNativeTokens(input)),
  ]);
  assert.equal(lookups[4], true);
  for (const snapshot of lookups.filter(value => typeof value !== 'boolean')) {
    assert.equal(snapshot.deliveries.length + snapshot.retired.length, 1);
  }
  f.advance(100 * DAY);
  assert.deepEqual(await second.lookupNativeTokens(input), { deliveries: [], retired: [row.claimToken] });
  assert.deepEqual(await second.listEvidence({ includeExpired: true, includeReleased: true }), []);
});

test('lookup pins one snapshot while another connection tries the live-to-token swap', async t => {
  const f = fixture(t);
  const row = await prepared(f, 1);
  let raced = false, committed = false;
  interceptLedgerSql(t, f.ledgerRoot, (method, sql) => {
    if (raced || method !== 'prepare' || !sql.startsWith('SELECT token_key FROM host_native_tokens')) return;
    raced = true;
    const writer = new DatabaseSync(path.join(f.ledgerRoot, 'host-ledger.sqlite'));
    try {
      writer.exec('BEGIN IMMEDIATE');
      writer.prepare("INSERT INTO host_native_tokens(harness,session_key,token_key) VALUES('claude',?,?)").run(JSON.stringify(row.session), JSON.stringify(row.claimToken));
      writer.prepare('DELETE FROM host_evidence WHERE claim_token_key=?').run(JSON.stringify(row.claimToken));
      try { writer.exec('COMMIT'); committed = true; }
      catch (error) { assert.match(error.message, /locked|busy/); }
      finally { if (!committed) writer.exec('ROLLBACK'); }
    } finally { writer.close(); }
  });
  const input = { harness: 'claude', session: 'receiver', tokens: [row.claimToken] };
  assert.deepEqual(await f.ledger.lookupNativeTokens(input), { deliveries: [row], retired: [] });
  assert.equal(raced, true);
  assert.equal(committed, false, 'a writer cannot commit between the two halves of one recognition snapshot');
  t.mock.restoreAll();
  assert.equal(await f.ledger.retireEvidenceIfUnchanged(row), true);
  assert.deepEqual(await f.ledger.lookupNativeTokens(input), { deliveries: [], retired: [row.claimToken] });
});

test('retired frames veto guard, admission and stored callbacks at any age without artifact or receipt authority', async t => {
  const f = fixture(t);
  const row = await prepared(f, 1);
  assert.equal(await f.ledger.retireEvidenceIfUnchanged(row), true);
  f.advance(100 * DAY);
  const file = path.join(f.ledgerRoot, 'host-ledger.sqlite');
  const bytes = fs.readFileSync(file);
  for (const operation of ['guard', 'admitted', 'stored']) {
    assert.deepEqual(await observeClaudeDelivery('receiver', row.nativeDelivery.payload, operation, f.env), { recognized: true, current: false });
    assert.deepEqual(await observeClaudeDelivery('receiver', '[square-inbox:invented]\nunknown\n[/square-inbox:invented]', operation, f.env), { recognized: false, current: false });
  }
  assert.deepEqual(fs.readFileSync(file), bytes, 'recognition never changes evidence');
  assert.equal(fs.existsSync(row.location), false, 'tokens do not authorize artifact access');
});
