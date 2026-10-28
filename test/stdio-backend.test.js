import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Square, squareLocation, diagnoseSquare, migrateSquare, discover } from '../dist/square-api.js';
import { createSquareMcpServer } from '../dist/mcp.js';
import { createArtifactPort, createSquareFile } from '../dist/artifact.js';
import { displayPath, participantCommandPrefix } from '../dist/presentation.js';

const server = path.resolve(import.meta.dirname, '../dist/stdio-server.js');
const fixtureServer = path.resolve(import.meta.dirname, 'fixtures/stdio-backend-process.js');
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-stdio-'));
  const root = path.join(cwd, 'artifacts');
  const env = { ...process.env, HOME: cwd,
    SQUARE_BACKENDS_CONFIG: undefined, SQUARE_LOCATION: undefined, SQUARE_PARTICIPANT_NAME: '',
    SQUARE_NOW_MS: undefined, NO_COLOR: '1' };
  const backends = { local: { command: process.execPath, args: [server, '--root', root],
    // Backend startup identity must not override the call-local native coordinates.
    env: { CLAUDE_CODE_SESSION_ID: 'startup-claude', PI_SESSION_ID: 'startup-pi', PASEO_AGENT_ID: 'startup-paseo', SQUARE_PARTICIPANT_NAME: 'Startup' } } };
  const input = { cwd, env, backends, path: 'stdio://local/discussion' };
  const resources = [];
  t.after(async () => { await Promise.all(resources.map(square => square.close())); fs.rmSync(cwd, { recursive: true, force: true }); });
  const open = async (extra = {}) => {
    const square = await Square.at({ ...input, env: { ...env, CODEX_THREAD_ID: '' }, ...extra });
    resources.push(square);
    return square;
  };
  const cli = (args, extraEnv = {}) => spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../dist/square.js'), '--location', input.path,
    ...args], { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 8000 });
  return { cwd, root, env, input, resources, open, cli };
}
function assertDead(pid) { assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH'); }

async function seedArtifact(location, env, markdown, body, participant, activity) {
  const square = await Square.build({ path: location, env, markdown, body, participant });
  try {
    const joined = await square.join(participant);
    if (activity !== undefined) await joined.participant.express(activity, { force: true });
  } finally { await square.close(); }
}

test('stdio clients and the real CLI read the same artifact history without consuming it', async t => {
  const f = fixture(t);
  const artifactPath = path.join(f.root, 'discussion.square');
  const body = { channel: 'codex', session: 'artifact-seed' };
  await seedArtifact(artifactPath, f.env, 'A shared backend square', body, 'Alice', 'one artifact-shared activity');

  const square = await f.open();
  assert.equal(square.location, f.input.path);
  const history = await square.history({ observe: true });
  assert.equal(history.activities.some(activity => activity.body === 'one artifact-shared activity'), true);
  assert.equal(history.observation.location, f.input.path);
  await assert.rejects(square.history({ limit: Infinity }), error => error.code === 'invalid_args');
  assert.deepEqual((await square.history({ limit: null })).activities, history.activities, 'explicit null reads the full archive');
  assert.deepEqual((await square.history({ observe: true })).activities, history.activities, 'history is nonconsuming');

  const config = path.join(f.cwd, 'backends.json');
  fs.writeFileSync(config, JSON.stringify({ backends: f.input.backends }));
  const cliEnv = { SQUARE_BACKENDS_CONFIG: './backends.json' };
  const cliHistory = f.cli(['history', '--limit', '10'], cliEnv);
  assert.equal(cliHistory.status, 0, cliHistory.stderr);
  assert.match(cliHistory.stdout, /one artifact-shared activity/);
  assert.equal(fs.existsSync(path.join(f.cwd, 'stdio:')), false);
  assert.equal(displayPath(f.input.path), f.input.path);
  assert.match(participantCommandPrefix(f.input.path, 'Alice'), /--location 'stdio:\/\/local\/discussion'/);
  assert.match(f.cli(['stream'], cliEnv).stderr, /--location 'stdio:\/\/local\/discussion'/);

  const artifact = createArtifactPort(artifactPath);
  try {
    assert.deepEqual((await artifact.read(facts => facts.seatsForBody(body))).value.map(seat => seat.participant), ['Alice']);
    assert.equal((await artifact.read(facts => facts.seatsForBody({ channel: 'pi', session: 'startup-pi' }))).value.length, 0);
  } finally { await artifact.close(); }
});

test('stdio CLI JSON serializes the real SDK result, including the remote participant handle', async t => {
  const f = fixture(t), session = 'stdio-json-parity';
  const env = { ...f.env, CODEX_THREAD_ID: session, SQUARE_NOW_MS: '1000' };
  const body = { channel: 'codex', session };
  const file = path.join(f.root, 'discussion.square'), copy = path.join(f.root, 'oracle.square');
  fs.mkdirSync(f.root, { recursive: true });
  const built = await Square.build({ path: file, env, body, markdown: 'stdio JSON' });
  await built.close();
  const config = path.join(f.cwd, 'backends.json');
  fs.writeFileSync(config, JSON.stringify({ backends: f.input.backends }));
  const cliEnv = { ...env, SQUARE_BACKENDS_CONFIG: config };
  async function parity(args, call) {
    fs.copyFileSync(file, copy);
    const oracle = await Square.at({ ...f.input, path: 'stdio://local/oracle', env, body });
    let expected;
    try {
      const { observation, ...result } = await call(oracle);
      assert.equal(observation, undefined);
      if (result.participant) result.participant = { name: result.participant.name };
      expected = JSON.parse(JSON.stringify(result));
    } finally { await oracle.close(); }
    const actual = f.cli([...args, '--json'], cliEnv);
    assert.equal(actual.status, 0, actual.stderr);
    assert.deepEqual(JSON.parse(actual.stdout), expected);
    assert.equal(actual.stdout, `${JSON.stringify(expected)}\n`);
    return expected;
  }
  assert.deepEqual((await parity(['--as', 'Alice', 'join'], square => square.join('Alice', { last: 10, takeover: false }))).participant, { name: 'Alice' });
  await parity(['--as', 'Bob', 'join'], square => square.join('Bob', { last: 10, takeover: false }));
  await parity(['--as', 'Alice', 'listen', 'Bob'], async square => (await square.participant('Alice')).listen('Bob'));
  await parity(['--as', 'Bob', 'express', '--force', 'hello @Alice'], async square => (await square.participant('Bob')).express('hello @Alice', { force: true }));
  await parity(['--as', 'Alice', 'catch'], async square => (await square.participant('Alice')).catch({ limit: 10 }));
  const history = await parity(['history'], square => square.history());
  assert.equal(history.activities.find(activity => activity.kind === 'listen').target, 'Bob');
});

test('stdio status retains a historical actorless hold with or without observation', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.root, { recursive: true });
  await createSquareFile(path.join(f.root, 'discussion.square'), {
    hardCap: null, preamble: [], warmup: [],
    acts: [{ kind: 'hold', index: 0, at: 5, body: 'historical pause' }],
    runtime: { nextActIndex: 1, observations: {}, leases: {} },
  });
  const square = await f.open();
  const status = await square.status();
  assert.deepEqual(status.held, { reason: 'historical pause', at: 5 });
  const observed = await square.status({ observe: true });
  assert.deepEqual(observed.held, status.held);
});

