import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createArtifactPort } from '../dist/artifact.js';
import { Square } from '../dist/square-api.js';
import { endSessionMemberships } from '../dist/session-lifecycle.js';
import { codexHookResponse, runCodexHookAsync } from '../dist/codex-hook.js';
import { codexQueueEligible } from '../dist/codex-boundary-state.js';
import { runClaudeMod } from '../dist/claude-mod.js';
import { rememberSquarePath } from '../dist/square-index.js';
import { projectSessionSeats } from '../dist/inbox.js';
import squarePiExtension from '../plugins/pi/square-pi.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-session-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    SQUARE_INDEX: path.join(root, 'index.ndjsonl'),
    SQUARE_CODEX_BOUNDARIES: path.join(root, 'codex-boundaries.json'),
  };
  const squarePath = path.join(root, 'main.square');
  const square = await Square.build({ path: squarePath, markdown: 'Lifecycle fixture', env,
    body: { channel: 'test', session: 'builder' }, participant: 'Host' });
  await square.close();
  return { root, squarePath, env };
}

async function joinAt(location, participant, body, env, options = {}) {
  const square = await Square.at({ path: location, body, participant, env });
  try { return await square.join(participant, options); }
  finally { await square.close(); }
}

async function artifactFacts(location, select) {
  const artifact = createArtifactPort(location);
  try { return (await artifact.read(select)).value; }
  finally { await artifact.close(); }
}

test('session end writes done for every seat held by that exact body across indexed squares', async t => {
  const f = await fixture(t);
  const secondPath = path.join(f.root, 'second.square');
  const second = await Square.build({ path: secondPath, markdown: 'Second lifecycle fixture', env: f.env,
    body: { channel: 'test', session: 'builder-2' }, participant: 'Host' });
  await second.close();
  const body = { channel: 'codex', session: 'multi-square-session' };
  await joinAt(f.squarePath, 'lead', body, f.env);
  await joinAt(f.squarePath, 'alice', body, f.env);
  await joinAt(secondPath, 'bob', body, f.env);
  const otherBody = { channel: 'codex', session: 'other-session' };
  await joinAt(f.squarePath, 'carol', otherBody, f.env);

  await endSessionMemberships('codex', body.session, f.env);
  await endSessionMemberships('codex', body.session, f.env);

  const main = await artifactFacts(f.squarePath, facts => ({
    acts: facts.activityHeads({}, { edge: 'oldest', limit: 20 }).items,
    seats: facts.seatsForBody(body),
    otherSeat: facts.seat('carol'),
  }));
  const remote = await artifactFacts(secondPath, facts => ({
    acts: facts.activityHeads({}, { edge: 'oldest', limit: 20 }).items,
    seats: facts.seatsForBody(body),
  }));
  assert.deepEqual(main.acts.filter(activity => activity.kind === 'done').map(activity => activity.actor).sort(), ['alice', 'lead']);
  assert.deepEqual(remote.acts.filter(activity => activity.kind === 'done').map(activity => activity.actor), ['bob']);
  assert.deepEqual(main.seats, []);
  assert.equal(main.otherSeat?.body.session, 'other-session');
  assert.deepEqual(remote.seats, []);
});

test('session end cannot retire a participant whose seat moved to another body', async t => {
  const f = await fixture(t);
  const oldBody = { channel: 'pi', session: 'old-session' };
  const replacementBody = { channel: 'pi', session: 'new-session' };
  await joinAt(f.squarePath, 'shared', oldBody, f.env);
  await joinAt(f.squarePath, 'shared', replacementBody, f.env, { takeover: true });

  await endSessionMemberships('pi', oldBody.session, f.env);
  const result = await artifactFacts(f.squarePath, facts => ({
    kinds: facts.activityHeads({}, { edge: 'oldest', limit: 20 }).items.map(activity => activity.kind),
    seat: facts.seat('shared'),
  }));
  assert.deepEqual(result.kinds, ['join', 'done', 'join']);
  assert.equal(result.seat?.body.session, 'new-session');
});

test('a stale captured seat generation cannot end a replacement rejoin', async t => {
  const f = await fixture(t);
  const body = { channel: 'pi', session: 'same-session' };
  const first = await joinAt(f.squarePath, 'shared', body, f.env);
  const captured = first.participant && await artifactFacts(f.squarePath, facts => facts.seat('shared'));
  assert.ok(captured);
  await joinAt(f.squarePath, 'shared', body, f.env, { takeover: true });
  const stale = await Square.at({ path: f.squarePath, body, participant: 'shared', env: f.env });
  try {
    assert.equal(await stale.endOwnedSession('shared', body.session, captured.generation, body), null);
  } finally { await stale.close(); }
  const result = await artifactFacts(f.squarePath, facts => ({
    kinds: facts.activityHeads({}, { edge: 'oldest', limit: 20 }).items.map(activity => activity.kind),
    seat: facts.seat('shared'),
  }));
  assert.deepEqual(result.kinds, ['join', 'done', 'join']);
  assert.notEqual(result.seat?.generation, captured.generation);
});

