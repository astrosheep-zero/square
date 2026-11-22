import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Square } from '../dist/api/square-api.js';
import { readSquareSnapshot } from '../dist/artifact/artifact.js';
import { CLI, ROOT, run, tempSquare, testEnv, withName } from './square-cli-helpers.js';

const shellReplay = { skip: process.platform === 'win32' ? 'Printed command replay requires a POSIX shell.' : false };

/** Execute exactly the printed shell syntax, substituting only the local binary. */
function executePrinted(command, env = {}) {
  assert.ok(command.startsWith('square '), command);
  const args = command.slice(7).match(/(?:'[^']*'|\S+)/g) ?? [];
  const locationIndex = args.findIndex((value) => value === '--location');
  const squarePath = locationIndex >= 0 ? args[locationIndex + 1]?.replace(/^'|'$/g, '') : undefined;
  return spawnSync('/bin/sh', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ${command.slice(7)}`], {
    cwd: ROOT, encoding: 'utf8', env: testEnv({ ...(squarePath === undefined ? {} : { CODEX_THREAD_ID: path.resolve(squarePath) }), ...env }, squarePath), timeout: 10000,
  });
}

async function setup(t, file) {
  // The CLI acts through the Codex body, so the SDK fixture joins both seats through it.
  const sessionBody = `codex:${file === undefined ? 'perceive-id-memory' : encodeURIComponent(path.resolve(file))}`;
  const square = file ? await Square.build({ path: file, markdown: 'test' }) : Square.inMemory({ markdown: 'test' });
  t.after(() => square.close());
  const alice = (await square.join('Alice', { owner: sessionBody })).participant;
  const bob = (await square.join('Bob', { owner: sessionBody })).participant;
  const first = await alice.express('first', { force: true, mentions: ['Bob'] });
  const body = 'complete-body-'.repeat(500) + 'END-OF-BODY';
  const second = await alice.express(body, { force: true, mentions: ['Bob'] });
  const bare = await alice.express('for nobody in particular', { force: true });
  return { square, alice, bob, first: first.activity, second: second.activity, bare: bare.activity, body };
}

test('exact perceive acknowledges only its id and repeats without changing observations', async (t) => {
  const file = tempSquare();
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const { bob, second, body } = await setup(t, file);
  const perceived = await bob.perceive({ id: second.id });
  assert.deepEqual(perceived.activities.map((item) => item.id), [second.id]);
  assert.equal(perceived.activities[0].body, body);
  assert.equal(perceived.remaining, 1);
  assert.equal(perceived.reason, 'drained');
  assert.equal(perceived.activities[0].via, 'mention');
  const before = (await readSquareSnapshot(file)).state.runtime.observations;
  assert.deepEqual(await bob.perceive({ id: second.id }), perceived);
  assert.deepEqual((await readSquareSnapshot(file)).state.runtime.observations, before);
});

test('exact perceive separates unaddressed and missing ids in typed facts', async (t) => {
  const { bob, alice, second, bare } = await setup(t);
  for (const [id, activityExists] of [['act/9999', false], ['act/0', true], [bare.id, true]]) {
    await assert.rejects(bob.perceive({ id }), (error) => {
      assert.equal(error.code, 'invalid_args');
      assert.equal(error.facts.reason, 'not_addressed');
      assert.equal(error.facts.activityId, id);
      assert.equal(error.facts.activityExists, activityExists);
      return true;
    });
  }
  await assert.rejects(bob.perceive({ id: second.id, idle: 0 }), { code: 'invalid_args' });
  await assert.rejects(bob.perceive({ id: 'garbage' }), { code: 'invalid_args' });
  assert.equal((await alice.pending()).activities.length, 0);
});

test('exact perceive preserves the landed listener audience after listening changes', async (t) => {
  const { bob, alice } = await setup(t);
  await bob.listen('Alice');
  const bare = await alice.express('heard while listening', { force: true });
  await bob.ignore('Alice');
  assert.equal((await bob.perceive({ id: bare.activity.id })).activities[0].body, bare.activity.body);
});

test('CLI exact perceive rejects conflicts, explains a miss, and reads the full body', shellReplay, async (t) => {
  const file = tempSquare();
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const { bob, first, second, bare, body } = await setup(t, file);
  const conflict = run(withName(file, 'Bob', ['perceive', '--id', second.id, '--idle', '1s']));
  assert.equal(conflict.status, 2, conflict.stdout + conflict.stderr);
  assert.match(conflict.stderr, /--id cannot be combined/);
  assert.ok(!conflict.stdout.includes(body));

  const undirected = run(withName(file, 'Bob', ['perceive', '--id', bare.id]));
  assert.equal(undirected.status, 2, undirected.stdout + undirected.stderr);
  assert.match(undirected.stderr, new RegExp(`✕ ${bare.id} isn't addressed to you`));
  const anchored = undirected.stderr.split('\n').find((line) => line.includes('history --at'));
  assert.match(anchored, new RegExp(`history --at ${bare.id} -C 2`));
  assert.equal(executePrinted(anchored).status, 0);

  const exact = run(withName(file, 'Bob', ['perceive', '--id', second.id]));
  assert.equal(exact.status, 0, exact.stderr);
  assert.ok(exact.stdout.includes('END-OF-BODY'));
  assert.deepEqual((await bob.perceive()).activities.map((activity) => activity.id), [first.id]);
});
