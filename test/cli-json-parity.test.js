import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createArtifactPort } from '../dist/artifact.js';
import { Square, inbox } from '../dist/square-api.js';
import { commandIdentity } from '../dist/cli/context.js';
import { run, testEnv, withName, withPath } from './square-cli-helpers.js';

const session = 'cli-json-parity';
const body = `codex:${session}`;

function serializable(result) {
  const { observation, ...data } = result;
  assert.equal(observation, undefined, 'the SDK oracle is data-only');
  if (data.participant && typeof data.participant.express === 'function') {
    data.participant = { name: data.participant.name };
  }
  return JSON.parse(JSON.stringify(data));
}

async function fixture(t, { hardCap = null, throttlePerMinute } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-cli-json-'));
  const file = path.join(cwd, 'SQUARE.square');
  const env = testEnv({ HOME: cwd, CODEX_HOME: path.join(cwd, 'codex'), CODEX_THREAD_ID: session,
    SQUARE_INDEX: path.join(cwd, 'index.ndjsonl'), SQUARE_NOW_MS: '90000' });
  const identity = commandIdentity(env);
  assert.deepEqual(identity.owner, body);
  const square = await Square.build({ path: file, markdown: 'JSON parity', hardCap, ...(throttlePerMinute === undefined ? {} : { throttlePerMinute }), clock: () => 90000 });
  await square.close();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  async function withSquare(operation) {
    const square = await Square.at({ path: file, clock: () => 90000 });
    try { return await operation(square); } finally { await square.close(); }
  }
  async function join(name) {
    return withSquare(square => square.join(name, { owner: body, wakeAddress: identity.wakeAddress, takeover: false, last: 10 }));
  }

  async function parity(name, args, operation, exitCode = 0) {
    // Each mutating call starts from an identical copy of the CLI artifact.
    // Filesystem discovery sees both files, so both remain in scope for inbox parity.
    const copy = path.join(cwd, 'oracle.square');
    fs.copyFileSync(file, copy);
    assert.deepEqual(fs.readFileSync(copy), fs.readFileSync(file));
    const oracle = await Square.at({ path: copy, ...(env.SQUARE_NOW_MS === undefined ? {} : { clock: () => Number(env.SQUARE_NOW_MS) }) });
    let expected;
    try { expected = serializable(await operation(oracle)); }
    finally { await oracle.close(); }
    const command = name === undefined ? withPath(file, args) : withName(file, name, args);
    const result = run([...command, '--json'], { cwd, env });
    assert.equal(result.error, undefined);
    assert.equal(result.status, exitCode, result.stderr + result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`, 'one exact JSON document with a newline');
    return expected;
  }
  return { cwd, file, env, parity, withSquare, join, wakeAddress: identity.wakeAddress };
}

test('each CLI --json result is the real SDK receipt from the same artifact state', async t => {
  const f = await fixture(t);

  await t.test('join', async () => {
    const joined = await f.parity('Alice', ['join', '--last', '4'], square => square.join('Alice', { owner: body, wakeAddress: f.wakeAddress, last: 4, takeover: false }));
    assert.deepEqual(joined.participant, { name: 'Alice' });
  });
  // Seed Bob and Alice's listening relation through the SDK.
  await f.join('Bob');
  await f.withSquare(async square => (await square.participant('Alice', { owner: body })).listen('Bob'));

  let sent;
  await t.test('express preserves SDK warnings, hint, metadata and reply', async () => {
    const metadata = { observation: { nested: true }, participant: { name: 'not a handle', express: 'literal' } };
    sent = await f.parity('Alice', ['express', '--force', '--mention', 'Nobody', '--reply', 'act/1', '--metadata', JSON.stringify(metadata), 'Hello @Bob @Nobody'],
      async square => (await square.participant('Alice', { owner: body })).express('Hello @Bob @Nobody', { force: true, mentions: ['Nobody'], reply: 'act/1', metadata }));
    assert.deepEqual(sent.activity.metadata, metadata);
    assert.deepEqual(sent.unmatchedMentions, ['Nobody']);
    assert.equal(sent.activity.reply, 'act/1');
    assert.ok(sent.hint);
  });
  await t.test('perceive retains perception, route and consumption receipt', async () => {
    const perceived = await f.parity('Bob', ['perceive', '--limit', '2'], async square => (await square.participant('Bob', { owner: body })).perceive({ limit: 2 }));
    assert.equal(perceived.activities[0].id, sent.activity.id);
    assert.equal(perceived.activities[0].perception, 'full');
    assert.equal(perceived.activities[0].via, 'mention');
  });
  await t.test('history includes listener target and all canonical fields', async () => {
    const history = await f.parity(undefined, ['history', '--limit', '100'], square => square.history({ limit: 100 }));
    assert.equal(history.activities.find(activity => activity.kind === 'listen').target, 'Bob');
    assert.deepEqual(history.activities.find(activity => activity.id === sent.activity.id).metadata, sent.activity.metadata);
  });
  await t.test('inbox is the standalone SDK result on the same discovery and artifact state', async () => {
    const expected = serializable(await inbox({ cwd: f.cwd }, body, { limit: 1 }));
    const result = run(['inbox', '--for-owner', body, '--limit', '1', '--json'], { cwd: f.cwd, env: f.env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  });
});

test('perceive --json retains the terminal failure exit code and the SDK result', async t => {
  const f = await fixture(t, { hardCap: 1 });
  await f.join('Alice');
  await f.join('Bob');
  await f.withSquare(async square => (await square.participant('Alice', { owner: body })).express('one', { force: true }));
  const result = await f.parity('Alice', ['perceive'], async square => (await square.participant('Alice', { owner: body })).perceive({ limit: 10 }), 1);
  assert.equal(result.reason, 'capped');
});

test('a throttled waiting express leaves stdout as one JSON document', async t => {
  const f = await fixture(t, { throttlePerMinute: 1 });
  await f.join('Alice');
  const artifact = createArtifactPort(f.file);
  try {
    const seat = (await artifact.read(facts => facts.seat('Alice'))).value;
    await artifact.transactAs({ kind: 'participant', seat }, facts =>
      facts.land({ kind: 'say', actor: 'Alice', at: Date.now() - 58_000, body: 'first', mentions: [] }));
  } finally { await artifact.close(); }
  const env = { ...f.env };
  delete env.SQUARE_NOW_MS;
  const result = run(withName(f.file, 'Alice', ['express', '--json', 'patient']), { cwd: f.cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.activity.body, 'patient');
  assert.equal(result.stdout, `${JSON.stringify(receipt)}\n`);
  assert.match(result.stderr, /your activity is waiting/, 'throttle progress stays off JSON stdout');
});

test('an active perceive keeps its exit code and JSON receipt without disrupting the waiter', async t => {
  const f = await fixture(t);
  await f.join('Alice');
  const square = await Square.at({ path: f.file });
  const alice = await square.participant('Alice', { owner: body }), controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const waiting = alice.perceive({ idle: 60_000 }, { signal: controller.signal, onProgress: started });
  try {
    await ready;
    const expected = serializable(await alice.perceive({ idle: 60_000, limit: 10 }));
    const result = run(withName(f.file, 'Alice', ['perceive', '--idle', '1m', '--json']), { cwd: f.cwd, env: f.env });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(expected.reason, 'already-active');
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  } finally {
    controller.abort(new Error('test finished'));
    await assert.rejects(waiting, /test finished/);
    await square.close();
  }
});

test('JSON mode retains human argument errors and exit codes', async t => {
  const f = await fixture(t);
  const paired = ['history', '--limit', '101'];
  const human = run(withName(f.file, 'Alice', paired), { cwd: f.cwd, env: f.env });
  const json = run(withName(f.file, 'Alice', [...paired, '--json']), { cwd: f.cwd, env: f.env });
  assert.equal(json.status, human.status);
  assert.equal(json.status, 2);
  assert.equal(json.stderr, human.stderr);
  assert.equal(json.stdout, human.stdout);
  // A JSON switch cannot become invisible to a preceding value-taking option.
  const result = run(withName(f.file, 'Alice', ['join', '--last', '--json', '10']), { cwd: f.cwd, env: f.env });
  assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /missing value|needs a positive integer|invalid arguments/);
});
