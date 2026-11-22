import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Square } from '../dist/api/square-api.js';
import { createArtifactPort } from '../dist/artifact/artifact.js';
import { joinCommand } from '../dist/cli/square-commands.js';
import { CLI, run, runAsync, testEnv, withName, withPath } from './square-cli-helpers.js';

const session = 'cli-json-parity';
const owner = `codex:${encodeURIComponent(session)}`;

async function fixture(t, { hardCap = null, throttlePerMinute } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-cli-json-'));
  const file = path.join(cwd, 'SQUARE.square');
  const env = testEnv({ HOME: cwd, CODEX_HOME: path.join(cwd, 'codex'), CODEX_THREAD_ID: session,
    SQUARE_NOW_MS: '90000' }, file);
  const square = await Square.build({ path: file, markdown: 'JSON parity', hardCap,
    ...(throttlePerMinute === undefined ? {} : { throttlePerMinute }), clock: () => 90000 });
  await square.close();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return { cwd, file, env };
}

async function sdk(file, operation) {
  const square = await Square.at({ path: file, clock: () => 90000 });
  try { return await operation(square); } finally { await square.close(); }
}

function parseDocument(text, label) {
  const data = JSON.parse(text);
  assert.equal(text, `${JSON.stringify(data)}\n`, `${label}: one JSON document with a newline`);
  assert.equal(data.observation, undefined, `${label}: presentation facts stay out of JSON`);
  return data;
}

function jsonOutput(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
  return parseDocument(result.stdout, label);
}

test('join, express, history and perceive expose the real typed JSON receipts', async (t) => {
  const { cwd, file, env } = await fixture(t);
  const joinContext = { command: 'join', cwd, env, squarePath: file, name: 'Alice', homeDir: cwd, json: true };
  const joined = parseDocument(await joinCommand.execute(joinCommand.parse([], joinContext), joinContext), 'join');
  assert.deepEqual(joined.participant, { name: 'Alice' });
  assert.deepEqual(joined.activity.kind, 'join');

  const square = await Square.at({ path: file, clock: () => 90000 });
  t.after(() => square.close());
  const bobJoin = await square.join('Bob', { owner });
  const bob = bobJoin.participant;
  await (await square.participant('Alice', { owner })).listen('Bob');

  const metadata = { observation: { nested: true }, participant: { name: 'not a handle', express: 'literal' } };
  const sentRun = run(withName(file, 'Alice', ['express', '--json', '--force', '--mention', 'Nobody', '--reply', bobJoin.activity.id,
    '--metadata', JSON.stringify(metadata), '-']), { cwd, env, input: 'Hello @Bob @Nobody' });
  const sent = jsonOutput(sentRun, 'express');
  assert.equal(sent.hint.length > 0, true);
  assert.deepEqual(sent.unmatchedMentions, ['Nobody']);
  assert.deepEqual(sent.activity.metadata, metadata);
  assert.deepEqual(sent.activity.mentions, ['Bob']);
  assert.equal(sent.activity.body, 'Hello @Bob @Nobody');
  assert.equal(sent.activity.reply, bobJoin.activity.id);
  const archived = (await square.history({ limit: null })).activities.find((activity) => activity.id === sent.activity.id);
  assert.deepEqual(sent.activity, archived);
  const pendingBefore = await bob.pending();

  const historyRun = run(withPath(file, ['history', '--json', '--limit', '100']), { cwd, env });
  const history = jsonOutput(historyRun, 'history');
  assert.deepEqual(history.activities, (await square.history({ limit: 100 })).activities);
  assert.equal(history.activities.find((activity) => activity.kind === 'listen').target, 'Bob');
  assert.deepEqual(await bob.pending(), pendingBefore);

  const perceiveRun = run(withName(file, 'Bob', ['perceive', '--json']), { cwd, env });
  const perceived = jsonOutput(perceiveRun, 'perceive');
  assert.deepEqual(perceived.activities, pendingBefore.activities);
  const pageIds = new Set(pendingBefore.activities.map((activity) => activity.id));
  assert.equal((await bob.pending()).activities.some((activity) => pageIds.has(activity.id)), false);
});

test('an empty perceive keeps its terminal exit code and typed capped result', async (t) => {
  const { cwd, file, env } = await fixture(t, { hardCap: 1 });
  await sdk(file, async (square) => {
    const alice = (await square.join('Alice', { owner })).participant;
    await square.join('Bob', { owner });
    await alice.express('one', { force: true });
  });
  const result = run(withName(file, 'Alice', ['perceive', '--json']), { cwd, env });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.reason, 'capped');
  assert.equal(result.stdout, `${JSON.stringify(receipt)}\n`);
});

test('a throttled wait keeps progress on stderr and one receipt on stdout', async (t) => {
  const { cwd, file, env } = await fixture(t, { throttlePerMinute: 1 });
  await sdk(file, async (square) => {
    const seat = (await square.join('Alice', { owner })).participant;
    const artifact = createArtifactPort(file);
    try {
      const held = (await artifact.read((facts) => facts.seat('Alice'))).value;
      await artifact.transactAs({ kind: 'participant', seat: held }, (facts) => facts.land({
        kind: 'say', actor: seat.name, at: Date.now() - 58_000, body: 'first', mentions: [],
      }));
    } finally { await artifact.close(); }
  });
  const waitingEnv = { ...env };
  delete waitingEnv.SQUARE_NOW_MS;
  const result = spawnSync(process.execPath, [CLI, '--location', file, '--as', 'Alice', 'express', '--json', 'patient'], {
    cwd, env: waitingEnv, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.activity.body, 'patient');
  assert.equal(result.stdout, `${JSON.stringify(receipt)}\n`);
  assert.match(result.stderr, /your activity is waiting/);
});

test('an active perceive keeps its exit code and typed already-active result', async (t) => {
  const { cwd, file, env } = await fixture(t);
  await sdk(file, async (opened) => (await opened.join('Alice', { owner })).participant);
  const square = await Square.at({ path: file, clock: () => 90000 });
  t.after(() => square.close());
  const participant = await square.participant('Alice', { owner });
  const controller = new AbortController();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const waiting = participant.perceive({ wait: 60_000 }, { signal: controller.signal, onProgress: started });
  try {
    await ready;
    const result = await runAsync(withName(file, 'Alice', ['perceive', '--wait', '1m', '--json']), { cwd, env });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.reason, 'already-active');
    assert.equal(result.stdout, `${JSON.stringify(receipt)}\n`);
  } finally {
    controller.abort(new Error('test finished'));
    await assert.rejects(waiting, /test finished/);
  }
});

test('JSON mode shares human argument errors and exit codes', async (t) => {
  const { cwd, file, env } = await fixture(t);
  const paired = ['history', '--limit', '101'];
  const human = run(withName(file, 'Alice', paired), { cwd, env });
  const json = run(withName(file, 'Alice', [...paired, '--json']), { cwd, env });
  assert.equal(json.status, human.status);
  assert.equal(json.status, 2);
  assert.equal(json.stderr, human.stderr);
  assert.equal(json.stdout, human.stdout);
  const missingValue = run(withName(file, 'Alice', ['join', '--last', '--json', '10']), { cwd, env });
  assert.equal(missingValue.status, 2, missingValue.stdout + missingValue.stderr);
  assert.match(missingValue.stderr, /missing value|needs a positive integer|invalid arguments/);
});
