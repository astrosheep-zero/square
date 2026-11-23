import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Square } from '../dist/api/square-api.js';
import { createArtifactPort, readSquareSnapshot } from '../dist/artifact/artifact.js';
import { persistSquare, run, withName } from './square-cli-helpers.js';

test('unlisten returns to neutral on landing and replay without rewriting audience', async t => {
  const file = await persistSquare(async ({ square, body: owner }) => {
    const { participant: alice } = await square.join('Alice', { owner });
    const { participant: bob } = await square.join('Bob', { owner });
    await bob.attention({ target: 'Alice', state: 'listen' });
    await alice.express('heard while listening');
    await bob.attention({ target: 'Alice', state: 'ignore' });
    await alice.express('muted @Bob');
  }, { hardCap: null });
  const root = path.dirname(file);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const neutral = run(withName(file, 'Bob', ['unlisten', 'alice']));
  assert.equal(neutral.status, 0, neutral.stderr);
  const owner = `codex:${encodeURIComponent(path.resolve(file))}`;
  const square = await Square.at({ path: file });
  t.after(() => square.close());
  const alice = await square.participant('Alice', { owner });
  const bob = await square.participant('Bob', { owner });
  await alice.express('not directed');
  await alice.express('direct again @Bob');
  assert.deepEqual((await bob.perceive()).activities.map(a => a.body), ['heard while listening', 'direct again @Bob']);

  const replay = createArtifactPort(':memory:', (await readSquareSnapshot(file)).state);
  t.after(() => replay.close());
  assert.deepEqual((await replay.read(facts => facts.attention('Bob'))).value, []);
});
