import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { loadSquare } from '../dist/artifact.js';
import {
  claimSessionParticipant,
  claimSessionTakeover,
  hasAutomaticDeliveryIdentity,
  localSessionIdentities,
  readParticipantOwner,
  squareAssignedParticipantName,
} from '../dist/registry.js';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { canonicalPath } from '../dist/canonical-path.js';
import { sessionIdsFromEnvironment } from '../dist/participant-identity.js';
import { writeSquareFile, createSquareState } from '../dist/artifact.js';
import { done, join, takeover } from '../dist/square-actions.js';
import { Square } from '../dist/square-wiring.js';
import { openSquare } from '../dist/square-file-adapter.js';
import { closeOpenSquare } from '../dist/open-square.js';
import { streamProjection, streamTailProjection } from '../dist/views.js';
import { createMemoryCell } from '../dist/square-storage.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist', 'square.js');

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input: options.input,
    env: { ...process.env, SQUARE_DISABLE_PASEO_WAKE: '1', ...(options.env ?? {}) },
  });
}

function withRegistry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-registry-'));
  const previousRegistry = process.env.SQUARE_REGISTRY;
  const previousRoutes = process.env.SQUARE_ROUTES;
  process.env.SQUARE_REGISTRY = path.join(root, 'sessions.ndjsonl');
  process.env.SQUARE_ROUTES = path.join(root, 'routes.ndjsonl');
  return () => {
    if (previousRegistry === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previousRegistry;
    if (previousRoutes === undefined) delete process.env.SQUARE_ROUTES;
    else process.env.SQUARE_ROUTES = previousRoutes;
    fs.rmSync(root, { recursive: true, force: true });
  };
}

test('participant name claims are exclusive across concurrent sessions', async () => {
  const cleanup = withRegistry();
  try {
    const squarePath = path.join(os.tmpdir(), 'exclusive-claim.square');
    const base = {
      SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      OPENCODE_SESSION_ID: '',
      PI_SESSION_ID: '',
      PASEO_AGENT_ID: '',
    };
    const [first, second] = await Promise.allSettled([
      claimSessionParticipant(squarePath, 'Alice', createHostLedgerPort(), { ...base, CODEX_THREAD_ID: 'session-a' }),
      claimSessionParticipant(squarePath, 'alice', createHostLedgerPort(), { ...base, CODEX_THREAD_ID: 'session-b' }),
    ]);
    const acquired = [first, second].filter((result) => result.status === 'fulfilled');
    const refused = [first, second].filter((result) => result.status === 'rejected');
    assert.equal(acquired.length, 1);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason?.code, 'already_joined');
    assert.equal((await createHostLedgerPort().listPresence({ location: squarePath, participant: 'ALICE' })).length, 1);
    assert.equal((await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()))?.epoch, 1);
  } finally {
    cleanup();
  }
});

