import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { Square, inbox } from '../dist/square-api.js';
import { commandIdentity } from '../dist/cli/context.js';
import { CLI, run, testEnv, withName, withPath } from './square-cli-helpers.js';

const traceModule = path.resolve(import.meta.dirname, 'fixtures/cli-json-trace.js');
const session = 'cli-json-parity';
const body = { channel: 'codex', session };

function serializable(result) {
  const { observation, ...data } = result;
  assert.equal(observation, undefined, 'the SDK oracle is data-only');
  if (data.participant && typeof data.participant.express === 'function') {
    data.participant = { name: data.participant.name };
  }
  return JSON.parse(JSON.stringify(data));
}

async function fixture(t, hardCap = null) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-cli-json-'));
  const file = path.join(cwd, 'SQUARE.square');
  const trace = path.join(cwd, 'trace.ndjson');
  const env = testEnv({ HOME: cwd, CODEX_HOME: path.join(cwd, 'codex'), CODEX_THREAD_ID: session,
    SQUARE_INDEX: path.join(cwd, 'index.ndjsonl'), SQUARE_NOW_MS: '90000',
    NODE_OPTIONS: `--import=${traceModule}`, SQUARE_JSON_TRACE: trace });
  const identity = commandIdentity(env);
  assert.deepEqual(identity.body, body);
  const square = await Square.build({ path: file, markdown: 'JSON parity', hardCap, env });
  await square.close();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  async function parity(name, args, operation, exitCode = 0) {
    // Each mutating call starts from an identical copy of the CLI artifact. The SDK
    // oracle's independent discovery index cannot perturb the CLI artifact or inbox.
    const copy = path.join(cwd, 'oracle.square');
    fs.copyFileSync(file, copy);
    assert.deepEqual(fs.readFileSync(copy), fs.readFileSync(file));
    const oracle = await Square.at({ path: copy, env: { ...env, SQUARE_INDEX: path.join(cwd, 'oracle-index') } });
    let expected;
    try { expected = serializable(await operation(oracle)); }
    finally { await oracle.close(); }
    fs.writeFileSync(trace, '');
    const command = name === undefined ? withPath(file, args) : withName(file, name, args);
    const result = run([...command, '--json'], { cwd, env });
    assert.equal(result.error, undefined);
    assert.equal(result.status, exitCode, result.stderr + result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`, 'one exact JSON document with a newline');
    const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.map(call => call.method), [args[0]]);
    assert.equal(Object.hasOwn(calls[0].options ?? {}, 'observe'), false, 'CLI must not request presentation enrichment');
    return expected;
  }
  return { cwd, file, env, trace, parity, wakeAddress: identity.wakeAddress };
}

test('each CLI --json result is the real SDK receipt from the same artifact state', async t => {
  const f = await fixture(t);

  await t.test('empty history', async () => {
    assert.deepEqual(await f.parity(undefined, ['history'], square => square.history()), { activities: [] });
  });
  await t.test('join and reconnect', async () => {
    const joined = await f.parity('Alice', ['join', '--json', '--last', '4'], square => square.join('Alice', { body, wakeAddress: f.wakeAddress, last: 4, takeover: false }));
    assert.deepEqual(joined.participant, { name: 'Alice' });
    const reconnected = await f.parity('Alice', ['join'], square => square.join('Alice', { body, wakeAddress: f.wakeAddress, last: 10, takeover: false }));
    assert.equal(reconnected.kind, 'reconnected');
    assert.equal(reconnected.activity, null);
    await f.parity('Bob', ['join'], square => square.join('Bob', { body, wakeAddress: f.wakeAddress, last: 10, takeover: false }));
  });
  await t.test('listen and listening', async () => {
    const listened = await f.parity('Alice', ['listen', 'Bob'], async square => (await square.participant('Alice', { body })).listen('Bob'));
    assert.equal(listened.activity.target, 'Bob');
    assert.equal((await f.parity('Alice', ['listen', 'Bob'], async square => (await square.participant('Alice', { body })).listen('Bob'))).activity, null);
    assert.deepEqual((await f.parity('Alice', ['listening'], async square => (await square.participant('Alice', { body })).listening())).listening, ['Bob']);
  });
  let sent;
  await t.test('express preserves SDK warnings, hint, metadata and reply', async () => {
    const metadata = { observation: { nested: true }, participant: { name: 'not a handle', express: 'literal' } };
    sent = await f.parity('Alice', ['express', '--force', '--reply', 'act/1', '--metadata', JSON.stringify(metadata), 'Hello @Bob @Nobody'],
      async square => (await square.participant('Alice', { body })).express('Hello @Bob @Nobody', { force: true, reply: 'act/1', metadata }));
    assert.deepEqual(sent.activity.metadata, metadata);
    assert.deepEqual(sent.unmatchedMentions, ['Nobody']);
    assert.equal(sent.activity.reply, 'act/1');
    assert.ok(sent.hint);
  });
  await t.test('catch retains perception, route and consumption receipt', async () => {
    const caught = await f.parity('Bob', ['catch', '--now', '--limit', '2'], async square => (await square.participant('Bob', { body })).catch({ limit: 2 }));
    assert.equal(caught.activities[0].id, sent.activity.id);
    assert.equal(caught.activities[0].perception, 'full');
    assert.equal(caught.activities[0].via, 'mention');
    const exact = await f.parity('Bob', ['catch', '--id', sent.activity.id], async square => (await square.participant('Bob', { body })).catch({ id: sent.activity.id }));
    assert.equal(exact.activities[0].id, sent.activity.id);
  });
  await t.test('history includes listener target and all canonical fields', async () => {
    const history = await f.parity(undefined, ['history', '--limit', '100'], square => square.history({ limit: 100 }));
    assert.equal(history.activities.find(activity => activity.kind === 'listen').target, 'Bob');
    assert.deepEqual(history.activities.find(activity => activity.id === sent.activity.id).metadata, sent.activity.metadata);
  });
  await t.test('unlisten and ignore include null for unchanged relations', async () => {
    const removed = await f.parity('Alice', ['unlisten', 'Bob'], async square => (await square.participant('Alice', { body })).unlisten('Bob'));
    assert.equal(removed.activity.target, 'Bob');
    assert.equal((await f.parity('Alice', ['unlisten', 'Bob'], async square => (await square.participant('Alice', { body })).unlisten('Bob'))).activity, null);
    const ignored = await f.parity('Alice', ['ignore', 'Bob'], async square => (await square.participant('Alice', { body })).ignore('Bob'));
    assert.equal(ignored.activity.target, 'Bob');
    assert.equal((await f.parity('Alice', ['ignore', 'Bob'], async square => (await square.participant('Alice', { body })).ignore('Bob'))).activity, null);
  });
  await t.test('hold, status, participants, resume and done', async () => {
    await f.parity('Bob', ['hold', 'pause'], async square => (await square.participant('Bob', { body })).hold('pause'));
    const status = await f.parity('Alice', ['status'], square => square.status({ viewer: 'Alice' }));
    assert.equal(status.held.by, 'Bob');
    const roster = await f.parity(undefined, ['participants', '--limit', '1'], square => square.participants());
    assert.equal(roster.participants.length, 2, '--limit affects human text only');
    await f.parity('Bob', ['resume'], async square => (await square.participant('Bob', { body })).resume());
    await f.parity('Bob', ['done'], async square => (await square.participant('Bob', { body })).done());
  });
  await t.test('inbox is the standalone SDK result on the same discovery and artifact state', async () => {
    const expected = serializable(await inbox({ cwd: f.cwd, env: f.env }, session, { limit: 1 }));
    const result = run(['inbox', '--for-session', session, '--limit', '1', '--json'], { cwd: f.cwd, env: f.env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  });
});

test('catch --json retains the terminal failure exit code and the SDK result', async t => {
  const f = await fixture(t, 1);
  await f.parity('Alice', ['join'], square => square.join('Alice', { body, wakeAddress: f.wakeAddress, takeover: false, last: 10 }));
  await f.parity('Bob', ['join'], square => square.join('Bob', { body, wakeAddress: f.wakeAddress, takeover: false, last: 10 }));
  await f.parity('Alice', ['express', '--force', 'one'], async square => (await square.participant('Alice', { body })).express('one', { force: true }));
  const result = await f.parity('Alice', ['catch'], async square => (await square.participant('Alice', { body })).catch({ limit: 10 }), 1);
  assert.equal(result.reason, 'capped');
});

test('an active catch keeps its exit code and JSON receipt without disrupting the waiter', async t => {
  const f = await fixture(t);
  await f.parity('Alice', ['join'], square => square.join('Alice', { body, wakeAddress: f.wakeAddress, takeover: false, last: 10 }));
  const square = await Square.at({ path: f.file, env: f.env });
  const alice = await square.participant('Alice', { body }), controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const waiting = alice.catch({ idle: 60_000 }, { signal: controller.signal, onProgress: started });
  try {
    await ready;
    const expected = serializable(await alice.catch({ idle: 60_000, limit: 10 }));
    const result = run(withName(f.file, 'Alice', ['catch', '--idle', '1m', '--json']), { cwd: f.cwd, env: f.env });
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

test('a successful waiting express leaves stdout as one JSON document', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.parity('Alice', ['join'], square => square.join('Alice', { body, wakeAddress: f.wakeAddress, takeover: false, last: 10 }));
  await f.parity('Bob', ['join'], square => square.join('Bob', { body, wakeAddress: f.wakeAddress, takeover: false, last: 10 }));
  await f.parity('Bob', ['hold', 'pause'], async square => (await square.participant('Bob', { body })).hold('pause'));
  const child = spawn(process.execPath, [CLI, ...withName(f.file, 'Alice', ['express', '--force', '--json', 'patient'])], {
    cwd: f.cwd, env: { ...f.env, SQUARE_HELD_WAIT_BUDGET_MS: '30000' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  let ready;
  const progress = new Promise(resolve => { ready = resolve; });
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.includes('your activity is waiting')) ready(); });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await progress;
  const square = await Square.at({ path: f.file, env: f.env });
  try { await (await square.participant('Bob', { body })).resume(); }
  finally { await square.close(); }
  assert.equal(await exited, 0, stderr);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.activity.body, 'patient');
  assert.equal(stdout, `${JSON.stringify(receipt)}\n`);
  assert.match(stderr, /your activity is waiting/);
});

test('JSON mode retains human argument errors and exit codes', async t => {
  const f = await fixture(t);
  for (const args of [['history', '--limit', '101'], ['participants', '--limit', '0']]) {
    const human = run(withPath(f.file, args), { cwd: f.cwd, env: f.env });
    const json = run(withPath(f.file, [...args, '--json']), { cwd: f.cwd, env: f.env });
    assert.equal(json.status, human.status);
    assert.equal(json.status, 2);
    assert.equal(json.stderr, human.stderr);
    assert.equal(json.stdout, human.stdout);
  }
  // A JSON switch cannot become invisible to a preceding value-taking option.
  for (const args of [
    ['join', '--last', '--json', '10'], ['express', '--metadata', '--json', '{}'],
    ['catch', '--limit', '--json', '2'], ['history', '--limit', '--json', '2'],
    ['participants', '--limit', '--json', '2'], ['inbox', '--for-session', session, '--limit', '--json', '2'],
  ]) {
    const result = run(withName(f.file, 'Alice', args), { cwd: f.cwd, env: f.env });
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /missing value|needs a positive integer|invalid arguments/);
  }
});