test('Claude and Pi startup do not create artifact seats without an explicit join', async t => {
  const f = await fixture(t);
  const claudeBody = { channel: 'claude-code', session: 'empty-claude-session' };
  const piBody = { channel: 'pi', session: 'empty-pi-session' };
  await rememberSquarePath(f.squarePath, claudeBody, f.env.SQUARE_INDEX);
  await rememberSquarePath(f.squarePath, piBody, f.env.SQUARE_INDEX);
  const claude = JSON.parse(await runClaudeMod(JSON.stringify({ operation: 'start', sessionId: claudeBody.session,
    cwd: f.root, version: 'test', endpoint: 'relative.sock' }), f.env));
  assert.deepEqual(claude.bindings, []);

  const handlers = new Map();
  const messages = [];
  squarePiExtension({
    registerTool() {}, registerFlag() {}, getFlag() {},
    on(event, handler) { handlers.set(event, handler); },
    sendMessage(message) { messages.push(message); },
  });
  const context = { cwd: f.root, sessionManager: { getSessionId: () => piBody.session } };
  await handlers.get('session_start')({}, context);
  await handlers.get('session_shutdown')({}, context);
  assert.deepEqual(messages, []);
  const result = await artifactFacts(f.squarePath, facts => ({
    roster: facts.roster(),
    seats: [...facts.seatsForBody(claudeBody), ...facts.seatsForBody(piBody)],
    activities: facts.activityHeads({}, { edge: 'oldest', limit: 20 }).items,
  }));
  assert.deepEqual(result.roster, []);
  assert.deepEqual(result.seats, []);
  assert.deepEqual(result.activities, []);
});

test('an explicit Codex join ends through the lifecycle hook without startup auto-entry', { concurrency: false }, async t => {
  const f = await fixture(t);
  const start = await runCodexHookAsync(JSON.stringify({ session_id: 'hook-session', cwd: f.root,
    hook_event_name: 'SessionStart', source: 'startup' }), f.env);
  assert.equal(start, '');
  assert.deepEqual(await artifactFacts(f.squarePath, facts => facts.activityHeads({}, { edge: 'oldest', limit: 20 }).items), []);
  await joinAt(f.squarePath, 'manual', { channel: 'codex', session: 'hook-session' }, f.env);
  const end = await runCodexHookAsync(JSON.stringify({ session_id: 'hook-session', cwd: f.root,
    hook_event_name: 'SessionEnd' }), f.env);
  assert.equal(end, '');
  assert.deepEqual(await artifactFacts(f.squarePath, facts => facts.activityHeads({}, { edge: 'oldest', limit: 20 }).items.map(activity => activity.kind)), ['join', 'done']);
});

test('Codex Stop records a boundary without reading or presenting pending attention', async t => {
  const f = await fixture(t);
  let inboxReads = 0;
  const result = await codexHookResponse(
    { session_id: 'stop-session', hook_event_name: 'Stop' },
    () => { inboxReads += 1; return []; },
    f.env,
  );
  assert.equal(result, undefined);
  assert.equal(inboxReads, 0);
  assert.equal(await codexQueueEligible('stop-session', f.env), true);
});

test('Codex boundary eligibility follows Stop, non-Stop, and SessionEnd', { concurrency: false }, async t => {
  const f = await fixture(t);
  const thread = 'boundary-thread';
  await runCodexHookAsync(JSON.stringify({ session_id: thread, hook_event_name: 'SessionStart', cwd: f.root }), f.env);
  assert.equal(await codexQueueEligible(thread, f.env), false);
  await runCodexHookAsync(JSON.stringify({ session_id: thread, hook_event_name: 'Stop' }), f.env);
  assert.equal(await codexQueueEligible(thread, f.env), true);
  await runCodexHookAsync(JSON.stringify({ session_id: thread, hook_event_name: 'PostToolUse' }), f.env);
  assert.equal(await codexQueueEligible(thread, f.env), false);
  await runCodexHookAsync(JSON.stringify({ session_id: thread, hook_event_name: 'Stop' }), f.env);
  assert.equal(await codexQueueEligible(thread, f.env), true);
  await runCodexHookAsync(JSON.stringify({ session_id: thread, hook_event_name: 'SessionEnd' }), f.env);
  assert.equal(await codexQueueEligible(thread, f.env), false);
});

