// Isolated from the default suite. Run with: npm run test:cli-process (builds, then this file).
// Only nonfungible executable behavior lives here: real migration edges, replayable
// CLI continuations, historical raw records, and filesystem-bounded list paging.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { seedFormat12 } from '../fixtures/format12.js';

import { formatActivityId } from '../../dist/square-core.js';
import { createArtifactPort, readSquareSnapshot, writeSquareFile } from '../../dist/artifact.js';
import { Square, discover } from '../../dist/square-api.js';
import { renderSquareList } from '../../dist/operation-presentation.js';
import { run, withPath, withName, persistSquare } from '../square-cli-helpers.js';

function command(output, flag) {
  const line = output.split('\n').find((value) => value.startsWith('square --location') && value.includes(flag));
  assert.ok(line, output);
  return line;
}

test('migrate prints the offline edge and leaves malformed bytes and the ledger untouched', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-migrate-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const name = 'old #? 名.square';
  const file = seedFormat12(path.join(root, name));
  const ledger = path.join(root, 'must-stay-absent.sqlite');
  const opts = { cwd: root, env: { SQUARE_DELIVERY: ledger } };

  const first = run(['migrate', '--location', name], opts);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /format 12 → 13/);
  assert.equal(fs.existsSync(ledger), false);
  const migrated = fs.readFileSync(file);

  const second = run(['--location', name, 'migrate'], opts);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /format 13 → 13 \(unchanged\)/);
  assert.deepEqual(fs.readFileSync(file), migrated);
  assert.equal(fs.existsSync(ledger), false);

  const database = new DatabaseSync(file);
  database.exec('UPDATE square_posts SET owner_pid=0 WHERE token IS NOT NULL');
  database.close();
  const malformed = fs.readFileSync(file);
  const refused = run(['--location', name, 'migrate'], opts);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Invalid square artifact/);
  assert.deepEqual(fs.readFileSync(file), malformed);
  assert.equal(fs.existsSync(ledger), false);
});

test('perceive continuation replays the sender filter and excludes the distractor', async (t) => {
  const file = await persistSquare(async ({ square, body }) => {
    await square.join('Alice', { owner: body });
    const bob = (await square.join('Bob', { owner: body })).participant;
    const cara = (await square.join('Cara', { owner: body })).participant;
    const dan = (await square.join('Dan', { owner: body })).participant;
    await bob.express('bob first @Alice', { force: true, mentions: ['Alice'] });
    await cara.express('cara next @Alice', { force: true, mentions: ['Alice'] });
    await dan.express('dan aside @Alice', { force: true, mentions: ['Alice'] });
  });
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const args = ['perceive', '--from', 'Bob,Cara', '--mention', '--limit', '1'];

  const first = run(withName(file, 'Alice', args), { env: { SQUARE_NOW_MS: '10000' } });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /bob first @Alice/);
  assert.doesNotMatch(first.stdout, /dan aside/);
  assert.match(command(first.stdout, '--from'), /--from Bob,Cara --mention --limit 1/);

  const second = run(withName(file, 'Alice', args), { env: { SQUARE_NOW_MS: '11000' } });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /cara next @Alice/);
  assert.doesNotMatch(second.stdout, /bob first @Alice/);
  assert.doesNotMatch(second.stdout, /dan aside/);
});

test('history search keeps a stable older continuation and recovers a bounded context', async (t) => {
  const firstBody = `FIRST-${'x'.repeat(240)}-schema\nv3-${'y'.repeat(240)}-FIRST-TAIL`;
  const file = await persistSquare(async ({ square, body }) => {
    const alice = (await square.join('Alice', { owner: body })).participant;
    await alice.express(firstBody, { force: true });
    await alice.express(`SECOND-${'b'.repeat(240)}-schema  v3-SECOND-TAIL`, { force: true });
    await alice.express('distractor schema v4 only', { force: true });
  });
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  const newer = run(withPath(file, ['history', '--regex', '--search', 'schema\\s+v3', '--limit', '1']), { env: { SQUARE_NOW_MS: '50000' } });
  assert.equal(newer.status, 0, newer.stderr);
  assert.match(newer.stdout, /act\/2/);
  assert.doesNotMatch(newer.stdout, /act\/1/);
  assert.ok(command(newer.stdout, '--before').includes("--search 'schema\\s+v3' --before act/2 --limit 1"));

  const older = run(withPath(file, ['history', '--regex', '--search', 'schema\\s+v3', '--before', 'act/2', '--limit', '1']), { env: { SQUARE_NOW_MS: '50000' } });
  assert.equal(older.status, 0, older.stderr);
  assert.match(older.stdout, /act\/1/);
  assert.doesNotMatch(older.stdout, /act\/2/);

  const full = run(withPath(file, ['history', '--at', 'act/1', '-C', '0', '--full']), { env: { SQUARE_NOW_MS: '50000' } });
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /FIRST-TAIL/);

  const boundsFile = await persistSquare(async ({ square, file, body }) => {
    await square.join('Alice', { owner: body });
    await square.close();
    const artifact = createArtifactPort(file);
    try {
      const seat = (await artifact.read((facts) => facts.seat('Alice'))).value;
      await artifact.transactAs({ kind: 'participant', seat }, (facts) => {
        for (let index = 1; index <= 101; index += 1) facts.land({ kind: 'say', actor: 'Alice', at: 1000 + index, body: `short ${index}` });
      });
    } finally { await artifact.close(); }
  }, { hardCap: 200 });
  t.after(() => fs.rmSync(path.dirname(boundsFile), { recursive: true, force: true }));

  const refused = run(withPath(boundsFile, ['history', '--at', 'act/100', '-C', '100', '--json']));
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /history is capped at 100 activities/);
  assert.match(refused.stderr, /history --at act\/100 -C 100 --json --limit 100/);
  const recovered = run(withPath(boundsFile, ['history', '--at', 'act/100', '-C', '100', '--json', '--limit', '100']));
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).activities.length, 100);
});