test('concurrent kick losers claim no ownership and mutate no artifact lifecycle', async () => {
  const cleanup = withRegistry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-kick-loser-'));
  try {
    const squarePath = path.join(root, 'SQUARE.square');
    await writeSquareFile(squarePath, await createSquareState({ force: true, hardCap: null }, 'kick'));
    const base = {
      SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      OPENCODE_SESSION_ID: '',
      PI_SESSION_ID: '',
      PASEO_AGENT_ID: '',
    };
    const originalEnv = { ...base, CODEX_THREAD_ID: 'owner-0' };
    const original = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: originalEnv });
    try {
      await join(original, 'Alice');
    } finally {
      await closeOpenSquare(original);
    }

    const beforeEpoch = (await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()))?.epoch ?? 0;
    const kick = (sessionId) => async () => {
      const env = { ...base, CODEX_THREAD_ID: sessionId };
      const square = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env });
      try { return await takeover(square, 'Alice'); }
      finally { await closeOpenSquare(square); }
    };
    // Hold the claim lock until both kick attempts have read the same owner and queued on the
    // claim, so the race is between two stale observations and exactly one CAS can win.
    const { withFileLock } = await import('../dist/file-lock.js');
    const claimLockPath = path.join(path.dirname(process.env.SQUARE_REGISTRY), 'presence-claim.lock');
    let attempts;
    await withFileLock(claimLockPath, { retryMs: 10 }, async () => {
      attempts = Promise.allSettled([kick('kicker-a')(), kick('kicker-b')()]);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const [left, right] = await attempts;

    const won = [left, right].filter((result) => result.status === 'fulfilled');
    const lost = [left, right].filter((result) => result.status === 'rejected');
    assert.equal(won.length, 1, `expected one winner, got ${JSON.stringify([left, right])}`);
    assert.equal(lost.length, 1);
    assert.equal(lost[0].reason?.code, 'already_joined');
    assert.equal((await createHostLedgerPort().listPresence({ location: squarePath, participant: 'Alice' })).length, 1);
    assert.deepEqual((await loadSquare(squarePath)).acts.map((act) => act.kind), ['join', 'done', 'join']);
    assert.equal((await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()))?.epoch, beforeEpoch + 1);
    // The losing kicker claims nothing and never disturbs the winner's rows.
    const winner = (await createHostLedgerPort().listPresence({ location: squarePath, participant: 'Alice' }))[0];
    assert.equal(winner.session === 'kicker-a' || winner.session === 'kicker-b', true);
    assert.deepEqual(await createHostLedgerPort().listPresence({ session: winner.session === 'kicker-a' ? 'kicker-b' : 'kicker-a' }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('a refused takeover lifecycle withdraws only its provisional claim token', async () => {
  const cleanup = withRegistry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-kick-rollback-'));
  try {
    const squarePath = path.join(root, 'SQUARE.square');
    await writeSquareFile(squarePath, await createSquareState({ force: true, hardCap: null }, 'rollback'));
    const base = {
      SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      OPENCODE_SESSION_ID: '',
      PI_SESSION_ID: '',
      PASEO_AGENT_ID: '',
    };
    const owner = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: { ...base, CODEX_THREAD_ID: 'owner-0' } });
    try {
      await join(owner, 'Alice');
    } finally {
      await closeOpenSquare(owner);
    }

    // A takeover whose lifecycle refuses after the provisional claim must withdraw exactly its
    // own claim token: the standing owner row survives and the failed session binds nothing.
    await assert.rejects(
      () => claimSessionTakeover(
        squarePath,
        'Alice',
        createHostLedgerPort(),
        { ...base, CODEX_THREAD_ID: 'kicker-x' },
        { expectedEpoch: 1, expectedSession: 'owner-0' },
        async () => { throw new Error('lifecycle refused'); },
      ),
      /lifecycle refused/,
    );
    assert.equal((await createHostLedgerPort().listPresence({ location: squarePath, participant: 'Alice' })).length, 1);
    assert.equal((await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()))?.session, 'owner-0');
    assert.equal((await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()))?.epoch, 1);
    assert.deepEqual(await createHostLedgerPort().listPresence({ session: 'kicker-x' }), []);
    assert.deepEqual((await loadSquare(squarePath)).acts.map((act) => act.kind), ['join']);

    // The refused session binds nothing and may retry cleanly over the untouched standing rows.
    const kicker = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: { ...base, CODEX_THREAD_ID: 'kicker-x' } });
    try {
      await takeover(kicker, 'Alice');
    } finally {
      await closeOpenSquare(kicker);
    }
    assert.equal((await createHostLedgerPort().listPresence({ location: squarePath, participant: 'Alice' })).length, 1);
    assert.equal((await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()))?.session, 'kicker-x');
    assert.equal((await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()))?.epoch, 2);
    assert.deepEqual((await loadSquare(squarePath)).acts.map((act) => act.kind), ['join', 'done', 'join']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('a stale takeover observation cannot append a lifecycle after a newer takeover won', async () => {
  const cleanup = withRegistry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-kick-stale-'));
  try {
    const squarePath = path.join(root, 'SQUARE.square');
    await writeSquareFile(squarePath, await createSquareState({ force: true, hardCap: null }, 'stale'));
    const base = {
      SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      OPENCODE_SESSION_ID: '',
      PI_SESSION_ID: '',
      PASEO_AGENT_ID: '',
    };
    const owner = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: { ...base, CODEX_THREAD_ID: 'owner-0' } });
    try {
      await join(owner, 'Alice');
    } finally {
      await closeOpenSquare(owner);
    }

    // An old takeover observed owner-0@epoch 1 before queueing behind the claim lock.
    const staleObservation = { expectedEpoch: 1, expectedSession: 'owner-0' };

    // The newer takeover wins first and completes its full lifecycle.
    const newer = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: { ...base, CODEX_THREAD_ID: 'kicker-a' } });
    try {
      await takeover(newer, 'Alice');
    } finally {
      await closeOpenSquare(newer);
    }
    assert.deepEqual((await loadSquare(squarePath)).acts.map((act) => act.kind), ['join', 'done', 'join']);

    // The old takeover's claim now runs its CAS against the current owner and loses without
    // appending done/join or touching the winner's rows.
    const stale = await claimSessionTakeover(
      squarePath,
      'Alice',
      createHostLedgerPort(),
      { ...base, CODEX_THREAD_ID: 'kicker-old' },
      staleObservation,
      async () => { throw new Error('stale lifecycle must never run'); },
    );
    assert.equal(stale.status, 'busy');
    assert.equal(stale.status === 'busy' ? stale.epoch : undefined, 2);
    assert.deepEqual(await createHostLedgerPort().listPresence({ session: 'kicker-old' }), []);
    assert.equal((await createHostLedgerPort().listPresence({ location: squarePath, participant: 'Alice' })).length, 1);
    assert.equal((await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()))?.session, 'kicker-a');
    assert.equal((await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()))?.epoch, 2);
    assert.deepEqual((await loadSquare(squarePath)).acts.map((act) => act.kind), ['join', 'done', 'join']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('self-takeover success leaves exactly one current owner', async () => {
  const cleanup = withRegistry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-self-kick-'));
  try {
    const squarePath = path.join(root, 'SQUARE.square');
    await writeSquareFile(squarePath, await createSquareState({ force: true, hardCap: null }, 'self'));
    const base = {
      SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      OPENCODE_SESSION_ID: '',
      PI_SESSION_ID: '',
      PASEO_AGENT_ID: '',
    };
    const ownerEnv = { ...base, CODEX_THREAD_ID: 'owner-s' };
    const owner = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: ownerEnv });
    try {
      await join(owner, 'Alice');
    } finally {
      await closeOpenSquare(owner);
    }
    assert.equal((await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()))?.epoch, 1);

    // The standing owner kicks its own participant; finalize must replace, not delete, its row.
    const self = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: ownerEnv });
    try {
      await takeover(self, 'Alice');
    } finally {
      await closeOpenSquare(self);
    }
    assert.deepEqual((await loadSquare(squarePath)).acts.map((act) => act.kind), ['join', 'done', 'join']);
    const rows = await createHostLedgerPort().listPresence({ location: squarePath, participant: 'Alice' });
    assert.equal(rows.length, 1, `expected exactly one owner row, got ${JSON.stringify(rows)}`);
    assert.equal(rows[0].session, 'owner-s');
    const ownerAfter = await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort());
    assert.equal(ownerAfter?.session, 'owner-s');
    assert.equal(ownerAfter?.epoch, 2);
    assert.equal((await createHostLedgerPort().listPresence({ session: 'owner-s', participant: 'Alice' })).length, 1);

    // Exactly one live owner remains: a foreign session cannot wrongly claim the name.
    const foreign = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: { ...base, CODEX_THREAD_ID: 'foreign' } });
    try {
      await assert.rejects(() => join(foreign, 'Alice'), (error) => error?.code === 'already_joined');
    } finally {
      await closeOpenSquare(foreign);
    }
    assert.deepEqual((await loadSquare(squarePath)).acts.map((act) => act.kind), ['join', 'done', 'join']);
    assert.deepEqual(await createHostLedgerPort().listPresence({ session: 'foreign' }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('self-takeover lifecycle refusal preserves the old owner and foreign joins stay refused', async () => {
  const cleanup = withRegistry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-self-kick-refusal-'));
  try {
    const squarePath = path.join(root, 'SQUARE.square');
    await writeSquareFile(squarePath, await createSquareState({ force: true, hardCap: null }, 'self'));
    const base = {
      SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      OPENCODE_SESSION_ID: '',
      PI_SESSION_ID: '',
      PASEO_AGENT_ID: '',
    };
    const ownerEnv = { ...base, CODEX_THREAD_ID: 'owner-s' };
    const owner = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: ownerEnv });
    try {
      await join(owner, 'Alice');
    } finally {
      await closeOpenSquare(owner);
    }

    // The self-takeover claim succeeds but its lifecycle refuses after the claim.
    await assert.rejects(
      () => claimSessionTakeover(
        squarePath,
        'Alice',
        createHostLedgerPort(),
        ownerEnv,
        { expectedEpoch: 1, expectedSession: 'owner-s' },
        async () => { throw new Error('self lifecycle refused'); },
      ),
      /self lifecycle refused/,
    );
    const rows = await createHostLedgerPort().listPresence({ location: squarePath, participant: 'Alice' });
    assert.equal(rows.length, 1, `expected exactly one owner row, got ${JSON.stringify(rows)}`);
    assert.equal(rows[0].session, 'owner-s');
    const ownerAfter = await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort());
    assert.equal(ownerAfter?.session, 'owner-s');
    assert.equal(ownerAfter?.epoch, 1);
    assert.deepEqual((await loadSquare(squarePath)).acts.map((act) => act.kind), ['join']);

    // The restored old owner still fences the name: a foreign join stays refused.
    const foreign = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: { ...base, CODEX_THREAD_ID: 'foreign' } });
    try {
      await assert.rejects(() => join(foreign, 'Alice'), (error) => error?.code === 'already_joined');
    } finally {
      await closeOpenSquare(foreign);
    }
    assert.deepEqual((await loadSquare(squarePath)).acts.map((act) => act.kind), ['join']);
    assert.deepEqual(await createHostLedgerPort().listPresence({ session: 'foreign' }), []);
    assert.equal((await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()))?.session, 'owner-s');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('a stale done paused across a completed takeover refuses and appends nothing', async () => {
  const cleanup = withRegistry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-done-fence-'));
  try {
    const squarePath = path.join(root, 'SQUARE.square');
    await writeSquareFile(squarePath, await createSquareState({ force: true, hardCap: null }, 'fence'));
    const base = {
      SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      OPENCODE_SESSION_ID: '',
      PI_SESSION_ID: '',
      PASEO_AGENT_ID: '',
    };
    const ownerEnv = { ...base, CODEX_THREAD_ID: 'owner-a' };
    const owner = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: ownerEnv });
    try {
      await join(owner, 'Alice');
    } finally {
      await closeOpenSquare(owner);
    }
    assert.equal((await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()))?.epoch, 1);
    // The old shutdown captured its owner epoch before the pause, exactly like automaticSessionEnd.
    const expectedEpoch = (await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()))?.epoch;

    // While the old done is paused, the epoch-2 takeover completes its full lifecycle.
    const kickerSquare = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: { ...base, CODEX_THREAD_ID: 'kicker-b' } });
    try {
      await takeover(kickerSquare, 'Alice');
    } finally {
      await closeOpenSquare(kickerSquare);
    }
    assert.deepEqual((await loadSquare(squarePath)).acts.map((act) => act.kind), ['join', 'done', 'join']);

    // The resumed stale done validates at commit time under the ownership lock: the owner is now
    // epoch 2, so the old epoch refuses instead of appending a second done.
    const oldSquare = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: ownerEnv });
    try {
      await assert.rejects(
        () => done(oldSquare, 'Alice', '', { expectedEpoch }),
        (error) => error?.code === 'already_done',
      );
    } finally {
      await closeOpenSquare(oldSquare);
    }
    assert.deepEqual((await loadSquare(squarePath)).acts.map((act) => act.kind), ['join', 'done', 'join']);
    assert.equal((await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()))?.session, 'kicker-b');
    assert.equal((await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()))?.epoch, 2);
    assert.deepEqual(await createHostLedgerPort().listPresence({ session: 'owner-a' }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('a takeover cannot append when the old owner completed first', async () => {
  const cleanup = withRegistry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-kick-after-done-'));
  try {
    const squarePath = path.join(root, 'SQUARE.square');
    await writeSquareFile(squarePath, await createSquareState({ force: true, hardCap: null }, 'fence'));
    const base = {
      SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      OPENCODE_SESSION_ID: '',
      PI_SESSION_ID: '',
      PASEO_AGENT_ID: '',
    };
    const ownerEnv = { ...base, CODEX_THREAD_ID: 'owner-a' };
    const owner = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: ownerEnv });
    try {
      await join(owner, 'Alice');
    } finally {
      await closeOpenSquare(owner);
    }

    // The owner completes before the kick arrives: the takeover gate mirrors the transaction and
    // refuses, so the artifact keeps the single lifecycle and no ghost claim appears.
    const oldSquare = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: ownerEnv });
    try {
      await done(oldSquare, 'Alice');
    } finally {
      await closeOpenSquare(oldSquare);
    }
    assert.deepEqual((await loadSquare(squarePath)).acts.map((act) => act.kind), ['join', 'done']);

    const kickerSquare = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: { ...base, CODEX_THREAD_ID: 'kicker-b' } });
    try {
      await assert.rejects(() => takeover(kickerSquare, 'Alice'), (error) => error?.code === 'already_done');
    } finally {
      await closeOpenSquare(kickerSquare);
    }
    assert.deepEqual((await loadSquare(squarePath)).acts.map((act) => act.kind), ['join', 'done']);
    assert.equal(await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()), undefined);
    assert.deepEqual(await createHostLedgerPort().listPresence({ session: 'kicker-b' }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('invalid join name validates before any ownership claim', async () => {
  const cleanup = withRegistry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-invalid-join-'));
  try {
    const squarePath = path.join(root, 'SQUARE.square');
    await writeSquareFile(squarePath, await createSquareState({ force: true, hardCap: null }, 'invalid'));
    const env = {
      SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: 'invalid-joiner',
      OPENCODE_SESSION_ID: '',
      PI_SESSION_ID: '',
      PASEO_AGENT_ID: '',
    };
    const square = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env });
    try {
      await assert.rejects(() => join(square, 'bad/name/'), (error) => error?.code === 'invalid_name');
    } finally {
      await closeOpenSquare(square);
    }
    assert.deepEqual((await loadSquare(squarePath)).acts, []);
    assert.deepEqual(await createHostLedgerPort().listPresence({ location: squarePath, participant: 'bad/name/' }), []);
    assert.deepEqual(await createHostLedgerPort().listPresence({ session: 'invalid-joiner' }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('invalid takeover name performs no ownership mutation', async () => {
  const cleanup = withRegistry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-invalid-kick-'));
  try {
    const squarePath = path.join(root, 'SQUARE.square');
    await writeSquareFile(squarePath, await createSquareState({ force: true, hardCap: null }, 'invalid'));
    const base = {
      SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      OPENCODE_SESSION_ID: '',
      PI_SESSION_ID: '',
      PASEO_AGENT_ID: '',
    };
    const original = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: { ...base, CODEX_THREAD_ID: 'owner-0' } });
    try {
      await join(original, 'Alice');
    } finally {
      await closeOpenSquare(original);
    }
    const kicker = await openSquare(squarePath, { hostLedger: createHostLedgerPort(), env: { ...base, CODEX_THREAD_ID: 'kicker-x' } });
    try {
      await assert.rejects(() => takeover(kicker, 'bad/name/'), (error) => error?.code === 'invalid_name');
    } finally {
      await closeOpenSquare(kicker);
    }
    assert.deepEqual(await createHostLedgerPort().listPresence({ location: squarePath, participant: 'bad/name/' }), []);
    assert.deepEqual(await createHostLedgerPort().listPresence({ session: 'kicker-x' }), []);
    assert.equal((await createHostLedgerPort().listPresence({ location: squarePath, participant: 'Alice' })).length, 1);
    assert.equal((await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()))?.session, 'owner-0');
    assert.deepEqual((await loadSquare(squarePath)).acts.map((act) => act.kind), ['join']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('takeover of a never-joined participant refuses before any ownership claim', async () => {
  const cleanup = withRegistry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-kick-unknown-'));
  try {
    const squarePath = path.join(root, 'SQUARE.square');
    await writeSquareFile(squarePath, await createSquareState({ force: true, hardCap: null }, 'unknown'));
    const base = {
      SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      OPENCODE_SESSION_ID: '',
      PI_SESSION_ID: '',
      PASEO_AGENT_ID: '',
    };
    const kicker = await Square.at({ path: squarePath, hostLedger: createHostLedgerPort(), env: { ...base, CODEX_THREAD_ID: 'kicker-x' } });
    try {
      await assert.rejects(() => kicker.takeover('Alice'), (error) => error?.code === 'invalid_args');
    } finally {
      await kicker.close();
    }
    assert.deepEqual((await loadSquare(squarePath)).acts, []);
    assert.deepEqual(await createHostLedgerPort().listPresence({ location: squarePath, participant: 'Alice' }), []);
    assert.deepEqual(await createHostLedgerPort().listPresence({ session: 'kicker-x' }), []);

    // The refused takeover must leave the name claimable by a later explicit join.
    const owner = await Square.at({ path: squarePath, hostLedger: createHostLedgerPort(), env: { ...base, CODEX_THREAD_ID: 'owner-y' } });
    try {
      await owner.join('Alice');
    } finally {
      await owner.close();
    }
    assert.deepEqual((await loadSquare(squarePath)).acts.map((act) => act.kind), ['join']);
    assert.equal((await readParticipantOwner(squarePath, 'Alice', createHostLedgerPort()))?.session, 'owner-y');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('presence folds lifecycle by session, square, and participant name', async () => {
  const cleanup = withRegistry();
  try {
    const squarePath = path.join(os.tmpdir(), 'triple-key-square.square');
    const now = Date.now();
    const ledger = createHostLedgerPort();
    await ledger.ensurePresence({ location: squarePath, participant: 'Alice', session: 'session-1', channel: 'claude-code', updatedAt: now - 3 });
    await ledger.ensurePresence({ location: squarePath, participant: 'Bob', session: 'session-1', channel: 'claude-code', updatedAt: now - 2 });
    await ledger.removePresence({ location: squarePath, participant: 'Alice', session: 'session-1', channel: 'claude-code' });

    assert.deepEqual((await ledger.listPresence({ session: 'session-1', now })).map((row) => ({ name: row.participant, squarePath: row.location })), [
      { name: 'Bob', squarePath: await canonicalPath(squarePath) },
    ]);
    assert.deepEqual(await ledger.listPresence({ location: squarePath, participant: 'Alice', now }), []);

    await ledger.ensurePresence({ location: squarePath, participant: 'ALICE', session: 'session-1', channel: 'claude-code', updatedAt: now });
    const alice = await ledger.listPresence({ location: squarePath, participant: 'alice', now });
    assert.equal(alice.length, 1);
    assert.equal(alice[0].participant, 'ALICE');
    assert.equal(alice[0].channel, 'claude-code');
    assert.deepEqual(
      (await ledger.listPresence({ session: 'session-1', now })).map((entry) => entry.participant).sort(),
      ['ALICE', 'Bob']
    );
  } finally {
    cleanup();
  }
});

test('presence follows active session lifecycle without delivery routes', async () => {
  const cleanup = withRegistry();
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-registry-cli-'));
    const squarePath = path.join(root, 'SQUARE.square');
    const env = {
      SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
      CLAUDE_CODE_SESSION_ID: 'resume-session',
      CLAUDE_CODE_CHILD_SESSION: '',
      CODEX_THREAD_ID: '',
      OPENCODE_SESSION_ID: '',
      PI_SESSION_ID: '',
      PASEO_AGENT_ID: 'resume-paseo-agent',
    };
    const built = runCli(['--location', squarePath, 'build', '--cap', 'unlimited'], {
      input: '## Topic\n\nRegistry refresh\n',
      env,
    });
    assert.equal(built.status, 0, built.stderr);
    assert.equal(runCli(['--location', squarePath, '--as', 'Alice', 'join'], { env }).status, 0);
    assert.equal((await loadSquare(squarePath)).acts.filter((act) => act.kind === 'join').length, 1);

    const reconnected = runCli(['--location', squarePath, '--as', 'alice', 'join'], { env });
    assert.equal(reconnected.status, 0, reconnected.stderr);
    assert.match(reconnected.stdout, /already in the square/);
    assert.deepEqual((await createHostLedgerPort().listPresence({ session: 'resume-session' })).map((entry) => entry.participant), ['Alice']);
    assert.equal((await loadSquare(squarePath)).acts.filter((act) => act.kind === 'join').length, 1);

    const observerEnv = {
      SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
      CLAUDE_CODE_SESSION_ID: '',
      CLAUDE_CODE_CHILD_SESSION: '',
      CODEX_THREAD_ID: 'observer-session',
      OPENCODE_SESSION_ID: '',
      PI_SESSION_ID: '',
      PASEO_AGENT_ID: '',
    };
    const status = runCli(['--location', squarePath, '--as', 'alice', 'status'], { env: observerEnv });
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(await createHostLedgerPort().listPresence({ session: 'observer-session' }), []);
    assert.deepEqual((await createHostLedgerPort().listPresence({ session: 'resume-session' })).map((entry) => entry.participant), ['Alice']);

    const catchNow = runCli(['--location', squarePath, '--as', 'Alice', 'catch', '--now'], { env });
    assert.equal(catchNow.status, 0, catchNow.stderr);
    assert.deepEqual((await createHostLedgerPort().listPresence({ session: 'resume-session' })).map((entry) => entry.participant), ['Alice']);

    const expressed = runCli(['--location', squarePath, '--as', 'alice', 'express', '--no-mention', 'still not an owner @alice'], {
      env: observerEnv,
    });
    assert.notEqual(expressed.status, 0);
    assert.match(expressed.stderr, /already stands here — another session holds the name/);
    assert.deepEqual(await createHostLedgerPort().listPresence({ session: 'observer-session' }), []);
    assert.deepEqual((await createHostLedgerPort().listPresence({ session: 'resume-session' })).map((entry) => entry.participant), ['Alice']);

    const repeated = runCli(['--location', squarePath, '--as', 'alice', 'join'], { env: observerEnv });
    assert.notEqual(repeated.status, 0);
    assert.deepEqual(await createHostLedgerPort().listPresence({ session: 'observer-session' }), []);
    assert.deepEqual((await createHostLedgerPort().listPresence({ session: 'resume-session' })).map((entry) => entry.participant), ['Alice']);

    const foreignDone = runCli(['--location', squarePath, '--as', 'Alice', 'done'], { env: observerEnv });
    assert.notEqual(foreignDone.status, 0);
    assert.match(foreignDone.stderr, /already stands here — another session holds the name/);
    assert.deepEqual(await createHostLedgerPort().listPresence({ session: 'observer-session' }), []);
    assert.deepEqual((await createHostLedgerPort().listPresence({ session: 'resume-session' })).map((entry) => entry.participant), ['Alice']);
    assert.equal((await loadSquare(squarePath)).acts.filter((act) => act.kind === 'done').length, 0);

    const done = runCli(['--location', squarePath, '--as', 'Alice', 'done'], { env });
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(await createHostLedgerPort().listPresence({ session: 'observer-session' }), []);
    assert.deepEqual(await createHostLedgerPort().listPresence({ session: 'resume-session' }), []);
    assert.deepEqual((await loadSquare(squarePath)).acts.map((act) => act.kind), ['join', 'done']);
    fs.rmSync(root, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});

test('presence reads ignore stale and malformed ledger rows', async () => {
  const cleanup = withRegistry();
  try {
    const squarePath = path.join(os.tmpdir(), 'stale-square.square');
    const now = Date.now();
    const ledger = createHostLedgerPort();
    await ledger.ensurePresence({ location: squarePath, participant: 'Alice', session: 'stale-session', channel: 'unknown', updatedAt: now - 8 * 24 * 60 * 60 * 1000 });
    fs.appendFileSync(path.join(path.dirname(process.env.SQUARE_REGISTRY), 'presence.ndjsonl'), '{bad json}\n');
    assert.deepEqual(await ledger.listPresence({ session: 'stale-session', now }), []);
  } finally {
    cleanup();
  }
});

test('local session discovery never guesses participant identity', async () => {
  assert.deepEqual(
    localSessionIdentities({
      CLAUDE_CODE_SESSION_ID: 'claude-session',
      PASEO_AGENT_ID: 'paseo-agent',
      CLAUDE_CODE_AGENT: 'must-not-be-used',
    }),
    [
      {
        sessionId: 'claude-session',
        channel: 'claude-code',
        child: false,
        paseoAgentId: 'paseo-agent',
      },
      {
        sessionId: 'paseo-agent',
        channel: 'paseo',
        child: false,
        paseoAgentId: 'paseo-agent',
      },
    ]
  );
});

test('Square-assigned participant name is computed from current harness identity, not registry history', async () => {
  const cleanup = withRegistry();
  try {
    const env = { SQUARE_REGISTRY: process.env.SQUARE_REGISTRY, CODEX_THREAD_ID: 'current-session' };
    assert.equal(squareAssignedParticipantName(env), 'codex-0392bc3a1701');
    await createHostLedgerPort().ensurePresence({ location: path.join(os.tmpdir(), 'public.square'), participant: 'Alice', session: 'current-session', channel: 'codex' });
    assert.equal(squareAssignedParticipantName(env), 'codex-0392bc3a1701');
    assert.equal(squareAssignedParticipantName({ SQUARE_PARTICIPANT_NAME: 'Alice' }), 'Alice');
    assert.equal(squareAssignedParticipantName({ CODEX_THREAD_ID: 'one', OPENCODE_SESSION_ID: 'two' }), undefined);
  } finally {
    cleanup();
  }
});

test('equal native session ids in different providers stay ambiguous and are never deduped', () => {
  const env = { CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: 'shared-id', OPENCODE_SESSION_ID: 'shared-id', PI_SESSION_ID: ' ' };
  assert.deepEqual(sessionIdsFromEnvironment(env), ['shared-id', 'shared-id']);
  assert.equal(squareAssignedParticipantName(env), undefined);
});

test('local session discovery recognizes native Codex, OpenCode, and Pi session ids', async () => {
  assert.deepEqual(
    localSessionIdentities({
      CODEX_THREAD_ID: 'codex-thread',
      OPENCODE_SESSION_ID: 'opencode-session',
      PI_SESSION_ID: 'pi-session',
    }),
    [
      { sessionId: 'codex-thread', channel: 'codex', child: false },
      { sessionId: 'opencode-session', channel: 'opencode', child: false },
      { sessionId: 'pi-session', channel: 'pi', child: false },
    ]
  );
});

test('automatic delivery capability follows native and Paseo session identities', async () => {
  assert.equal(hasAutomaticDeliveryIdentity({}), false);
  assert.equal(hasAutomaticDeliveryIdentity({ CODEX_THREAD_ID: 'codex-thread' }), true);
  assert.equal(hasAutomaticDeliveryIdentity({ CLAUDE_CODE_SESSION_ID: 'claude-session' }), true);
  assert.equal(hasAutomaticDeliveryIdentity({ OPENCODE_SESSION_ID: 'opencode-session' }), true);
  assert.equal(hasAutomaticDeliveryIdentity({ PI_SESSION_ID: 'pi-session' }), true);
  assert.equal(hasAutomaticDeliveryIdentity({ PASEO_AGENT_ID: 'paseo-agent' }), true);
});

function streamState(acts) {
  return {
    hardCap: null,
    preamble: [],
    warmup: [],
    acts,
    runtime: {
      nextActIndex: (acts.at(-1)?.index ?? -1) + 1,
      observations: {},
      leases: {},
      notifyLeases: {},
    },
  };
}

async function withStreamSquare(state, action) {
  const cell = createMemoryCell(state);
  try {
    return await action({ cell, clock: Date.now, location: 'memory' });
  } finally {
    await cell.close();
  }
}

test('stream tail defaults to ten eligible activities and keeps its 100-activity bound', async () => {
  const acts = Array.from({ length: 120 }, (_value, index) => ({ kind: 'say', actor: 'Alice', at: index, body: String(index), index }));
  await withStreamSquare(streamState(acts), async (square) => {
    const defaultTail = await streamTailProjection(square);
    const zeroTail = await streamTailProjection(square, 0);
    const hundredTail = await streamTailProjection(square, 100);

    assert.deepEqual(defaultTail.activities.map(({ activity }) => activity.index), Array.from({ length: 10 }, (_value, index) => index + 110));
    assert.deepEqual(zeroTail.activities, []);
    assert.equal(hundredTail.activities.length, 100);
    await assert.rejects(() => streamTailProjection(square, 101), (error) => error?.code === 'invalid_args');
    assert.equal(defaultTail.cursor, 119);
  });
});

test('stream resumes after its exclusive cursor and drains forward batches without loss or duplication', async () => {
  const acts = Array.from({ length: 205 }, (_value, index) => ({ kind: 'say', actor: 'Alice', at: index, body: String(index), index }));
  await withStreamSquare(streamState(acts), async (square) => {
    const after = await streamProjection(square, 99);
    assert.deepEqual(after.activities.map(({ activity }) => activity.index), Array.from({ length: 100 }, (_value, index) => index + 100));
    assert.equal(after.cursor, 199);
    assert.equal(after.hasMore, true);

    let cursor = -1;
    const received = [];
    do {
      const batch = await streamProjection(square, cursor);
      received.push(...batch.activities.map(({ activity }) => activity.index));
      cursor = batch.cursor;
      if (!batch.hasMore) break;
    } while (true);

    assert.deepEqual(received, acts.map((activity) => activity.index));
    assert.equal(cursor, 204);
  });
});

test('stream advances through recipient-filter gaps while preserving addressed activity order', async () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 0, body: '', index: 0 },
    { kind: 'join', actor: 'Bob', at: 1, body: '', index: 1 },
    ...Array.from({ length: 203 }, (_value, offset) => {
      const index = offset + 2;
      return {
        kind: 'say',
        actor: 'Alice',
        at: index,
        body: String(index),
        ...(index === 102 || index === 203 ? { mentions: ['Bob'] } : {}),
        index,
      };
    }),
  ];
  await withStreamSquare(streamState(acts), async (square) => {
    let cursor = -1;
    const received = [];
    do {
      const batch = await streamProjection(square, cursor, 'Bob');
      received.push(...batch.activities.map(({ activity }) => activity.index));
      cursor = batch.cursor;
      if (!batch.hasMore) break;
    } while (true);

    assert.deepEqual(received, [102, 203]);
    assert.equal(cursor, 204);
  });
});