test('stdio open carries the exact typed Body for remote join and express while body-less history stays readable', async t => {
  const f = fixture(t);
  const artifactPath = path.join(f.root, 'discussion.square');
  const body = { channel: 'stdio-channel', session: 'stdio-session', agent: 'worker/one' };
  const square = await Square.build({ ...f.input, body, participant: 'Remote', markdown: 'remote body test' });
  f.resources.push(square);
  const joined = await square.join('Remote');
  await joined.participant.express('written through the remote backend');
  const artifact = createArtifactPort(artifactPath);
  try {
    assert.deepEqual((await artifact.read(facts => facts.seat('Remote'))).value.body, body);
    assert.equal((await artifact.read(facts => facts.activity(1))).value.body, 'written through the remote backend');
  } finally { await artifact.close(); }

  const bodyless = await f.open();
  const history = await bodyless.history();
  assert.equal(history.activities.some(activity => activity.body === 'written through the remote backend'), true);
});

test('MCP location overrides the configured resource for read-only backend calls', async t => {
  const f = fixture(t);
  const artifactPath = path.join(f.root, 'discussion.square');
  await seedArtifact(artifactPath, f.env, 'backend', { channel: 'codex', session: 'seed' }, 'Mcp', 'activity in the backend artifact');
  const localPath = path.join(f.cwd, 'configured.square');
  const local = await Square.build({ path: localPath, env: f.env, markdown: 'local' });
  const server = createSquareMcpServer({ ...f.input, path: localPath, env: { ...f.env, CODEX_THREAD_ID: 'startup' } });
  const client = new Client({ name: 'stdio-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right), client.connect(left)]);
  t.after(async () => { await client.close(); await server.close(); await local.close(); });
  const call = async args => {
    const result = await client.callTool({ name: 'history', arguments: args, _meta: { threadId: 'mcp-call' } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent, undefined);
    return result.content[0].text;
  };
  const remoteHistory = await call({ location: f.input.path });
  assert.match(remoteHistory, /activity in the backend artifact/);
  assert.doesNotMatch(await call({}), /activity in the backend artifact/);
  assert.deepEqual((await local.participants()).participants, []);
});

test('cancelling a blocked history read leaves another backend request usable', async t => {
  const f = fixture(t);
  const artifactPath = path.join(f.root, 'discussion.square');
  await seedArtifact(artifactPath, f.env, 'cancellation', { channel: 'codex', session: 'seed' }, 'Alice');
  const square = await f.open();
  const database = new DatabaseSync(artifactPath);
  database.exec('BEGIN EXCLUSIVE');
  const controller = new AbortController();
  const waiting = square.history({}, { signal: controller.signal });
  const rejected = assert.rejects(waiting, /aborted|cancel/i);
  const status = square.status();
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.abort(new Error('cancel history'));
    await rejected;
  } finally {
    database.exec('ROLLBACK');
    database.close();
  }
  const result = await status;
  assert.deepEqual(result.participants.map(participant => [participant.name, participant.presence]), [['Alice', 'active']]);
  await square.close();
});

test('configuration and URI refusals never treat backend locations as paths', async t => {
  const f = fixture(t);
  assert.equal(squareLocation({ ...f.input, path: 'stdio://local/hello%20world' }), 'stdio://local/hello%20world');
  for (const location of ['slack://workspace/key', 'stdio://user@local/key', 'stdio://local/key?x', 'stdio://local/%2Fescape', 'stdio://local/../escape'])
    assert.throws(() => squareLocation({ ...f.input, path: location }), error => error.code === 'invalid_args');
  await assert.rejects(Square.at({ ...f.input, backends: {} }), /not configured/);
  await assert.rejects(Square.at({ ...f.input, backends: undefined, env: { ...f.env, SQUARE_BACKENDS_CONFIG: './missing.json' } }), error => error.code === 'invalid_args');
  const invalid = path.join(f.cwd, 'bad.json'); fs.writeFileSync(invalid, '{');
  await assert.rejects(Square.at({ ...f.input, backends: undefined, env: { ...f.env, SQUARE_BACKENDS_CONFIG: invalid } }), error => error.code === 'invalid_args');
  const local = await Square.build({ path: path.join(f.cwd, 'local.square'), markdown: '', env: f.env }); f.resources.push(local);
  for (const operation of [diagnoseSquare, migrateSquare, discover])
    assert.throws(() => operation(f.input), /local square artifact/);
  assert.equal(fs.existsSync(path.join(f.cwd, 'stdio:')), false);
  fs.mkdirSync(f.root, { recursive: true });
  fs.symlinkSync(path.join(f.cwd, 'local.square'), path.join(f.root, 'escape.square'));
  await assert.rejects(f.open({ path: 'stdio://local/escape' }), /escapes/);
});

test('protocol mismatch, malformed output and lost express response settle without replay or leaked children', async t => {
  const f = fixture(t);
  for (const mode of ['version', 'malformed', 'lost']) {
    const marker = path.join(f.cwd, `${mode}.pid`), log = path.join(f.cwd, `${mode}.log`);
    const input = { ...f.input, backends: { local: { command: process.execPath, args: [fixtureServer, mode, log, marker] } } };
    if (mode !== 'lost') await assert.rejects(Square.at(input), /protocol|Malformed/);
    else {
      const square = await Square.at(input); f.resources.push(square);
      const participant = await square.participant('Alice');
      await assert.rejects(participant.express('once'), error => error.code === 'unavailable' && error.operation.expressEffect === 'unknown');
      await square.close();
      assert.equal(fs.readFileSync(log, 'utf8'), 'express\n');
    }
    assertDead(Number(fs.readFileSync(marker, 'utf8')));
  }
});

test('close is bounded even when the child ignores close and SIGTERM, and settles pending requests', async t => {
  const f = fixture(t), marker = path.join(f.cwd, 'stubborn.pid');
  const square = await Square.at({ ...f.input, backends: { local: { command: process.execPath, args: [fixtureServer, 'stubborn', '', marker] } } });
  f.resources.push(square);
  const pending = assert.rejects(square.history(), /timed out|closed/);
  await square.close(); await pending; await square.close();
  assertDead(Number(fs.readFileSync(marker, 'utf8')));
});

test('stdio join refuses an omitted or blank name before touching the backend artifact', async t => {
  const f = fixture(t);
  const artifactPath = path.join(f.root, 'discussion.square');
  await seedArtifact(artifactPath, f.env, 'explicit join', { channel: 'codex', session: 'explicit-seed' }, 'Alice');
  const square = await f.open({ body: { channel: 'codex', session: 'explicit-join' }, participant: 'Defaulted' });
  const before = (await square.history({ limit: null })).activities.length;
  await assert.rejects(square.join(), { code: 'invalid_args' });
  await assert.rejects(square.join(''), { code: 'invalid_name' });
  assert.equal((await square.history({ limit: null })).activities.length, before, 'refused joins leave no activity');
  const joined = await square.join('Bob');
  assert.equal(joined.kind, 'joined');
  assert.equal(joined.participant.name, 'Bob');
});

test('stdio deferrals preserve scalar matches, independent ids, cancellation and captured generation ownership', async t => {
  const f = fixture(t);
  const artifactPath = path.join(f.root, 'discussion.square');
  const body = { channel: 'test', session: 'stdio-owner' };
  await seedArtifact(artifactPath, f.env, 'deferrals', body, 'Alice');
  const square = await f.open({ body });
  const alice = await square.participant('Alice');
  const match = { fields: [{ path: ['job', 'kind'], equals: 'outcome' }, { path: ['job', 'id'], equals: 7 }] };
  const first = await alice.deferDelivery({ match, durationMs: 60000 });
  const second = await alice.deferDelivery({ match, durationMs: 60000 });
  assert.notEqual(first.id, second.id);
  assert.equal(typeof first.expiresAt, 'string');
  assert.deepEqual(Object.keys(first).sort(), ['expiresAt', 'id']);
  const artifact = createArtifactPort(artifactPath);
  try {
    const stored = (await artifact.read(facts => { const seat = facts.seat('Alice'); return facts.deliveryDeferrals('Alice', seat.generation); })).value;
    assert.deepEqual(stored.map(lease => lease.match), [match, match]);
    assert.equal(stored.length, 2);
  } finally { await artifact.close(); }
  assert.equal(await alice.releaseDeliveryDeferral(first.id), true);
  assert.equal(await alice.releaseDeliveryDeferral(first.id), false);
  assert.equal(await alice.renewDeliveryDeferral(first.id, 10), null);
  assert.ok(await alice.renewDeliveryDeferral(second.id, 60000));
  await assert.rejects(alice.deferDelivery({ match: { fields: [{ path: ['x'], equals: undefined }] }, durationMs: 10 }), { code: 'invalid_args' });
  await assert.rejects(alice.renewDeliveryDeferral(second.id, Infinity), { code: 'invalid_args' });
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(alice.releaseDeliveryDeferral(second.id, { signal: aborted.signal }));
  assert.ok(await alice.renewDeliveryDeferral(second.id, 60000), 'aborting before dispatch leaves the lease live');
  const foreign = await f.open({ body: { channel: 'test', session: 'other' } });
  await assert.rejects((await foreign.participant('Alice')).releaseDeliveryDeferral(second.id), { code: 'already_joined' });
  await alice.done();
  const rejoined = (await square.join('Alice')).participant;
  await assert.rejects(alice.deferDelivery({ match, durationMs: 100 }), { code: 'already_joined' });
  await assert.rejects(alice.renewDeliveryDeferral(second.id, 100), { code: 'already_joined' });
  await assert.rejects(alice.releaseDeliveryDeferral(second.id), { code: 'already_joined' });
  assert.equal(await rejoined.releaseDeliveryDeferral(second.id), false);
});

async function contractSquare(t, backend, hardCap = null) {
  const f = fixture(t);
  const body = { channel: 'test', session: 'sdk-parity' };
  const input = backend === 'stdio' ? f.input : { ...f.input, path: path.join(f.cwd, 'local.square') };
  const square = await Square.build({ ...input, body, markdown: 'activity contract', hardCap });
  f.resources.push(square);
  return square;
}

function canonical(activity, perceived = false) {
  const allowed = new Set(['id', 'at', 'kind', 'actor', 'body', 'metadata', 'mentions', 'reach', 'target', 'reply',
    ...(perceived ? ['perception', 'via'] : [])]);
  assert.match(activity.id, /^act\/\d+$/);
  assert.equal(typeof activity.at, 'number');
  assert.equal(typeof activity.actor, 'string');
  assert.ok(Array.isArray(activity.mentions));
  for (const key of Object.keys(activity)) assert.ok(allowed.has(key), `unexpected activity field ${key}`);
  if (perceived) assert.ok(['full', 'presence'].includes(activity.perception));
}

async function take(iterator, count) {
  const items = [];
  for (let index = 0; index < count; index++) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    items.push(next.value);
  }
  await iterator.return();
  return items;
}

for (const backend of ['sqlite', 'stdio']) {
  test(`${backend}: SDK operations and streams share canonical activities and landed routes`, { timeout: 10000 }, async t => {
    const square = await contractSquare(t, backend);
    const joined = await square.join('Alice');
    assert.deepEqual(Object.keys(joined).sort(), ['activity', 'kind', 'participant']);
    canonical(joined.activity);
    const reconnected = await square.join('Alice');
    assert.equal(reconnected.kind, 'reconnected');
    assert.equal(reconnected.activity, null);
    assert.equal(Object.hasOwn(reconnected, 'participantCount'), false);
    const alice = joined.participant, bob = (await square.join('Bob')).participant;
    await square.join('Cara');
    const held = await alice.hold('pause');
    assert.deepEqual(Object.keys(held), ['activity']);
    canonical(held.activity);
    const status = await square.status();
    assert.deepEqual(status.held.by, 'Alice');
    for (const key of ['hold', 'activeCount', 'doneCount']) assert.equal(Object.hasOwn(status, key), false);
    for (const person of (await square.participants()).participants) assert.equal(Object.hasOwn(person, 'state'), false);
    canonical((await alice.resume()).activity);
    assert.equal((await square.status()).held, null);

    const mention = await alice.express('hello @Bob', { force: true });
    for (const key of ['delivery', 'waited']) assert.equal(Object.hasOwn(mention, key), false);
    canonical(mention.activity);
    const question = await bob.express('question for Alice', { force: true, mentions: ['Alice'] });
    const reply = await alice.express('answer', { force: true, noMention: true, reply: question.activity.id });
    const listening = await bob.listen('Alice');
    canonical(listening.activity);
    assert.equal((await bob.listen('Alice')).activity, null);
    const attention = await alice.express({ body: 'heard by listening', metadata: { nested: { value: 3 } }, force: true });
    const bell = await alice.express('bell', { force: true, reach: 'bell' });
    const expected = [mention.activity, reply.activity, attention.activity, bell.activity];
    const caught = await bob.catch();
    assert.equal(caught.reason, 'drained');
    for (const key of ['consumedThrough', 'idleExpired', 'status']) assert.equal(Object.hasOwn(caught, key), false);
    assert.deepEqual(caught.activities, expected.map((activity, index) => ({ ...activity, perception: 'full', via: ['mention', 'reply', 'attention', 'bell'][index] })));
    caught.activities.forEach(activity => canonical(activity, true));

    const directed = square.stream({ recipient: 'Bob', start: { kind: 'tail', last: 4 } }, { signal: AbortSignal.timeout(3000) })[Symbol.asyncIterator]();
    assert.deepEqual(await take(directed, 4), caught.activities);
    const history = (await square.history({ limit: null })).activities;
    history.forEach(activity => canonical(activity));
    const stream = square.stream({ start: { kind: 'tail', last: 100 } }, { signal: AbortSignal.timeout(3000) })[Symbol.asyncIterator]();
    assert.deepEqual(await take(stream, history.length), history);
    const following = square.stream({ start: { kind: 'after', after: mention.activity.id } }, { signal: AbortSignal.timeout(3000) })[Symbol.asyncIterator]();
    const after = history.filter(activity => Number(activity.id.slice(4)) > Number(mention.activity.id.slice(4)));
    assert.deepEqual(await take(following, after.length), after);
    canonical((await bob.unlisten('Alice')).activity);
    canonical((await bob.ignore('Alice')).activity);
    const done = await bob.done();
    assert.deepEqual(Object.keys(done), ['activity']);
    canonical(done.activity);
    const late = await alice.express('late reply', { force: true, reply: question.activity.id });
    assert.equal(late.replyAuthorNotHere, 'Bob');
    canonical(late.activity);
  });

  test(`${backend}: catch returns each stop reason through the real SDK`, { timeout: 10000 }, async t => {
    const square = await contractSquare(t, backend);
    const alice = (await square.join('Alice')).participant, bob = (await square.join('Bob')).participant;
    const cara = (await square.join('Cara')).participant;
    assert.equal((await alice.catch()).reason, 'drained');
    assert.equal((await alice.catch({ idle: 20 })).reason, 'idle');

    let startFirst, startReplacement;
    const firstStarted = new Promise(resolve => { startFirst = resolve; });
    const replacementStarted = new Promise(resolve => { startReplacement = resolve; });
    const first = alice.catch({ idle: 10_000 }, { onProgress: progress => { if (progress.kind === 'catch-started') startFirst(); } });
    await firstStarted;
    assert.equal((await alice.catch({ idle: 10_000 })).reason, 'already-active');
    const controller = new AbortController();
    const replacement = alice.catch({ idle: 10_000, replace: true }, { signal: controller.signal,
      onProgress: progress => { if (progress.kind === 'catch-started') startReplacement(); } });
    const cancelled = assert.rejects(replacement);
    await replacementStarted;
    assert.equal((await first).reason, 'replaced');
    controller.abort();
    await cancelled;
    await bob.done(); await cara.done();
    assert.equal((await alice.catch()).reason, 'quorum');

    const cappedSquare = await contractSquare(t, backend, 1);
    const capped = (await cappedSquare.join('Capped')).participant;
    await cappedSquare.join('Peer');
    await capped.express('one', { force: true });
    assert.equal((await capped.catch()).reason, 'capped');
  });
}

test('stdio streams cancel outstanding pulls and leave the connection usable', { timeout: 10000 }, async t => {
  const square = await contractSquare(t, 'stdio');
  await square.join('Alice');
  const iterator = square.stream({ start: { kind: 'tail', last: 1 } })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.kind, 'join');
  const waiting = iterator.next();
  await Promise.resolve();
  assert.equal((await square.status()).participants[0].name, 'Alice', 'other requests run while a pull waits');
  assert.deepEqual(await iterator.return(), { done: true, value: undefined });
  assert.deepEqual(await waiting, { done: true, value: undefined });
  assert.equal((await square.status()).participants[0].name, 'Alice');

  const abort = new AbortController();
  const second = square.stream({ start: { kind: 'tail', last: 1 } }, { signal: abort.signal })[Symbol.asyncIterator]();
  assert.equal((await second.next()).value.kind, 'join');
  const pending = second.next();
  const rejected = assert.rejects(pending, /cancelled by caller/);
  await Promise.resolve();
  await square.status();
  abort.abort(new Error('cancelled by caller'));
  await rejected;
  await second.return();
  assert.equal((await square.status()).participants[0].name, 'Alice');
});