test('Claude start, done and resume use only the exact latest completed body coordinate', async t => {
  const f = await fixture(t);
  const body = { channel: 'claude-code', session: 'resume-session', agent: 'child' };
  const parent = { channel: 'claude-code', session: body.session };
  const other = { channel: 'pi', session: body.session, agent: body.agent };
  const bridge = value => runClaudeMod(JSON.stringify({ sessionId: body.session, agentId: body.agent,
    cwd: f.root, version: 'test', endpoint: 'relative.sock', ...value }), f.env).then(JSON.parse);
  for (const name of ['Resume', 'Replaced']) await joinAt(f.squarePath, name, body, f.env);
  for (const [name, coordinate] of [['Parent', parent], ['Other', other]]) {
    await joinAt(f.squarePath, name, coordinate, f.env);
    const square = await Square.at({ path: f.squarePath, env: f.env, body: coordinate, participant: name });
    try { await (await square.participant()).done(); } finally { await square.close(); }
  }
  const start = await bridge({ operation: 'start' });
  assert.deepEqual(start.bindings.map(row => row.participant), ['Replaced', 'Resume']);
  const original = start.bindings.find(row => row.participant === 'Resume');
  assert.equal((await bridge({ operation: 'end', bindings: start.bindings })).retired.length, 2);
  assert.deepEqual((await bridge({ operation: 'start' })).bindings, []);
  // A later body now owns the latest completed coordinate for Replaced.
  const replacementBody = { ...body, agent: 'replacement' };
  await joinAt(f.squarePath, 'Replaced', replacementBody, f.env);
  const replacement = await Square.at({ path: f.squarePath, env: f.env, body: replacementBody, participant: 'Replaced' });
  try { await (await replacement.participant()).done(); } finally { await replacement.close(); }
  const resumed = await bridge({ operation: 'start', resume: true });
  assert.deepEqual(resumed.bindings.map(row => row.participant), ['Resume']);
  assert.notEqual(resumed.bindings[0].generation, original.generation);
  const state = await artifactFacts(f.squarePath, facts => ({
    current: facts.seatsForBody(body), completed: facts.completedSeatsForBody(body),
    parent: facts.completedSeatsForBody(parent), other: facts.completedSeatsForBody(other),
    replacement: facts.completedSeatsForBody(replacementBody),
  }));
  assert.deepEqual(state.current.map(seat => seat.participant), ['Resume']);
  assert.deepEqual(state.completed, []);
  assert.equal(state.parent[0].participant, 'Parent');
  assert.equal(state.other[0].participant, 'Other');
  assert.equal(state.replacement[0].participant, 'Replaced');
  assert.deepEqual((await bridge({ operation: 'start', resume: true })).bindings, resumed.bindings);
});

test('binding time is the establishing join and fences late same-body joins at pinned cancel/end boundaries', async t => {
  const f = await fixture(t);
  const body = { channel: 'claude-code', session: 'pinned-session' };
  const join = async (participant, at) => {
    const square = await Square.at({ path: f.squarePath, env: f.env, body, participant, clock: () => at });
    try { await square.join(participant); } finally { await square.close(); }
  };
  const bridge = value => runClaudeMod(JSON.stringify({ sessionId: body.session, cwd: f.root,
    version: 'test', endpoint: 'relative.sock', ...value }), f.env).then(JSON.parse);
  await join('Before', 1000);
  await join('After', 2000);
  await join('Before', 2500); // reconnect is not a new generation or a new binding time
  const bindings = await projectSessionSeats({ body, env: f.env });
  assert.deepEqual(bindings.map(row => [row.seat.participant, row.joinedAt]), [['After', 2000], ['Before', 1000]]);
  const cancelled = await bridge({ operation: 'cancel', bindings: [], cancelAt: 1500 });
  assert.deepEqual(cancelled.cancelledBindings.map(row => row.participant), ['Before']);
  const before = bindings.find(row => row.seat.participant === 'Before').seat;
  const after = bindings.find(row => row.seat.participant === 'After').seat;
  assert.deepEqual(await artifactFacts(f.squarePath, facts => [
    facts.cancelledThrough('Before', before.generation), facts.cancelledThrough('After', after.generation),
  ]), [0, undefined]);
  const ended = await bridge({ operation: 'end', bindings: [], endedAt: 1500 });
  assert.deepEqual(ended.retired.map(row => row.participant), ['Before']);
  await join('Before', 3000);
  const current = await projectSessionSeats({ body, env: f.env });
  assert.equal(current.find(row => row.seat.participant === 'Before').joinedAt, 3000);
  await bridge({ operation: 'cancel', bindings: cancelled.cancelledBindings,
    cancelledBindings: cancelled.cancelledBindings, cancelAt: 1500 });
  assert.deepEqual((await bridge({ operation: 'end', bindings: ended.retired, endedAt: 1500 })).retired, []);
  assert.deepEqual(await artifactFacts(f.squarePath, facts => facts.seatsForBody(body).map(seat =>
    [seat.participant, facts.cancelledThrough(seat.participant, seat.generation)])), [['After', undefined], ['Before', undefined]]);
});

test('done retires only the completing participant seat when a body holds multiple seats', async t => {
  const f = await fixture(t);
  const body = { channel: 'codex', session: 'dual-session' };
  await joinAt(f.squarePath, 'a', body, f.env);
  await joinAt(f.squarePath, 'b', body, f.env);
  const square = await Square.at({ path: f.squarePath, body, participant: 'a', env: f.env });
  try { await (await square.participant()).done(); }
  finally { await square.close(); }
  const result = await artifactFacts(f.squarePath, facts => ({
    seatA: facts.seat('a'), seatB: facts.seat('b'),
    kinds: facts.activityHeads({}, { edge: 'oldest', limit: 20 }).items.map(activity => activity.kind),
  }));
  assert.equal(result.seatA, undefined);
  assert.equal(result.seatB?.body.session, body.session);
  assert.deepEqual(result.kinds, ['join', 'join', 'done']);
});