test('a historical body-bearing done stays in the archive without reaching perceive', async (t) => {
  let owner;
  const file = await persistSquare(async ({ square, body }) => {
    owner = body;
    await square.join('Alice', { owner: body });
    await square.join('Bob', { owner: body });
  });
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  const artifact = createArtifactPort(file);
  try {
    const seat = (await artifact.read((facts) => facts.seat('Bob'))).value;
    await artifact.transactAs({ kind: 'participant', seat }, (facts) => facts.land({ kind: 'done', actor: 'Bob', at: 6000, body: 'final note' }));
  } finally { await artifact.close(); }

  const square = await Square.at({ path: file, clock: () => 7000 });
  try {
    const history = await square.history({ limit: null });
    const departure = history.activities.find((activity) => activity.kind === 'done');
    assert.equal(departure.body, 'final note');
    const alice = await square.participant('Alice', { owner });
    const perceived = await alice.perceive();
    assert.equal(perceived.activities.some((activity) => activity.id === departure.id), false);
  } finally { await square.close(); }

  const cli = run(withPath(file, ['history', '--full']), { env: { SQUARE_NOW_MS: '8000' } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal((cli.stdout.match(/final note/g) ?? []).length, 1);
  assert.match(cli.stdout, /@Bob stepped out of the square — done · act\/2/);
});

test('list orders depth and cursor paging, then reports a bounded uncertain walk', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-list-depth-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const build = async (relative, markdown) => {
    const file = path.join(cwd, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const square = await Square.build({ path: file, markdown, hardCap: 3 });
    await square.close();
  };
  await build('alpha.square', 'alpha');
  await build('dir/beta.square', 'beta');
  await build('d1/d2/d3/d4/d5/deep.square', 'deep');

  assert.deepEqual((await discover({ cwd })).items.map((item) => item.path), ['alpha.square', 'dir/beta.square']);
  assert.ok((await discover({ cwd }, { depth: 5 })).items.some((item) => item.path === 'd1/d2/d3/d4/d5/deep.square'));

  const first = run(['list', '--limit', '1'], { cwd });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /alpha\.square/);
  assert.doesNotMatch(first.stdout, /beta\.square/);
  assert.match(first.stdout, /square list --depth 4 --limit 1 --after 'alpha\.square'/);
  const second = run(['list', '--limit', '1', '--after', 'alpha.square'], { cwd });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /dir\/beta\.square/);
  assert.doesNotMatch(second.stdout, /alpha\.square/);

  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'square-list-budget-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['a-left.square', 'b-right.square']) {
    const square = await Square.build({ path: path.join(root, name), markdown: name, hardCap: 3 });
    await square.close();
  }
  const actual = await fs.promises.readdir(root, { withFileTypes: true });
  const entries = [...actual, ...Array.from({ length: 10_000 - actual.length }, (_value, index) => ({
    name: `z-fake-${String(index).padStart(5, '0')}`,
    isDirectory: () => false,
    isFile: () => false,
  }))];
  const originalReaddir = fs.promises.readdir;
  t.mock.method(fs.promises, 'readdir', (directory, ...args) => directory === root ? entries : originalReaddir(directory, ...args));
  const discovered = await discover({ cwd: root }, { limit: 1 });
  assert.deepEqual({ stopped: discovered.stopped, remaining: discovered.remaining, next: discovered.next },
    { stopped: true, remaining: 1, next: 'a-left.square' });
  const rendered = renderSquareList(discovered, { now: 1000, depth: 4, limit: 1 });
  assert.match(rendered, /more squares/);
  assert.match(rendered, /the walk stopped early/);
  assert.match(rendered, /square list --depth 4 --limit 1 --after 'a-left\.square'/);
});

test('history keeps a historical read out of public activities but not raw fields', async (t) => {
  const file = await persistSquare(async ({ square, body }) => {
    const alice = (await square.join('Alice', { owner: body })).participant;
    await alice.express('first public activity', { force: true });
    await alice.express('second public activity', { force: true });
  }, { hardCap: 100 });
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  const state = (await readSquareSnapshot(file)).state;
  const readIndex = (state.acts.at(-1)?.index ?? -1) + 1;
  const readAt = (state.acts.at(-1)?.at ?? 0) + 1000;
  await writeSquareFile(file, {
    ...state,
    acts: [...state.acts, { kind: 'read', actor: 'Alice', at: readAt, through: readIndex, index: readIndex }],
    runtime: { ...state.runtime, nextActIndex: readIndex + 1 },
  });
  const id = formatActivityId(readIndex);

  const json = run(withPath(file, ['history', '--at', id, '-C', '0', '--json']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).activities, []);
  const fields = run(withPath(file, ['history', '--at', id, '-C', '0', '--format', 'id,kind']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(fields.status, 0, fields.stderr);
  assert.equal(fields.stdout, `${id}\tread\n`);
});
