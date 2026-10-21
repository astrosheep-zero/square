import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertLiveOwner, ensureLocalPresence, identityRouteDraft, publishCommittedIdentity } from '../dist/participant-host.js';
import { currentOwner } from '../dist/registry.js';
import { ROUTE_FRESH_MS } from '../dist/routes.js';

function fixture(t, initial = []) {
  const location = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'square-host-ownership-'))), 'test.square');
  t.after(() => fs.rmSync(path.dirname(location), { recursive: true, force: true }));
  const now = 2 * ROUTE_FRESH_MS;
  t.mock.method(Date, 'now', () => now);
  let rows = initial.map((row) => ({ location, participant: 'p', ...row }));
  const writes = [], routes = [];
  let transactions = 0, reads = 0;
  // Only the host helpers' ledger operations are implemented; no disk-backed ledger or Square API.
  const hostLedger = {
    async listPresence({ location: requested, participant }) {
      reads += 1;
      assert.equal(requested, location);
      assert.equal(participant, 'p');
      return rows;
    },
    async ensurePresence(record) {
      writes.push(record);
      rows = rows.filter((row) => row.session !== record.session || row.channel !== record.channel);
      rows.push(record);
      return { status: 'ensured', record };
    },
  };
  const artifact = {
    async transact(fn) {
      transactions += 1;
      return { value: fn({
        routes: () => routes,
        participant: () => ({ joined: true }),
        replaceRoutes: (next) => routes.splice(0, routes.length, ...next),
      }) };
    },
  };
  const context = { location, hostLedger, artifact, clock: () => now, env: {} };
  return { context, writes, routes, rows: () => rows, reads: () => reads, transactions: () => transactions, now };
}

test('sessionless relay cannot publish presence or a wake route over a harness owner', async (t) => {
  const owner = { session: 'native-owner', channel: 'pi', epoch: 7, updatedAt: 1, cancelledThrough: 42 };
  const f = fixture(t, [owner]);
  const native = { ...f.context, env: { PI_SESSION_ID: owner.session } };
  assert.equal(await assertLiveOwner(native, 'p', 7), true);

  assert.equal(await ensureLocalPresence(f.context, 'p'), undefined, 'relay must not borrow epoch 7');
  await publishCommittedIdentity(f.context, 'p');

  assert.deepEqual(f.writes, [], 'a newer process row would displace the owner at the same epoch');
  assert.equal(f.transactions(), 0, 'no route publication may follow a skipped presence observation');
  assert.deepEqual(f.routes, []);
  assert.deepEqual(f.rows(), [{ location: f.context.location, participant: 'p', ...owner }]);
  assert.equal(await assertLiveOwner(native, 'p', 7), true, 'the native owner remains usable');
});

test('sessionless relay cannot add pollution when process rows already obscure native presence', async (t) => {
  const f = fixture(t, [
    { session: 'native-owner', channel: 'pi', epoch: 7, updatedAt: 1, cancelledThrough: 42 },
    { session: 'process:foreign', channel: 'unknown', epoch: 7, updatedAt: 2 },
    { session: `process:${process.pid}`, channel: 'unknown', epoch: 7, updatedAt: 2 * ROUTE_FRESH_MS },
  ]);
  const before = structuredClone(f.rows());
  assert.equal(currentOwner(before).channel, 'unknown');
  assert.equal(await ensureLocalPresence(f.context, 'p'), undefined, 'even a fresh exact process binding cannot authorize publication');
  await publishCommittedIdentity(f.context, 'p');
  assert.equal(f.reads(), 0);
  assert.deepEqual(f.writes, []);
  assert.equal(f.transactions(), 0);
  assert.deepEqual(f.rows(), before, 'preexisting contamination is neither refreshed nor repaired implicitly');
});

test('sessionless standalone operations remain admitted without host presence or wake routes', async (t) => {
  const f = fixture(t);
  assert.equal(await assertLiveOwner(f.context, 'p'), true);
  assert.equal(await ensureLocalPresence(f.context, 'p'), undefined);
  await publishCommittedIdentity(f.context, 'p');
  assert.equal(await identityRouteDraft(f.context, 'p'), undefined);
  assert.equal(f.reads(), 0, 'sessionless operations do not consult or borrow host ownership');
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.rows(), []);
  assert.deepEqual(f.routes, []);
  assert.equal(f.transactions(), 0);
});

test('native owner refresh retains its observed epoch', async (t) => {
  const f = fixture(t, [{ session: 'native-owner', channel: 'pi', epoch: 7, updatedAt: 1 }]);
  const native = { ...f.context, env: { PI_SESSION_ID: 'native-owner' } };
  assert.deepEqual(await ensureLocalPresence(native, 'p'), { epoch: 7 });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].session, 'native-owner');
  assert.equal(f.writes[0].channel, 'pi');
  assert.equal(f.writes[0].epoch, 7);
  assert.equal(f.writes[0].updatedAt, f.now);
  assert.equal(await assertLiveOwner(native, 'p', 7), true);
});

test('fenced native takeover can publish its explicit epoch while the old owner is visible', async (t) => {
  const f = fixture(t, [{ session: 'old-owner', channel: 'pi', epoch: 7, updatedAt: 1 }]);
  const replacement = { ...f.context, env: { PI_SESSION_ID: 'replacement' } };
  assert.deepEqual(await ensureLocalPresence(replacement, 'p', 8), { epoch: 8 });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].session, 'replacement');
  assert.equal(f.writes[0].epoch, 8);
  assert.equal(await assertLiveOwner(replacement, 'p', 8), true);
});
