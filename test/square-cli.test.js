import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Square, harnessOwner, localUserOwner } from '../dist/api/square-api.js';
import { commandIdentity } from '../dist/cli/context.js';
import { streamCommand } from '../dist/cli/observation-commands.js';
import { helpRequest, renderSubcommandHelp } from '../dist/cli/help.js';
import { ROOT, persistSquare, run, tempSquare, testEnv, withName, withPath } from './square-cli-helpers.js';

test('CLI uses a harness identity only when the environment carries one', () => {
  assert.deepEqual(commandIdentity({}), { owner: localUserOwner() });
  assert.deepEqual(commandIdentity({ CODEX_THREAD_ID: ' body ' }).owner, harnessOwner({ channel: 'codex', session: 'body' }));
});

test('CLI joins, refuses a foreign body, and takes over the same name', async (t) => {
  const file = tempSquare();
  const built = run(['--location', file, 'build'], { input: '## Topic\n\nOwnership\n' });
  assert.equal(built.status, 0, built.stderr);
  const square = await Square.at({ path: file });
  t.after(() => square.close());
  assert.equal((await square.status()).hardCap, null, 'build defaults to unlimited');

  const owner = harnessOwner({ channel: 'codex', session: 'alice-body' });
  const joined = run(withName(file, 'Alice', ['join']), { env: { CODEX_THREAD_ID: 'alice-body' } });
  assert.equal(joined.status, 0, joined.stderr);
  assert.match(joined.stdout, /● you stepped into the square/);
  const alice = await square.participant('Alice', { owner });
  const before = (await square.history()).activities;

  const foreign = run(withName(file, 'Alice', ['perceive']), { env: { CODEX_THREAD_ID: 'worker-body' } });
  assert.equal(foreign.status, 2, foreign.stdout);
  assert.match(foreign.stderr, /is not held by this owner/);
  assert.ok(foreign.stderr.trimEnd().endsWith(`square --location '${file}' --as 'Alice' join`));
  assert.deepEqual((await square.history()).activities, before);
  assert.equal((await square.participant('Alice', { owner })).name, 'Alice');

  const takeover = run(withName(file, 'Alice', ['join', '--takeover']), { env: { CODEX_THREAD_ID: 'worker-body' } });
  assert.equal(takeover.status, 0, takeover.stderr);
  assert.match(takeover.stdout, /you banished the original @Alice/);
  await assert.rejects(alice.express('stale seat', { force: true }), { code: 'already_joined' });
  const lifecycle = (await square.history({ limit: 100 })).activities
    .filter((activity) => activity.actor === 'Alice' && (activity.kind === 'join' || activity.kind === 'done'))
    .map((activity) => activity.kind);
  assert.deepEqual(lifecycle, ['join', 'done', 'join']);
});

test('status expands the latest body only when it is actually clipped', async () => {
  const file = await persistSquare(async ({ square, body }) => {
    const alice = (await square.join('Alice', { owner: body })).participant;
    await alice.express('the phrase more chars fits without clipping', { force: true });
  }, { hardCap: 10 });
  const status = () => run(withName(file, 'Alice', ['status']), { env: { SQUARE_NOW_MS: '10000' } });
  const first = status();
  assert.equal(first.status, 0, first.stderr);
  const literal = first.stdout;
  assert.match(literal, /more chars fits without clipping/);

  const square = await Square.at({ path: file });
  let latest;
  try {
    const alice = await square.participant('Alice', { owner: `codex:${encodeURIComponent(path.resolve(file))}` });
    await alice.express('x'.repeat(260), { force: true });
    latest = (await square.history()).activities.at(-1);
  } finally { await square.close(); }
  const after = status();
  assert.equal(after.status, 0, after.stderr);
  const clipped = after.stdout;
  assert.ok(clipped.includes(`history --ids ${latest.id} -C 2 --max-chars`));
});

test('missing locations stay quiet and point at discovery', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-no-location-'));
  try {
    const missing = run(['express', 'hello'], { cwd });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /✕ express needs a square location/);
    assert.match(missing.stderr, /^square ls$/m);
    const listed = run(['ls'], { cwd });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /no squares found/);
    assert.equal(fs.existsSync(path.join(cwd, '.square')), false);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('an unknown history option points at its help', async () => {
  const file = await persistSquare(async () => {});
  const unknown = run(withPath(file, ['history', '--wat']));
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /✕ history does not know --wat/);
  assert.match(unknown.stderr, /square history --help\n$/);
});

test('doctor refuses Markdown bytes without changing them', () => {
  const file = tempSquare();
  const markdown = '---\nhard_cap: 3\n---\n\n## Warmup\nwarmup\n';
  fs.writeFileSync(file, markdown);
  const result = run(withPath(file, ['doctor']));
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /unreadable artifact/);
  assert.match(result.stdout, /Invalid square artifact/);
  assert.deepEqual(fs.readFileSync(file), Buffer.from(markdown));
});

test('delivery doctor needs no square', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-doctor-ledger-'));
  try {
    const result = run(['harness', 'doctor', 'delivery'], {
      env: { HOME: home, SQUARE_DELIVERY: path.join(home, 'delivery.sqlite') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /delivery health.*0 unknown attempts/);
    assert.deepEqual(fs.readdirSync(home), ['delivery.sqlite']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('scoped help resolves aliases and refuses unknown commands', () => {
  assert.deepEqual(helpRequest(['perceive', '--help']), { command: 'perceive' });
  assert.match(renderSubcommandHelp('perceive'), /--mention\s+Only what was addressed to you/);
  assert.match(renderSubcommandHelp('ls'), /Aliases: list/);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-help-'));
  try {
    const missing = path.join(cwd, 'missing.square');
    const scoped = run(['--as', 'Alice', '--location', missing, 'perceive', '-h'], { cwd });
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.match(scoped.stdout, /Usage: square --location <square> \[--as <name>\] perceive/);
    const unknown = run(['help', 'missing-command'], { cwd });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown command: missing-command/);
    assert.match(unknown.stderr, /square --help/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('stream parses a canonical cursor and refuses without ndjson', async () => {
  const context = { command: 'stream', squarePath: tempSquare(), cwd: ROOT, homeDir: os.homedir(), env: testEnv() };
  assert.deepEqual(streamCommand.parse(['--ndjson', '--after', 'act/12'], context), {
    ndjson: true, forName: undefined, start: { kind: 'after', after: 'act/12' },
  });
  const file = await persistSquare(async () => {});
  const refused = run(withPath(file, ['stream']));
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /square --location .* stream --ndjson/);
});
