import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { sessionInbox } from '../dist/inbox.js';
import { recordJoin } from '../dist/registry.js';
import { persistSquare, run, testEnv } from './square-cli-helpers.js';

test('inbox is a bounded, ordered snapshot that does not expose notification internals', async (t) => {
  const longName = `BRAVO${'z'.repeat(180)}`;
  const secretBody = 'notification body that stays inside delivery';
  const source = await persistSquare(async ({ square }) => {
    const sender = await square.join('Sender');
    await square.join('Alpha');
    await square.join(longName);
    await sender.express(secretBody, { force: true, mentions: ['Alpha', longName] });
  }, { hardCap: null });
  const root = path.dirname(source);
  const canonicalSource = fs.realpathSync(source);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const copyDirectory = path.join(root, 'z'.repeat(180));
  fs.mkdirSync(copyDirectory);
  const copies = Array.from({ length: 100 }, (_value, index) => {
    const squarePath = path.join(copyDirectory, `membership-${String(index).padStart(3, '0')}.square`);
    fs.copyFileSync(source, squarePath);
    return squarePath;
  });
  const env = testEnv({ SQUARE_REGISTRY: path.join(root, 'inbox-sessions.ndjsonl') });
  for (const squarePath of [source, ...copies]) {
    await recordJoin('inbox-snapshot', 'Alpha', squarePath, { channel: 'codex', env });
  }
  await recordJoin('inbox-snapshot', longName, source, { channel: 'codex', env });

  const complete = await sessionInbox('inbox-snapshot', env);
  assert.equal(complete.length, 102);
  assert.equal(complete.find((membership) => membership.name === longName)?.notifications[0].body, secretBody);

  const defaultResult = run(['inbox', '--for-session', 'inbox-snapshot', '--json'], { env });
  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  const defaultSnapshot = JSON.parse(defaultResult.stdout);
  assert.equal(defaultSnapshot.total, 102);
  assert.equal(defaultSnapshot.rows.length, 20);
  assert.deepEqual(defaultSnapshot.rows.slice(0, 2).map((row) => row.namePreview), [
    'Alpha',
    `${Array.from(longName).slice(0, 159).join('')}…`,
  ]);
  assert.equal(defaultSnapshot.rows[0].squarePathPreview, canonicalSource);
  assert.equal(defaultSnapshot.rows[1].squarePathPreview, canonicalSource);
  assert.equal(Array.from(defaultSnapshot.rows[2].squarePathPreview).length, 160);
  assert.ok(defaultSnapshot.rows[1].namePreview.endsWith('…'));
  assert.ok(defaultSnapshot.rows[2].squarePathPreview.endsWith('…'));
  assert.notEqual(defaultSnapshot.rows[2].squarePathPreview, copies[0]);
  for (const row of defaultSnapshot.rows) {
    assert.deepEqual(Object.keys(row).sort(), ['namePreview', 'pending', 'squarePathPreview']);
  }
  assert.doesNotMatch(defaultResult.stdout, new RegExp(secretBody));
  assert.doesNotMatch(defaultResult.stdout, /notifications|catchLease|route|actIndex/);

  const text = run(['inbox', '--for-session', 'inbox-snapshot'], { env });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /20 of 102 memberships shown\n$/);

  const maximum = run(['inbox', '--for-session', 'inbox-snapshot', '--limit', '100', '--json'], { env });
  assert.equal(maximum.status, 0, maximum.stderr);
  assert.equal(JSON.parse(maximum.stdout).total, 102);
  assert.equal(JSON.parse(maximum.stdout).rows.length, 100);

  const overMaximum = run(['inbox', '--limit', '101', '--for-session', 'inbox-snapshot', '--json'], { env });
  assert.equal(overMaximum.status, 2);
  assert.match(overMaximum.stderr, /✕ --limit is capped at 100/);
  assert.equal(overMaximum.stderr, "✕ --limit is capped at 100\n» square inbox --for-session 'inbox-snapshot' --limit 100 --json\n");

  const duplicateLimit = run(['inbox', '--for-session', 'inbox-snapshot', '--limit', '2', '--limit', '3'], { env });
  assert.equal(duplicateLimit.status, 2);
  assert.equal(duplicateLimit.stderr, "✕ inbox accepts one --limit\n» square inbox --for-session 'inbox-snapshot' --limit 100\n");
});
