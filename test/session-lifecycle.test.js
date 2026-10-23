import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareSquareBuild, readSquareSnapshot, writeSquareFile } from '../dist/artifact.js';

// Explicit fixture inspection only; production session lifecycle never exports authority.
async function loadSquare(location) { return (await readSquareSnapshot(location)).state; }
import { automaticParticipant, operationEnv } from '../dist/participant-identity.js';
import { endSessionMemberships } from '../dist/session-lifecycle.js';
import { codexHookResponse, runCodexHookAsync } from '../dist/codex-hook.js';
import { codexQueueEligible } from '../dist/codex-boundary-state.js';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { hostLedgerRoot } from '../dist/host-ledger-root.js';
import { hostLedgerForEnv, readParticipantOwner } from '../dist/registry.js';
import { readWakeRoutes, retireWakeRoute, upsertWakeRoute } from './wake-routes.js';
import { takeover } from '../dist/square-actions.js';
import { closeOpenSquare, openSquare } from '../dist/open-square.js';
import { Square } from '../dist/square-api.js';
import { runClaudeMod } from '../dist/claude-mod.js';
import squarePiExtension from '../plugins/pi/square-pi.js';
async function joinSession(provider, sessionId, location, env) {
  const scoped = operationEnv(provider, sessionId, env);
  const square = await Square.at({ path: location, hostLedger: hostLedgerForEnv(scoped), env: scoped });
  try { await square.join(automaticParticipant(provider, sessionId, scoped)); }
  finally { await square.close(); }
}
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-auto-'));
  const cwd = path.join(root, 'workspace');
  const squarePath = path.join(cwd, '.square', 'TOPIC.square');
  fs.mkdirSync(path.dirname(squarePath), { recursive: true });
  await writeSquareFile(squarePath, await prepareSquareBuild({ force: true, hardCap: null }, 'Host context'));
  const env = {
    ...process.env,
    CLAUDE_CODE_SESSION_ID: '',
    CODEX_THREAD_ID: '',
    OPENCODE_SESSION_ID: '',
    PI_SESSION_ID: '',
    PASEO_AGENT_ID: '',
    SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'),
    SQUARE_WAKE_ATTEMPTS: path.join(root, 'wake.ndjsonl'),
    SQUARE_ROUTES: path.join(root, 'routes.ndjsonl'),
    SQUARE_CODEX_BOUNDARIES: path.join(root, 'codex-boundaries.json'),
    SQUARE_LOCATION: path.join(root, 'other.square'),
  };
  return { root, cwd, squarePath, env };
}
async function withEnv(env, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try { return await fn(process.env); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
test('session end writes ordinary done for its bound owner', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv(item.env, async (env) => {
    await joinSession('pi', 'pi-session', item.squarePath, env);
    await endSessionMemberships('pi', 'pi-session', env);
  });
  const squareState = await loadSquare(item.squarePath);
  assert.deepEqual(squareState.acts.map((act) => act.kind), ['join', 'done']);
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'changed' }, (env) => endSessionMemberships('pi', 'pi-session', env));
  assert.equal((await loadSquare(item.squarePath)).acts.length, 2);
});
test('session end retires every name the ended session owns', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, CODEX_THREAD_ID: 'multi-session' }, async (env) => {
    const square = await Square.at({ path: item.squarePath, hostLedger: createHostLedgerPort({ rootPath: hostLedgerRoot(env) }), env });
    try {
      await square.join('lead');
      await square.join('alice');
    } finally { await square.close(); }
    const otherPath = path.join(item.cwd, 'OTHER.square');
    const other = await Square.build({ path: otherPath, env, markdown: 'Another explicit membership' });
    try { await other.join('bob'); } finally { await other.close(); }
    await endSessionMemberships('codex', 'multi-session', env);
    assert.deepEqual((await loadSquare(otherPath)).acts.map((act) => act.kind), ['join', 'done']);
    const ledger = createHostLedgerPort({ rootPath: hostLedgerRoot(env) });
    assert.deepEqual(await ledger.listPresence({ session: 'multi-session' }), []);
    assert.deepEqual(await readWakeRoutes({ location: item.squarePath, sessionId: 'multi-session' }), []);
  });
  const done = (await loadSquare(item.squarePath)).acts.filter((act) => act.kind === 'done').map((act) => act.actor).toSorted();
  assert.deepEqual(done, ['alice', 'lead']);
});
test('session end leaves a participant owned by another session standing', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv(item.env, async (env) => {
    const ending = { ...env, CODEX_THREAD_ID: 'ending-session' };
    const other = { ...env, CODEX_THREAD_ID: 'other-session' };
    for (const [name, sessionEnv] of [['lead', ending], ['bob', other]]) {
      const square = await Square.at({ path: item.squarePath, hostLedger: createHostLedgerPort({ rootPath: hostLedgerRoot(sessionEnv) }), env: sessionEnv });
      try { await square.join(name); } finally { await square.close(); }
    }
    await endSessionMemberships('codex', 'ending-session', env);
    assert.equal((await readParticipantOwner(item.squarePath, 'bob', hostLedgerForEnv(env)))?.session, 'other-session');
    assert.deepEqual((await readWakeRoutes({ location: item.squarePath })).map((route) => route.participant), ['bob']);
  });
  assert.deepEqual((await loadSquare(item.squarePath)).acts.map((act) => act.kind), ['join', 'join', 'done']);
});
test('successful session end does not reopen a committed artifact', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv(item.env, (env) => joinSession('pi', 'pi-session', item.squarePath, env));
  const originalAt = Square.at;
  const movedPath = `${item.squarePath}.after-end`;
  let moved = false;
  Square.at = async (...args) => {
    const square = await originalAt(...args);
    const endOwnedSession = square.endOwnedSession.bind(square);
    square.endOwnedSession = async (...endArgs) => {
      const result = await endOwnedSession(...endArgs);
      if (result !== null && !moved) {
        fs.renameSync(item.squarePath, movedPath);
        moved = true;
      }
      return result;
    };
    return square;
  };
  try {
    await withEnv(item.env, (env) => endSessionMemberships('pi', 'pi-session', env));
  } finally {
    Square.at = originalAt;
    if (moved) fs.renameSync(movedPath, item.squarePath);
  }
  assert.deepEqual((await loadSquare(item.squarePath)).acts.map((act) => act.kind), ['join', 'done']);
});
test('session end preserves a replacement owner after committed cleanup', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'shared' }, async (env) => {
    await joinSession('pi', 'old-session', item.squarePath, env);
    const originalAt = Square.at;
    let ownerBeforeOldCleanup;
    try {
      Square.at = async (...args) => {
        const square = await originalAt(...args);
        const originalEnd = square.endOwnedSession.bind(square);
        square.endOwnedSession = async (...endArgs) => {
          const result = await originalEnd(...endArgs);
          const replacementEnv = { ...env, PI_SESSION_ID: 'new-session' };
          const replacement = await originalAt({ path: item.squarePath, hostLedger: createHostLedgerPort({ rootPath: hostLedgerRoot(replacementEnv) }), env: replacementEnv });
          try {
            await replacement.join('shared');
            await replacement.join('shared', { takeover: true });
            ownerBeforeOldCleanup = await readParticipantOwner(item.squarePath, 'shared', hostLedgerForEnv(replacementEnv));
          } finally { await replacement.close(); }
          return result;
        };
        return square;
      };
      await endSessionMemberships('pi', 'old-session', env);
      assert.equal(ownerBeforeOldCleanup?.session, 'new-session');
      assert.equal(ownerBeforeOldCleanup?.epoch, 2);
      assert.equal((await readParticipantOwner(item.squarePath, 'shared', hostLedgerForEnv(env)))?.session, 'new-session');
    } finally { Square.at = originalAt; }
  });
});
test('session end preserves a same-session rejoin after committed cleanup', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'shared' }, async (env) => {
    await joinSession('codex', 'rejoin-session', item.squarePath, env);
    const originalAt = Square.at;
    let ownerAfterRejoin;
    let routesAfterRejoin;
    try {
      Square.at = async (...args) => {
        const square = await originalAt(...args);
        const originalEnd = square.endOwnedSession.bind(square);
        square.endOwnedSession = async (...endArgs) => {
          const result = await originalEnd(...endArgs);
          // The same session rejoins and reclaims the name while the old SessionEnd is
          // still unwinding. Its epoch-2 owner row and route must survive: an epoch-only
          // external check is not enough, because a plain rejoin reuses epoch 1.
          const rejoinEnv = { ...env, CODEX_THREAD_ID: 'rejoin-session' };
          const rejoin = await originalAt({
            path: item.squarePath,
            hostLedger: createHostLedgerPort({ rootPath: hostLedgerRoot(rejoinEnv) }),
            env: rejoinEnv,
          });
          try {
            await rejoin.join('shared');
            await rejoin.join('shared', { takeover: true });
            ownerAfterRejoin = await readParticipantOwner(item.squarePath, 'shared', hostLedgerForEnv(rejoinEnv));
            routesAfterRejoin = await readWakeRoutes({ location: item.squarePath });
          } finally { await rejoin.close(); }
          return result;
        };
        return square;
      };
      await endSessionMemberships('codex', 'rejoin-session', env);
    } finally { Square.at = originalAt; }
    assert.equal(ownerAfterRejoin?.session, 'rejoin-session');
    assert.equal(ownerAfterRejoin?.epoch, 2);
    assert.equal((await readParticipantOwner(item.squarePath, 'shared', hostLedgerForEnv(env)))?.session, 'rejoin-session');
    assert.deepEqual(routesAfterRejoin.map((route) => route.sessionId), ['rejoin-session']);
    assert.deepEqual((await readWakeRoutes({ location: item.squarePath })).map((route) => route.sessionId), ['rejoin-session']);
  });
});
test('session end writes done when the callable route is already missing', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv(item.env, async (env) => {
    await joinSession('pi', 'pi-session', item.squarePath, env);
    const square = await openSquare(item.squarePath);
    try {
      await square.artifact.transact((facts) => facts.replaceRoutes(facts.routes().filter((route) => route.sessionId !== 'pi-session')));
    } finally { await closeOpenSquare(square); }
    await endSessionMemberships('pi', 'pi-session', env);
  });
  assert.deepEqual((await loadSquare(item.squarePath)).acts.map((act) => act.kind), ['join', 'done']);
});
test('explicit route retirement removes a stale route when its presence row is already gone', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv(item.env, async (env) => {
    await joinSession('pi', 'pi-session', item.squarePath, env);
    const ledger = createHostLedgerPort({ rootPath: env.SQUARE_HOST_LEDGER_ROOT ?? path.dirname(env.SQUARE_REGISTRY) });
    await ledger.removePresence({ location: item.squarePath, participant: automaticParticipant('pi', 'pi-session', env), session: 'pi-session', channel: 'pi' });
    const square = await Square.at({ path: item.squarePath, hostLedger: ledger, env });
    try { await square.retireEndedSessionRoutes('pi-session'); } finally { await square.close(); }
  });
  assert.equal((await readWakeRoutes({ location: item.squarePath, sessionId: 'pi-session' })).length, 0);
  assert.deepEqual((await loadSquare(item.squarePath)).acts.map((act) => act.kind), ['join']);
});
test('uncapable old SessionEnd cannot done a replacement after takeover', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'shared' }, async (env) => {
    await joinSession('pi', 'old-session', item.squarePath, env);
    assert.deepEqual((await readWakeRoutes({ location: item.squarePath })).map((route) => route.sessionId), []);
    const replacementEnv = { ...env, PI_SESSION_ID: 'new-session' };
    const replacement = await Square.at({ path: item.squarePath, hostLedger: createHostLedgerPort({ rootPath: hostLedgerRoot(replacementEnv) }), env: replacementEnv });
    try { await replacement.join('shared', { takeover: true }); } finally { await replacement.close(); }
    await endSessionMemberships('pi', 'old-session', env);
  });
  assert.deepEqual((await loadSquare(item.squarePath)).acts.map((act) => act.kind), ['join', 'done', 'join']);
});
test('takeover fenced before shutdown leaves the replacement owner and route untouched', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'shared' }, async (env) => {
    await joinSession('codex', 'old-session', item.squarePath, env);
    const replacementEnv = { ...env, CODEX_THREAD_ID: 'new-session' };
    const replacement = await openSquare(item.squarePath, { hostLedger: createHostLedgerPort({ rootPath: hostLedgerRoot(replacementEnv) }), env: replacementEnv });
    const transact = replacement.artifact.transact.bind(replacement.artifact);
    let entered;
    let release;
    const lifecycleEntered = new Promise((resolve) => { entered = resolve; });
    const releaseLifecycle = new Promise((resolve) => { release = resolve; });
    replacement.artifact.transact = async (fn) => {
      entered();
      await releaseLifecycle;
      return transact(fn);
    };
    try {
      const takeoverResult = takeover(replacement, 'shared');
      await lifecycleEntered;
      const shutdown = endSessionMemberships('codex', 'old-session', env);
      release();
      await Promise.all([takeoverResult, shutdown]);
    } finally { await closeOpenSquare(replacement); }
  });
  assert.deepEqual((await loadSquare(item.squarePath)).acts.map((act) => act.kind), ['join', 'done', 'join']);
  assert.deepEqual((await readWakeRoutes({ location: item.squarePath })).map((route) => route.sessionId), ['new-session']);
});
test('session end does not done a replacement that still owns the participant', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'shared' }, async (env) => {
    await joinSession('pi', 'old-session', item.squarePath, env);
    const ledger = createHostLedgerPort({ rootPath: env.SQUARE_HOST_LEDGER_ROOT ?? path.dirname(env.SQUARE_REGISTRY) });
    await ledger.ensurePresence({ location: item.squarePath, participant: 'shared', session: 'new-session', channel: 'pi', updatedAt: Date.now() });
    await endSessionMemberships('pi', 'old-session', env);
  });
  assert.deepEqual((await loadSquare(item.squarePath)).acts.map((act) => act.kind), ['join']);
});
test('done then rejoin leaves only the current session route', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'shared' }, async (env) => {
    await joinSession('codex', 'old-session', item.squarePath, env);
    await endSessionMemberships('codex', 'old-session', env);
    const rejoinEnv = { ...env, CODEX_THREAD_ID: 'new-session' };
    const square = await Square.at({ path: item.squarePath, hostLedger: createHostLedgerPort({ rootPath: hostLedgerRoot(rejoinEnv) }), env: rejoinEnv });
    try { await square.join('shared'); } finally { await square.close(); }
  });
  assert.deepEqual((await loadSquare(item.squarePath)).acts.map((act) => act.kind), ['join', 'done', 'join']);
  assert.deepEqual((await readWakeRoutes({ location: item.squarePath })).map((route) => route.sessionId), ['new-session']);
});
test('concurrent SessionEnd and kick leave the replacement standing', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'shared' }, async (env) => {
    await joinSession('codex', 'old-session', item.squarePath, env);
    const replacementEnv = { ...env, CODEX_THREAD_ID: 'new-session' };
    const replacement = Square.at({ path: item.squarePath, hostLedger: createHostLedgerPort({ rootPath: hostLedgerRoot(replacementEnv) }), env: replacementEnv }).then(async (square) => {
      try { return await square.join('shared', { takeover: true }); }
      finally { await square.close(); }
    });
    const [ended, kicked] = await Promise.allSettled([
      endSessionMemberships('codex', 'old-session', env),
      replacement,
    ]);
    assert.equal(ended.status, 'fulfilled');
    const kinds = (await loadSquare(item.squarePath)).acts.map((act) => act.kind);
    if (kicked.status === 'fulfilled') {
      assert.equal(kinds.at(-1), 'join');
      assert.equal(kinds.filter((kind) => kind === 'done').length, 1);
      assert.deepEqual((await readWakeRoutes({ location: item.squarePath })).map((route) => route.sessionId), ['new-session']);
    } else {
      assert.deepEqual(kinds, ['join', 'done']);
    }
  });
});
test('explicit retirement of a late old-session route leaves the replacement standing', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'shared' }, async (env) => {
    await joinSession('codex', 'old-session', item.squarePath, env);
    const replacementEnv = { ...env, CODEX_THREAD_ID: 'new-session' };
    const replacement = await Square.at({ path: item.squarePath, hostLedger: createHostLedgerPort({ rootPath: hostLedgerRoot(replacementEnv) }), env: replacementEnv });
    try { await replacement.join('shared', { takeover: true }); } finally { await replacement.close(); }
    await upsertWakeRoute({ location: item.squarePath, participant: 'shared', sessionId: 'old-session', channel: 'codex', kind: 'codex-queue', address: { threadId: 'old-session' } }, { at: Date.now() + 60_000 });
    const retiring = await Square.at({ path: item.squarePath, hostLedger: hostLedgerForEnv(env), env });
    try { await retiring.retireEndedSessionRoutes('old-session'); } finally { await retiring.close(); }
  });
  const kinds = (await loadSquare(item.squarePath)).acts.map((act) => act.kind);
  assert.deepEqual(kinds, ['join', 'done', 'join']);
  assert.equal(kinds.at(-1), 'join');
  assert.equal(kinds.filter((kind) => kind === 'done').length, 1);
  assert.deepEqual((await readWakeRoutes({ location: item.squarePath })).map((route) => route.sessionId), ['new-session']);
});
test('kick replacement retires the old session route and keeps the new one', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'shared', CODEX_THREAD_ID: 'new-session' }, async (env) => {
    await joinSession('codex', 'old-session', item.squarePath, env);
    const square = await Square.at({ path: item.squarePath, hostLedger: createHostLedgerPort({ rootPath: env.SQUARE_HOST_LEDGER_ROOT ?? path.dirname(env.SQUARE_REGISTRY) }), env });
    try { await square.join('shared', { takeover: true }); } finally { await square.close(); }
    await endSessionMemberships('codex', 'old-session', env);
  });
  assert.deepEqual((await loadSquare(item.squarePath)).acts.map((act) => act.kind), ['join', 'done', 'join']);
  assert.deepEqual((await readWakeRoutes({ location: item.squarePath })).map((route) => route.sessionId), ['new-session']);
});
test('Paseo is available when a Claude session has no registered native mod route', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, PASEO_AGENT_ID: 'paseo-agent' }, async (env) => {
    await joinSession('claude', 'claude-session', item.squarePath, env);
  });
  const routes = (await loadSquare(item.squarePath)).routes;
  assert.equal(routes.length, 1);
  assert.equal(routes[0].channel, 'claude-code');
  assert.deepEqual({ kind: routes[0].kind, address: routes[0].address }, { kind: 'paseo', address: { agentId: 'paseo-agent' } });
});
test('ordinary active join does not publish a replacement identity route', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'shared' }, async (env) => {
    await joinSession('codex', 'first-session', item.squarePath, env);
    const replacementEnv = { ...env, CODEX_THREAD_ID: 'second-session' };
    const square = await Square.at({ path: item.squarePath, hostLedger: createHostLedgerPort({ rootPath: hostLedgerRoot(replacementEnv) }), env: replacementEnv });
    try { await assert.rejects(square.join('shared'), (error) => error?.code === 'already_joined'); } finally { await square.close(); }
  });
  assert.deepEqual((await readWakeRoutes({ location: item.squarePath })).map((route) => route.sessionId), ['first-session']);
});
test('active implicit join does not publish a replacement identity route', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'shared' }, async (env) => {
    await joinSession('codex', 'first-session', item.squarePath, env);
    const replacementEnv = { ...env, CODEX_THREAD_ID: 'second-session' };
    const square = await Square.at({ path: item.squarePath, hostLedger: createHostLedgerPort({ rootPath: hostLedgerRoot(replacementEnv) }), env: replacementEnv });
    try {
      const result = await square.implicitJoin('shared');
      assert.equal(result.state, 'active');
    } finally { await square.close(); }
  });
  assert.deepEqual((await readWakeRoutes({ location: item.squarePath })).map((route) => route.sessionId), ['first-session']);
});
test('old shutdown paused across a replacement cannot mark the new owner done', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'shared' }, async (env) => {
    await joinSession('pi', 'owner-a', item.squarePath, env);
    const { createHostLedgerPort } = await import('../dist/host-ledger-file-adapter.js');
    const { projectSessionBindings } = await import('../dist/square-projections.js');
    const { readParticipantOwner } = await import('../dist/registry.js');
    const { done } = await import('../dist/square-actions.js');
    const { openSquare } = await import('../dist/open-square.js');
    const { closeOpenSquare } = await import('../dist/open-square.js');
    const { Square } = await import('../dist/square-api.js');
    const hostLedger = createHostLedgerPort({
      rootPath: env.SQUARE_HOST_LEDGER_ROOT ?? path.dirname(env.SQUARE_REGISTRY),
    });
    const pausedBinding = (await projectSessionBindings({
      hostLedger,
      sessionId: 'owner-a',
      location: item.squarePath,
    }))[0];
    assert.ok(pausedBinding);
    const expectedEpoch = (await readParticipantOwner(item.squarePath, pausedBinding.participant, hostLedgerForEnv(env)))?.epoch ?? 0;
    assert.equal(expectedEpoch, 1);
    // Mirror operationEnv: only the pi session claims ownership; ambient runner identities must not leak in.
    const replacementEnv = {
      ...env,
      CLAUDE_CODE_SESSION_ID: '',
      CLAUDE_CODE_CHILD_SESSION: '',
      CODEX_THREAD_ID: '',
      OPENCODE_SESSION_ID: '',
      PI_SESSION_ID: 'owner-b',
    };
    const square = await Square.at({ path: item.squarePath, hostLedger, env: replacementEnv });
    try {
      await square.join('shared', { takeover: true });
    } finally {
      await square.close();
    }
    const oldSession = await openSquare(item.squarePath, {
      hostLedger,
      env: { ...env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_CODE_CHILD_SESSION: '', CODEX_THREAD_ID: '', OPENCODE_SESSION_ID: '', PI_SESSION_ID: 'owner-a' },
    });
    try {
      await assert.rejects(
        () => done(oldSession, pausedBinding.participant, '', { expectedEpoch }),
        (error) => error?.code === 'already_done',
      );
    } finally {
      await closeOpenSquare(oldSession);
    }
  });
  const acts = (await loadSquare(item.squarePath)).acts.map((act) => act.kind);
  assert.deepEqual(acts, ['join', 'done', 'join']);
  assert.equal((await hostLedgerForEnv(item.env).listPresence({ session: 'owner-a' })).some((binding) => binding.participant === 'shared'), false);
  assert.equal((await hostLedgerForEnv(item.env).listPresence({ session: 'owner-b' })).some((binding) => binding.participant === 'shared'), true);
});
test('explicit rejoin publishes the current epoch and stale retirement leaves it in place', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'shared', PASEO_AGENT_ID: 'paseo-agent' }, async (env) => {
    await joinSession('pi', 'owner-a', item.squarePath, env);
    const participant = 'shared';
    assert.equal((await readParticipantOwner(item.squarePath, participant, hostLedgerForEnv(env)))?.epoch, 1);
    assert.equal((await readWakeRoutes({ location: item.squarePath, participant, sessionId: 'owner-a', now: Date.now() }))[0]?.epoch, 1);
    const replacement = await Square.at({
      path: item.squarePath,
      hostLedger: createHostLedgerPort({
        rootPath: env.SQUARE_HOST_LEDGER_ROOT ?? path.dirname(env.SQUARE_REGISTRY),
      }),
      env: { ...env, CODEX_THREAD_ID: '', PI_SESSION_ID: 'owner-a' },
    });
    try {
      await replacement.join(participant, { takeover: true });
    } finally {
      await replacement.close();
    }
    assert.equal((await readParticipantOwner(item.squarePath, participant, hostLedgerForEnv(env)))?.epoch, 2);
    await joinSession('pi', 'owner-a', item.squarePath, env);
    const currentRoute = (await readWakeRoutes({ location: item.squarePath, participant, sessionId: 'owner-a', now: Date.now() }))[0];
    assert.equal(currentRoute?.epoch, 2);
    assert.ok(currentRoute);
    await retireWakeRoute(currentRoute, { expectedEpoch: 1, env });
    const routes = await readWakeRoutes({ location: item.squarePath, participant, sessionId: 'owner-a', now: Date.now() });
    assert.equal(routes.length, 1);
    assert.equal(routes[0].epoch, 2);
  });
});
test('Codex and Claude startup do not join existing PUBLIC or configured square files', async (t) => {
  const item = await fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const publicPath = path.join(item.cwd, '.square', 'PUBLIC.square');
  await writeSquareFile(publicPath, await prepareSquareBuild({ hardCap: null }, 'Ordinary filename'));
  const env = { ...item.env, SQUARE_LOCATION: item.squarePath };
  for (const hook_event_name of ['SessionStart', 'SessionResume']) {
    await runCodexHookAsync(JSON.stringify({ session_id: 'no-auto-entry', cwd: item.cwd, hook_event_name }), env);
  }
  const started = JSON.parse(await runClaudeMod(JSON.stringify({
    operation: 'start', sessionId: 'no-auto-entry-claude', cwd: item.cwd, version: 'test',
  }), env));
  assert.deepEqual(started.bindings, []);
  assert.deepEqual((await loadSquare(publicPath)).acts, []);
  assert.deepEqual((await loadSquare(item.squarePath)).acts, []);
  assert.deepEqual(await hostLedgerForEnv(env).listPresence({}), []);
});