for (const backend of ['sqlite', 'stdio']) {
  test(`${backend}: CLI ndjson stream remains usable with canonical recipient records`, { timeout: 10000 }, async t => {
    const f = fixture(t), body = { channel: 'test', session: 'stream-cli' };
    const input = backend === 'stdio' ? f.input : { ...f.input, path: path.join(f.cwd, 'cli.square') };
    const square = await Square.build({ ...input, body, markdown: '' });
    f.resources.push(square);
    const alice = (await square.join('Alice')).participant;
    const bobJoin = await square.join('Bob');
    const sent = await alice.express('hello @Bob', { force: true });
    const config = path.join(f.cwd, 'backends.json');
    fs.writeFileSync(config, JSON.stringify({ backends: f.input.backends }));
    const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../dist/square.js'), '--location', input.path,
      'stream', '--ndjson', '--for', 'Bob', '--after', bobJoin.activity.id], {
      cwd: f.cwd, env: { ...f.env, SQUARE_BACKENDS_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    const [line] = await once(lines, 'line');
    assert.deepEqual(JSON.parse(line), { ...sent.activity, perception: 'full', via: 'mention' });
    child.kill('SIGINT');
    assert.equal((await once(child, 'close'))[0], 130);
  });
}

test('stdio server refuses an older protocol peer', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, [server, '--root', f.root], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const reply = once(lines, 'line');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'square/open', params: {
    version: 2, key: 'discussion', location: 'stdio://local/discussion', identity: {},
  } }) + '\n');
  const [line] = await reply;
  assert.match(JSON.parse(line).error.message, /protocol version/);
  child.stdin.end();
  await once(child, 'close');
});
