import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSquareState, writeSquareFile } from '../dist/artifact.js';
import { hostLedgerForEnv } from '../dist/registry.js';
import { Square } from '../dist/square-wiring.js';

function canon(value) {
  try { return fs.realpathSync.native(value); } catch { return path.resolve(value); }
}

/**
 * The injected in-memory host ledger: presence rows in a list, with one in-process
 * mutex standing in for the file ledger's presence-claim.lock. claimPresence takes
 * that mutex itself and is never nested inside withClaimLock.
 */
function memoryHostLedger() {
  const presence = [];
  let mutex = Promise.resolve();
  const serialize = (fn) => {
    const result = mutex.then(fn, fn);
    mutex = result.then(() => undefined, () => undefined);
    return result;
  };
  const sameKey = (row, key) => row.location === canon(key.location)
    && row.session === key.session && row.participant.toLowerCase() === key.participant.toLowerCase() && row.channel === key.channel;
  return {
    withClaimLock: (fn) => serialize(fn),
    claimPresence: (input) => serialize(async () => {
      const record = { ...input, location: canon(input.location), updatedAt: input.updatedAt ?? Date.now() };
      const owner = presence.findLast((row) => row.location === record.location && row.participant.toLowerCase() === record.participant.toLowerCase());
      if (owner !== undefined) return owner.session === record.session ? { status: 'owned', record: owner } : { status: 'busy', record: owner };
      presence.push(record);
      return { status: 'acquired', record };
    }),
    ensurePresence: async (input) => {
      const record = { ...input, location: canon(input.location), updatedAt: input.updatedAt ?? Date.now() };
      const index = presence.findIndex((row) => sameKey(row, record));
      if (index === -1) presence.push(record);
      else presence[index] = record;
      return { status: 'ensured', record };
    },
    listPresence: async (lookup = {}) => presence.filter((row) =>
      (lookup.location === undefined || row.location === canon(lookup.location))
      && (lookup.participant === undefined || row.participant.toLowerCase() === lookup.participant.toLowerCase())
      && (lookup.session === undefined || row.session === lookup.session)),
    removePresence: async (key) => {
      const index = presence.findIndex((row) => sameKey(row, key));
      if (index !== -1) presence.splice(index, 1);
    },
    removePresenceIfUnchanged: async (record) => {
      const index = presence.findIndex((row) => sameKey(row, record) && row.updatedAt === record.updatedAt && row.epoch === record.epoch);
      if (index === -1) return false;
      presence.splice(index, 1);
      return true;
    },
  };
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-injected-ledger-'));
  const location = path.join(root, 'SQUARE.square');
  await writeSquareFile(location, await createSquareState({ force: true, hardCap: null }, 'injected ledger'));
  const env = {
    SQUARE_HOST_LEDGER_ROOT: path.join(root, 'env-ledger'),
    SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'),
    CLAUDE_CODE_SESSION_ID: '',
    CODEX_THREAD_ID: '',
    OPENCODE_SESSION_ID: '',
    PI_SESSION_ID: '',
    PASEO_AGENT_ID: '',
  };
  const ledger = memoryHostLedger();
  const open = (sessionId) => Square.at({ path: location, hostLedger: ledger, env: { ...env, CODEX_THREAD_ID: sessionId } });
  return { root, location, env, ledger, open };
}

test('an injected in-memory ledger owns the claim, not the environment ledger', async () => {
  const f = await fixture();
  try {
    const square = await f.open('session-a');
    try {
      await square.join('Alice');
      assert.deepEqual((await f.ledger.listPresence({ location: f.location, participant: 'Alice' })).map((row) => [row.session, row.epoch]), [['session-a', 1]]);
      assert.deepEqual(await hostLedgerForEnv(f.env).listPresence({ location: f.location, participant: 'Alice' }), []);
      // The claim critical section runs on the injected ledger too.
      await square.takeover('Alice');
      assert.deepEqual((await f.ledger.listPresence({ location: f.location, participant: 'Alice' })).map((row) => [row.session, row.epoch]), [['session-a', 2]]);
      assert.deepEqual(await hostLedgerForEnv(f.env).listPresence({ location: f.location, participant: 'Alice' }), []);
    } finally { await square.close(); }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a concurrent second session is refused the name in the injected ledger', async () => {
  const f = await fixture();
  try {
    const joinAs = async (sessionId) => {
      const square = await f.open(sessionId);
      try { return await square.join('Alice'); }
      finally { await square.close(); }
    };
    const results = await Promise.allSettled([joinAs('session-a'), joinAs('session-b')]);
    const refused = results.filter((result) => result.status === 'rejected');
    assert.equal(refused.length, 1, `expected one refused join, got ${JSON.stringify(results.map((result) => result.status))}`);
    assert.equal(refused[0].reason?.code, 'already_joined');
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    assert.deepEqual((await f.ledger.listPresence({ location: f.location, participant: 'Alice' })).map((row) => row.session), [winner === 0 ? 'session-a' : 'session-b']);
    assert.deepEqual(await hostLedgerForEnv(f.env).listPresence({ location: f.location, participant: 'Alice' }), []);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