test('Pi startup and shutdown leave existing square files unjoined', async (t) => {
  const item = await fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const publicPath = path.join(item.cwd, '.square', 'PUBLIC.square');
  await writeSquareFile(publicPath, await prepareSquareBuild({ hardCap: null }, 'Ordinary filename'));
  await withEnv({ ...item.env, SQUARE_LOCATION: item.squarePath }, async (env) => {
    const handlers = new Map();
    const messages = [];
    squarePiExtension({
      registerTool() {}, registerFlag() {}, getFlag() {},
      on(event, handler) { handlers.set(event, handler); },
      sendMessage(message) { messages.push(message); },
    });
    const ctx = { cwd: item.cwd, sessionManager: { getSessionId: () => 'no-auto-entry-pi' } };
    try { await handlers.get('session_start')({}, ctx); }
    finally { await handlers.get('session_shutdown')({}, ctx); }
    assert.deepEqual(messages, []);
    assert.deepEqual(await hostLedgerForEnv(env).listPresence({}), []);
  });
  assert.deepEqual((await loadSquare(publicPath)).acts, []);
  assert.deepEqual((await loadSquare(item.squarePath)).acts, []);
});

test('Codex hook leaves entry explicit and ends its manually joined membership', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv(item.env, async (env) => {
    const start = await runCodexHookAsync(JSON.stringify({ session_id: 'hook-session', cwd: item.cwd, hook_event_name: 'SessionStart', source: 'startup' }), env);
    assert.equal(start, '');
    assert.deepEqual((await loadSquare(item.squarePath)).acts, []);
    await joinSession('codex', 'hook-session', item.squarePath, env);
    const end = await runCodexHookAsync(JSON.stringify({ session_id: 'hook-session', cwd: item.cwd, hook_event_name: 'SessionEnd' }), env);
    assert.equal(end, '');
  });
  assert.deepEqual((await loadSquare(item.squarePath)).acts.map((act) => act.kind), ['join', 'done']);
});
test('Codex PostToolUse does not recreate a deleted root for a stale indexed square', { concurrency: false }, async () => {
  const item = await fixture();
  const staleRoot = path.join(item.root, 'deleted-square-root');
  const stalePath = path.join(staleRoot, 'SQUARE.square');
  fs.mkdirSync(staleRoot, { recursive: true });
  await writeSquareFile(stalePath, await prepareSquareBuild({ force: true, hardCap: null }, 'stale'));
  const ledger = createHostLedgerPort({ rootPath: item.root });
  await ledger.ensurePresence({
    location: stalePath,
    participant: 'stale-participant',
    session: 'stale-session',
    channel: 'codex',
  }, 'user');
  fs.rmSync(staleRoot, { recursive: true, force: true });
  await runCodexHookAsync(JSON.stringify({
    session_id: 'observing-session',
    hook_event_name: 'PostToolUse',
    cwd: path.join(item.root, 'workspace-without-a-square'),
  }), item.env);
  assert.equal(fs.existsSync(staleRoot), false);
  assert.equal(fs.existsSync(`${stalePath}.lock`), false);
});
test('Codex SessionResume without cwd records its boundary without discovering squares', { concurrency: false }, async () => {
  const item = await fixture();
  const previousCwd = process.cwd();
  process.chdir(item.cwd);
  try {
    await withEnv(item.env, async (env) => {
      const resume = await runCodexHookAsync(JSON.stringify({ session_id: 'resume-without-cwd', hook_event_name: 'SessionResume', source: 'resume' }), env);
      assert.equal(resume, '');
      assert.equal(await codexQueueEligible('resume-without-cwd', env), false);
    });
  } finally {
    process.chdir(previousCwd);
  }
  assert.deepEqual((await loadSquare(item.squarePath)).acts, []);
});
test('Codex Stop records the stopped boundary without presenting pending attention', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv(item.env, async (env) => {
    let inboxReads = 0;
    const result = await codexHookResponse(
      { session_id: 'stop-session', hook_event_name: 'Stop' },
      () => {
        inboxReads += 1;
        return [{
          name: 'Bob',
          squarePath: item.squarePath,
          ownerId: 'stop-owner',
          notifications: [{ actIndex: 2, actor: 'Alice', at: 3, route: 'mention', body: 'stop answer' }],
        }];
      },
      env,
    );
    assert.equal(result, undefined);
    assert.equal(inboxReads, 0);
    assert.equal(await codexQueueEligible('stop-session', env), true);
  });
});
test('Codex hook boundary state follows Stop, non-Stop, and SessionEnd', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv(item.env, async (env) => {
    const thread = 'boundary-thread';
    await runCodexHookAsync(JSON.stringify({ session_id: thread, hook_event_name: 'SessionStart', cwd: item.cwd }), env);
    assert.equal(await codexQueueEligible(thread, env), false);
    await runCodexHookAsync(JSON.stringify({ session_id: thread, hook_event_name: 'Stop' }), env);
    assert.equal(await codexQueueEligible(thread, env), true);
    await runCodexHookAsync(JSON.stringify({ session_id: thread, hook_event_name: 'PostToolUse' }), env);
    assert.equal(await codexQueueEligible(thread, env), false);
    await runCodexHookAsync(JSON.stringify({ session_id: thread, hook_event_name: 'Stop' }), env);
    assert.equal(await codexQueueEligible(thread, env), true);
    await runCodexHookAsync(JSON.stringify({ session_id: thread, hook_event_name: 'SessionEnd' }), env);
    assert.equal(await codexQueueEligible(thread, env), false);
  });
});

test('done retires only its own route in a session that holds several participants', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, CODEX_THREAD_ID: 'dual-session' }, async (env) => {
    const square = await Square.at({ path: item.squarePath, hostLedger: createHostLedgerPort({ rootPath: hostLedgerRoot(env) }), env });
    try {
      const a = (await square.join('a')).participant;
      await square.join('b');
      await a.done();
    } finally { await square.close(); }
    assert.deepEqual((await readWakeRoutes({ location: item.squarePath })).map((route) => route.participant).sort(), ['b']);
    assert.equal((await readParticipantOwner(item.squarePath, 'b', hostLedgerForEnv(env)))?.session, 'dual-session');
    assert.equal(await readParticipantOwner(item.squarePath, 'a', hostLedgerForEnv(env)), undefined);
  });
  assert.deepEqual((await loadSquare(item.squarePath)).acts.map((act) => act.kind), ['join', 'join', 'done']);
});
