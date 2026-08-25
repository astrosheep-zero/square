import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { loadSquare } from '../dist/artifact.js';
import {
  canonicalSquarePath,
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
import { readWakeRoutes } from '../dist/routes.js';
import { streamProjection } from '../dist/views.js';
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

test('registry folds lifecycle by session, square, and participant name', () => {
  const cleanup = withRegistry();
  try {
    const squarePath = path.join(os.tmpdir(), 'triple-key-square.square');
    const now = Date.now();
    recordJoin('session-1', 'Alice', squarePath, {
      channel: 'claude-code',
      paseoAgentId: 'paseo-alice',
      at: now - 3,
    });
    recordJoin('session-1', 'Bob', squarePath, { channel: 'claude-code', at: now - 2 });
    recordDone('session-1', 'Alice', squarePath, { channel: 'claude-code', at: now - 1 });

    assert.deepEqual(lookupSession('session-1', now), [
      { name: 'Bob', squarePath: canonicalSquarePath(squarePath) },
    ]);
    assert.deepEqual(lookupParticipant(squarePath, 'Alice', now), []);

    recordJoin('session-1', 'ALICE', squarePath, {
      channel: 'claude-code',
      paseoAgentId: 'paseo-alice',
      at: now,
    });
    const alice = lookupParticipant(squarePath, 'alice', now);
    assert.equal(alice.length, 1);
    assert.equal(alice[0].name, 'ALICE');
    assert.equal(alice[0].paseoAgentId, 'paseo-alice');
    assert.equal(alice[0].channel, 'claude-code');
    assert.deepEqual(
      lookupSession('session-1', now).map((entry) => entry.name).sort(),
      ['ALICE', 'Bob']
    );
  } finally {
    cleanup();
  }
});

test('the latest ownership claim exclusively routes a participant name', () => {
  const cleanup = withRegistry();
  try {
    const squarePath = path.join(os.tmpdir(), 'exclusive-owner-square.square');
    const now = Date.now();
    recordJoin('session-a', 'Alice', squarePath, { channel: 'codex', at: now });
    recordJoin('session-b', 'alice', squarePath, { channel: 'claude-code', at: now });

    assert.deepEqual(lookupSession('session-a', now), []);
    assert.deepEqual(lookupSession('session-b', now), [
      { name: 'alice', squarePath: canonicalSquarePath(squarePath) },
    ]);
    assert.deepEqual(lookupParticipant(squarePath, 'ALICE', now).map((entry) => entry.sessionId), [
      'session-b',
    ]);
  } finally {
    cleanup();
  }
});

test('one local command keeps its native and Paseo identities in the same ownership claim', () => {
  const cleanup = withRegistry();
  try {
    const squarePath = path.join(os.tmpdir(), 'multi-channel-owner-square.square');
    recordLocalJoin('Alice', squarePath, {
      SQUARE_ROUTES: process.env.SQUARE_ROUTES,
      CLAUDE_CODE_SESSION_ID: 'claude-session',
      PASEO_AGENT_ID: 'paseo-agent',
    });

    const bindings = lookupParticipant(squarePath, 'Alice');
    assert.deepEqual(bindings.map((entry) => entry.sessionId).sort(), [
      'claude-session',
      'paseo-agent',
    ]);
    assert.equal(new Set(bindings.map((entry) => entry.ownerId)).size, 1);
  } finally {
    cleanup();
  }
});

test('ending one shared identity keeps the other wake route alive', () => {
  const cleanup = withRegistry();
  try {
    const squarePath = path.join(os.tmpdir(), 'shared-owner-route-square.square');
    const env = {
      SQUARE_ROUTES: process.env.SQUARE_ROUTES,
      CODEX_THREAD_ID: 'codex-session',
      PASEO_AGENT_ID: 'paseo-agent',
    };
    recordLocalJoin('Alice', squarePath, env);
    const before = readWakeRoutes({ env, now: Date.now() }).filter((route) => route.kind === 'paseo');
    assert.equal(before.length, 1);

    assert.equal(recordSessionDone('codex-session', 'Alice', squarePath, 'codex', env), true);
    const after = readWakeRoutes({ env, now: Date.now() }).filter((route) => route.kind === 'paseo');
    assert.deepEqual(after.map((route) => route.address.agentId), ['paseo-agent']);
    assert.deepEqual(lookupParticipant(squarePath, 'Alice').map((binding) => binding.sessionId), ['paseo-agent']);
  } finally {
    cleanup();
  }
});

test('ending the Paseo identity keeps a shared owner route alive for the native identity', () => {
  const cleanup = withRegistry();
  try {
    const squarePath = path.join(os.tmpdir(), 'shared-owner-route-reverse-square.square');
    const env = {
      SQUARE_ROUTES: process.env.SQUARE_ROUTES,
      CODEX_THREAD_ID: 'codex-session',
      PASEO_AGENT_ID: 'paseo-agent',
    };
    recordLocalJoin('Alice', squarePath, env);
    assert.equal(recordSessionDone('paseo-agent', 'Alice', squarePath, 'paseo', env), true);
    assert.deepEqual(readWakeRoutes({ env, now: Date.now() }).map((route) => [route.kind, route.address]), [
      ['codex-queue', { threadId: 'codex-session' }],
      ['paseo', { agentId: 'paseo-agent' }],
    ]);
    assert.deepEqual(lookupParticipant(squarePath, 'Alice').map((binding) => binding.sessionId), ['codex-session']);
  } finally {
    cleanup();
  }
});

test('inherited PASEO_AGENT_ID alone does not adopt a native session into the parent owner', () => {
  const cleanup = withRegistry();
  try {
    const squarePath = path.join(os.tmpdir(), 'nested-owner-square.square');
    const parentEnv = {
      SQUARE_ROUTES: process.env.SQUARE_ROUTES,
      PASEO_AGENT_ID: 'paseo-agent',
      CODEX_THREAD_ID: 'parent-codex',
    };
    recordLocalJoin('root', squarePath, parentEnv);
    const parentOwner = lookupParticipant(squarePath, 'root')[0].ownerId;
    assert.deepEqual(
      lookupParticipant(squarePath, 'root').map((binding) => binding.sessionId).sort(),
      ['parent-codex', 'paseo-agent']
    );

    // Nested/detached child inherits PASEO_AGENT_ID but never claims root.
    const childEnv = {
      SQUARE_ROUTES: process.env.SQUARE_ROUTES,
      PASEO_AGENT_ID: 'paseo-agent',
      CODEX_THREAD_ID: 'child-codex',
    };
    assert.deepEqual(lookupSession('child-codex'), []);
    assert.deepEqual(
      lookupParticipant(squarePath, 'root').map((binding) => binding.sessionId).sort(),
      ['parent-codex', 'paseo-agent']
    );
    assert.equal(lookupParticipant(squarePath, 'root')[0].ownerId, parentOwner);

    // Explicit claim on the same process identities still shares one owner.
    recordLocalJoin('root', squarePath, parentEnv);
    const refreshed = lookupParticipant(squarePath, 'root');
    assert.deepEqual(refreshed.map((binding) => binding.sessionId).sort(), [
      'parent-codex',
      'paseo-agent',
    ]);
    assert.equal(new Set(refreshed.map((binding) => binding.ownerId)).size, 1);
    assert.notEqual(refreshed[0].ownerId, parentOwner);

    recordLocalDone('root', squarePath, parentEnv);
    assert.deepEqual(lookupParticipant(squarePath, 'root'), []);
    assert.deepEqual(lookupSession('child-codex'), []);
  } finally {
    cleanup();
  }
});

test('only explicit join claims local ownership and done closes the current owner', () => {
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
    assert.equal(loadSquare(squarePath).acts.filter((act) => act.kind === 'join').length, 1);

    const reconnected = runCli(['--location', squarePath, '--as', 'alice', 'join'], { env });
    assert.equal(reconnected.status, 0, reconnected.stderr);
    assert.match(reconnected.stdout, /already in the square/);
    assert.deepEqual(lookupSession('resume-session').map((entry) => entry.name), ['Alice']);
    assert.equal(loadSquare(squarePath).acts.filter((act) => act.kind === 'join').length, 1);

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
    assert.deepEqual(lookupSession('observer-session'), []);
    assert.deepEqual(lookupSession('resume-session').map((entry) => entry.name), ['Alice']);

    const catchNow = runCli(['--location', squarePath, '--as', 'Alice', 'catch', '--now'], { env });
    assert.equal(catchNow.status, 0, catchNow.stderr);
    assert.deepEqual(lookupSession('resume-session').map((entry) => entry.name), ['Alice']);
    assert.equal(lookupParticipant(squarePath, 'Alice')[0].paseoAgentId, 'resume-paseo-agent');

    const expressed = runCli(['--location', squarePath, '--as', 'alice', 'express', 'still not an owner @alice'], {
      env: observerEnv,
    });
    assert.equal(expressed.status, 0, expressed.stderr);
    assert.deepEqual(lookupSession('observer-session'), []);
    assert.deepEqual(lookupSession('resume-session').map((entry) => entry.name), ['Alice']);

    const refused = runCli(['--location', squarePath, '--as', 'alice', 'join'], { env: observerEnv });
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /@Alice shoos you out of the square/);
    assert.match(refused.stderr, /join --kick/);
    assert.deepEqual(lookupSession('resume-session').map((entry) => entry.name), ['Alice']);
    assert.deepEqual(lookupSession('observer-session'), []);

    const noIdentityEnv = {
      SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
      SQUARE_ROUTES: process.env.SQUARE_ROUTES,
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      OPENCODE_SESSION_ID: '',
      SQUARE_PI_SESSION_ID: '',
      PASEO_AGENT_ID: '',
    };
    const unboundRefused = runCli(['--location', squarePath, '--as', 'Alice', 'join'], {
      env: noIdentityEnv,
    });
    assert.equal(unboundRefused.status, 2, unboundRefused.stderr);
    assert.match(unboundRefused.stderr, /join --kick/);
    assert.deepEqual(lookupParticipant(squarePath, 'Alice').length, 2);

    const takeover = runCli(['--location', squarePath, '--as', 'alice', 'join', '--kick'], { env: observerEnv });
    assert.equal(takeover.status, 0, takeover.stderr);
    assert.match(takeover.stdout, /you banished the original @Alice/);
    assert.deepEqual(lookupSession('resume-session'), []);
    assert.deepEqual(lookupSession('observer-session').map((entry) => entry.name), ['Alice']);
    assert.equal(loadSquare(squarePath).acts.filter((act) => act.kind === 'join').length, 1);

    const unboundJoin = runCli(['--location', squarePath, '--as', 'Bob', 'join'], {
      env: noIdentityEnv,
    });
    assert.equal(unboundJoin.status, 0, unboundJoin.stderr);
    assert.deepEqual(lookupParticipant(squarePath, 'Bob'), []);

    const done = runCli(['--location', squarePath, '--as', 'Alice', 'done', 'finished'], {
      env: observerEnv,
    });
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(lookupSession('resume-session'), []);
    assert.deepEqual(lookupSession('observer-session'), []);
    fs.rmSync(root, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});

test('registry ignores stale and malformed cache rows', () => {
  const cleanup = withRegistry();
  try {
    const squarePath = path.join(os.tmpdir(), 'stale-square.square');
    const now = Date.now();
    recordJoin('stale-session', 'Alice', squarePath, { at: now - 8 * 24 * 60 * 60 * 1000 });
    fs.appendFileSync(process.env.SQUARE_REGISTRY, '{bad json}\n');
    assert.deepEqual(lookupSession('stale-session', now), []);
  } finally {
    cleanup();
  }
});

test('registry pruning removes only bindings disproved by their square artifacts', () => {
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

    recordJoin('valid-session', 'Alice', squarePath);
    recordJoin('not-joined-session', 'Cara', squarePath);
    recordJoin('missing-session', 'Bob', missingPath);
    recordJoin('uncertain-session', 'Dave', brokenPath);

    assert.deepEqual(pruneRegistry((candidate) => {
      if (!fs.existsSync(candidate)) return [];
      try {
        return loadSquare(candidate).acts;
      } catch {
        return undefined;
      }
    }), { removed: 2, kept: 2 });
    assert.equal(lookupSession('valid-session').length, 1);
    assert.equal(lookupSession('uncertain-session').length, 1);
    assert.deepEqual(lookupSession('not-joined-session'), []);
    assert.deepEqual(lookupSession('missing-session'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('local session discovery never guesses participant identity', () => {
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

test('local session discovery recognizes native Codex, OpenCode, and Pi session ids', () => {
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

test('automatic delivery capability follows native and Paseo session identities', () => {
  assert.equal(hasAutomaticDeliveryIdentity({}), false);
  assert.equal(hasAutomaticDeliveryIdentity({ CODEX_THREAD_ID: 'codex-thread' }), true);
  assert.equal(hasAutomaticDeliveryIdentity({ CLAUDE_CODE_SESSION_ID: 'claude-session' }), true);
  assert.equal(hasAutomaticDeliveryIdentity({ OPENCODE_SESSION_ID: 'opencode-session' }), true);
  assert.equal(hasAutomaticDeliveryIdentity({ SQUARE_PI_SESSION_ID: 'pi-session' }), true);
  assert.equal(hasAutomaticDeliveryIdentity({ PASEO_AGENT_ID: 'paseo-agent' }), true);
});

test('stream recipient filtering matches the addressed participant', async () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 1, body: '', index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, body: '', index: 1 },
    { kind: 'join', actor: 'Cara', at: 3, body: '', index: 2 },
  ];
  const runtime = {
    nextActIndex: 6,
    observations: {},
    leases: {},
    notifyLeases: {},
  };
  const state = {
    hardCap: null,
    preamble: [],
    warmup: [],
    acts: [
      ...acts,
      { kind: 'say', actor: 'Alice', at: 4, body: 'hi @Bob', index: 3 },
      { kind: 'say', actor: 'Alice', at: 5, body: 'hello all', index: 4 },
      { kind: 'say', actor: 'Alice', at: 6, body: 'attention', reach: 'bell', index: 5 },
    ],
    runtime,
  };
  const cell = createMemoryCell(state);
  const square = { cell, clock: Date.now, location: 'memory' };
  try {
    const bob = await streamProjection(square, -1, 'Bob');
    const cara = await streamProjection(square, -1, 'Cara');
    const alice = await streamProjection(square, -1, 'Alice');
    assert.deepEqual(bob.activities.map(({ activity, route }) => [activity.index, route]), [[3, 'mention'], [5, 'bell']]);
    assert.deepEqual(cara.activities.map(({ activity, route }) => [activity.index, route]), [[5, 'bell']]);
    assert.deepEqual(alice.activities, []);
  } finally {
    await cell.close();
  }
});
