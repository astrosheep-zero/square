import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { inbox } from '../dist/index.js';
import { Square } from '../dist/square-api.js';
import { sessionInbox } from '../dist/inbox.js';
import { rememberSquarePath } from '../dist/square-index.js';
import { run, testEnv } from './square-cli-helpers.js';

async function makeMembership(root, name, env) {
  const file = path.join(root, `${name}.square`);
  const body = 'codex:inbox-snapshot';
  const square = await Square.build({ path: file, markdown: 'inbox context', hardCap: null, env });
  try {
    const sender = (await square.join('Sender', { owner: body })).participant;
    await square.join(name, { owner: body });
    await sender.express(`notice for ${name}`, { force: true, mentions: [name] });
  } finally { await square.close(); }
  await rememberSquarePath(file, body, env.SQUARE_INDEX);
  return file;
}

test('inbox is a bounded, ordered snapshot without notification internals', async (t) => {
  const root = fs.mkdtempSync(path.join('/tmp', 'square-inbox-cli-'));
  const env = testEnv({ SQUARE_INDEX: path.join(root, 'index.ndjsonl') });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const names = ['Alpha', `BRAVO${'z'.repeat(180)}`, 'Charlie'];
  const files = [];
  for (const name of names) files.push(await makeMembership(root, name, env));
  const complete = await sessionInbox('codex:inbox-snapshot', env);
  assert.equal(complete.length, names.length * 2);
  assert.equal(complete.find((membership) => membership.seat.participant === names[1])?.notifications[0].body, `notice for ${names[1]}`);

  const result = run(['inbox', '--for-owner', 'codex:inbox-snapshot', '--json'], { env });
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.deepEqual(snapshot, await inbox({ cwd: root, env }, 'codex:inbox-snapshot'));
  assert.equal(snapshot.total, names.length * 2);
  assert.equal(snapshot.rows.length, names.length * 2);
  for (const row of snapshot.rows) assert.deepEqual(Object.keys(row).sort(), ['name', 'pending', 'squarePath']);
  assert.equal(snapshot.rows.some(row => row.name === names[1] && row.squarePath === fs.realpathSync(files[1])), true);
  assert.doesNotMatch(result.stdout, /notification body|notifications|catchLease|route|actIndex/);

  const text = run(['inbox', '--for-owner', 'codex:inbox-snapshot'], { env });
  assert.equal(text.status, 0, text.stderr);
  const preview = value => [...value].length <= 159 ? value : `${[...value].slice(0, 159).join('').trimEnd()}…`;
  assert.equal(text.stdout, snapshot.rows.map((row) => `${preview(row.name)}\t${preview(row.squarePath)}\t${row.pending}\n`).join(''));

  const overMaximum = run(['inbox', '--limit', '101', '--for-owner', 'codex:inbox-snapshot', '--json'], { env });
  assert.equal(overMaximum.status, 2);
  assert.match(overMaximum.stderr, /✕ --limit is capped at 100/);
  assert.equal(overMaximum.stderr, "✕ --limit is capped at 100\nsquare inbox --for-owner 'codex:inbox-snapshot' --limit 100 --json\n");

  const duplicateLimit = run(['inbox', '--for-owner', 'codex:inbox-snapshot', '--limit', '2', '--limit', '3'], { env });
  assert.equal(duplicateLimit.status, 2);
  assert.equal(duplicateLimit.stderr, "✕ inbox accepts one --limit\nsquare inbox --for-owner 'codex:inbox-snapshot' --limit 100\n");
  assert.equal(files.length, names.length);
});
