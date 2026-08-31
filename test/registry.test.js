import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { decodeSquare, loadSquare } from '../dist/artifact.js';
import {
  canonicalSquarePath,
  bindCurrentParticipant,
  squareAssignedParticipantName,
  unbindCurrentParticipant,
  hasAutomaticDeliveryIdentity,
  localSessionIdentities,
  lookupParticipant,
  lookupSession,
  pruneRegistry,
  recordDone,
  recordJoin,
  recordLocalDone,
  recordLocalJoin,
  recordSessionDone,
} from '../dist/registry.js';
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

test('registry folds lifecycle by session, square, and participant name', async () => {
  const cleanup = withRegistry();
  try {
    const squarePath = path.join(os.tmpdir(), 'triple-key-square.square');
    const now = Date.now();
    await recordJoin('session-1', 'Alice', squarePath, {
      channel: 'claude-code',
      paseoAgentId: 'paseo-alice',
      at: now - 3,
    });
    await recordJoin('session-1', 'Bob', squarePath, { channel: 'claude-code', at: now - 2 });
    await recordDone('session-1', 'Alice', squarePath, { channel: 'claude-code', at: now - 1 });

    assert.deepEqual(await lookupSession('session-1', now), [
      { name: 'Bob', squarePath: await canonicalSquarePath(squarePath) },
    ]);
    assert.deepEqual(await lookupParticipant(squarePath, 'Alice', now), []);

    await recordJoin('session-1', 'ALICE', squarePath, {
      channel: 'claude-code',
      paseoAgentId: 'paseo-alice',
      at: now,
    });
    const alice = await lookupParticipant(squarePath, 'alice', now);
    assert.equal(alice.length, 1);
    assert.equal(alice[0].name, 'ALICE');
    assert.equal(alice[0].channel, 'claude-code');
    assert.deepEqual(
      (await lookupSession('session-1', now)).map((entry) => entry.name).sort(),
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
      SQUARE_PI_SESSION_ID: '',
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
    assert.deepEqual((await lookupSession('resume-session')).map((entry) => entry.name), ['Alice']);
    assert.equal((await loadSquare(squarePath)).acts.filter((act) => act.kind === 'join').length, 1);

    const observerEnv = {
      SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
      CLAUDE_CODE_SESSION_ID: '',
      CLAUDE_CODE_CHILD_SESSION: '',
      CODEX_THREAD_ID: 'observer-session',
      OPENCODE_SESSION_ID: '',
      SQUARE_PI_SESSION_ID: '',
      PASEO_AGENT_ID: '',
    };
    const status = runCli(['--location', squarePath, '--as', 'alice', 'status'], { env: observerEnv });
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(await lookupSession('observer-session'), []);
    assert.deepEqual((await lookupSession('resume-session')).map((entry) => entry.name), ['Alice']);

    const catchNow = runCli(['--location', squarePath, '--as', 'Alice', 'catch', '--now'], { env });
    assert.equal(catchNow.status, 0, catchNow.stderr);
    assert.deepEqual((await lookupSession('resume-session')).map((entry) => entry.name), ['Alice']);

    const expressed = runCli(['--location', squarePath, '--as', 'alice', 'express', '--no-mention', 'still not an owner @alice'], {
      env: observerEnv,
    });
    assert.equal(expressed.status, 0, expressed.stderr);
    assert.deepEqual((await lookupSession('observer-session')).map((entry) => entry.name), ['Alice']);
    assert.deepEqual((await lookupSession('resume-session')).map((entry) => entry.name), ['Alice']);

    const repeated = runCli(['--location', squarePath, '--as', 'alice', 'join'], { env: observerEnv });
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual((await lookupSession('resume-session')).map((entry) => entry.name), ['Alice']);
    assert.deepEqual((await lookupSession('observer-session')).map((entry) => entry.name), ['Alice']);

    const done = runCli(['--location', squarePath, '--as', 'Alice', 'done', 'finished'], {
      env: observerEnv,
    });
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(await lookupSession('observer-session'), []);
    fs.rmSync(root, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});

test('registry ignores stale and malformed cache rows', async () => {
  const cleanup = withRegistry();
  try {
    const squarePath = path.join(os.tmpdir(), 'stale-square.square');
    const now = Date.now();
    await recordJoin('stale-session', 'Alice', squarePath, { at: now - 8 * 24 * 60 * 60 * 1000 });
    fs.appendFileSync(process.env.SQUARE_REGISTRY, '{bad json}\n');
    assert.deepEqual(await lookupSession('stale-session', now), []);
  } finally {
    cleanup();
  }
});

test('registry pruning removes only bindings disproved by their square artifacts', async () => {
  const cleanup = withRegistry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-registry-prune-'));
  try {
    const squarePath = path.join(root, 'SQUARE.square');
    const brokenPath = path.join(root, 'broken.square');
    const missingPath = path.join(root, 'missing.square');
    const isolatedEnv = {
      SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      OPENCODE_SESSION_ID: '',
      SQUARE_PI_SESSION_ID: '',
      PASEO_AGENT_ID: '',
    };
    assert.equal(runCli(['--location', squarePath, 'build', '--cap', '3'], { input: 'prune\n', env: isolatedEnv }).status, 0);
    assert.equal(runCli(['--location', squarePath, '--as', 'Alice', 'join'], { env: isolatedEnv }).status, 0);
    fs.writeFileSync(brokenPath, 'not a square\n');

    await recordJoin('valid-session', 'Alice', squarePath);
    await recordJoin('not-joined-session', 'Cara', squarePath);
    await recordJoin('missing-session', 'Bob', missingPath);
    await recordJoin('uncertain-session', 'Dave', brokenPath);

    assert.deepEqual(await pruneRegistry((candidate) => {
      if (!fs.existsSync(candidate)) return [];
      try {
        return decodeSquare(fs.readFileSync(candidate)).acts;
      } catch {
        return undefined;
      }
    }), { removed: 2, kept: 3 });
    assert.equal((await lookupSession('valid-session')).length, 1);
    assert.equal((await lookupSession('uncertain-session')).length, 1);
    assert.deepEqual(await lookupSession('not-joined-session'), []);
    assert.deepEqual(await lookupSession('missing-session'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
    await recordJoin('current-session', 'Alice', path.join(os.tmpdir(), 'public.square'), { channel: 'codex' });
    assert.equal(squareAssignedParticipantName(env), 'codex-0392bc3a1701');
    assert.equal(squareAssignedParticipantName({ SQUARE_PARTICIPANT_NAME: 'Alice' }), 'Alice');
    assert.equal(squareAssignedParticipantName({ CODEX_THREAD_ID: 'one', OPENCODE_SESSION_ID: 'two' }), undefined);
  } finally {
    cleanup();
  }
});

test('current participant binding uses the Square-assigned name and is idempotent', async () => {
  const cleanup = withRegistry();
  try {
    const squarePath = path.join(os.tmpdir(), 'current-binding.square');
    const env = {
      SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
      SQUARE_ROUTES: process.env.SQUARE_ROUTES,
      CODEX_THREAD_ID: 'current-session',
    };
    const name = squareAssignedParticipantName(env);
    assert.equal(name, 'codex-0392bc3a1701');
    const first = await bindCurrentParticipant(squarePath, name, env);
    const second = await bindCurrentParticipant(squarePath, name, env);
    assert.equal(first.created, true);
    assert.deepEqual(second, { created: false, sessionId: first.sessionId });
    assert.equal(await unbindCurrentParticipant(squarePath, name, env), true);
    assert.deepEqual(await lookupParticipant(squarePath, name), []);
  } finally {
    cleanup();
  }
});

test('local session discovery recognizes native Codex, OpenCode, and Pi session ids', async () => {
  assert.deepEqual(
    localSessionIdentities({
      CODEX_THREAD_ID: 'codex-thread',
      OPENCODE_SESSION_ID: 'opencode-session',
      SQUARE_PI_SESSION_ID: 'pi-session',
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
  assert.equal(hasAutomaticDeliveryIdentity({ SQUARE_PI_SESSION_ID: 'pi-session' }), true);
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
