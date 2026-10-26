import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { ACTIVITY_METADATA_MAX_BYTES } from '../dist/model.js';
import { activityRetryCommand } from '../dist/cli/express-presentation.js';
import { SQUARE_TOOLS } from '../dist/square-tools.js';
import { renderEventCli } from '../dist/presentation.js';
import { renderExpression } from '../dist/operation-presentation.js';
import { Square } from '../dist/square-api.js';

const body = (session) => ({ channel: 'metadata-test', session });

async function localSquare() {
  return Square.inMemory({ markdown: 'metadata test', body: body('local'), force: true });
}

test('activity metadata lands as an immutable fact through local reads and directed catch', async () => {
  const square = await localSquare();
  try {
    const alice = (await square.join('Alice')).participant;
    const bob = (await square.join('Bob')).participant;
    const metadata = { nested: { ok: true }, values: [null, 3, 'text'] };
    const sent = await alice.express({ body: 'with metadata', metadata }, { force: true });
    assert.deepEqual(sent.activity.metadata, metadata);
    assert.equal(Object.isFrozen(sent.activity.metadata), true);
    const bodyResult = await alice.express({ body: 'ordinary words', metadata: { kind: 'body' }, force: true, observe: true });
    assert.match(renderExpression('memory', bodyResult), /your words land/);
    assert.doesNotMatch(renderExpression('memory', bodyResult), /structured activity lands/);

    const metadataOnly = { event: 'wake', count: 2 };
    const directed = await alice.express({ metadata: metadataOnly, mentions: ['Bob'], force: true });
    assert.equal(directed.activity.body, undefined);
    assert.deepEqual(directed.activity.metadata, metadataOnly);
    const caught = await bob.catch();
    assert.deepEqual(caught.activities[0].metadata, metadataOnly);
    assert.equal(caught.activities[0].body, undefined);

    await bob.listen('Alice');
    const listened = await alice.express({ metadata: { bare: true }, force: true });
    assert.deepEqual((await bob.catch()).activities[0].metadata, listened.activity.metadata);

    const history = await square.history({ limit: null });
    assert.deepEqual(history.activities.at(-1)?.metadata, listened.activity.metadata);
    const rendered = renderEventCli(history.activities.at(-1));
    assert.match(rendered, /structured activity/);
    assert.doesNotMatch(rendered, /bare|true/);
  } finally { await square.close(); }
});

test('metadata survives reopen and stream without changing audience semantics', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-metadata-'));
  const location = path.join(root, 'metadata.square');
  const metadata = { persisted: true, unicode: '界' };
  try {
    const square = await Square.build({ path: location, markdown: 'metadata test', body: body('persist'), participant: 'Alice', force: true });
    try {
      const alice = (await square.join('Alice')).participant;
      await alice.express({ metadata, force: true });
    } finally { await square.close(); }
    const reopened = await Square.at({ path: location });
    try {
      assert.deepEqual((await reopened.history({ limit: null })).activities.at(-1)?.metadata, metadata);
      const iterator = reopened.stream({ start: { kind: 'tail', last: 1 } })[Symbol.asyncIterator]();
      const next = await iterator.next();
      assert.deepEqual(next.value.metadata, metadata);
      await iterator.return();
    } finally { await reopened.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('metadata admission is bounded, lossless, and rejects unsupported content before landing', async () => {
  const square = await localSquare();
  try {
    const alice = (await square.join('Alice')).participant;
    const before = (await square.history({ limit: null })).activities.length;
    const invalid = [
      {},
      { value: undefined },
      { value: 1n },
      { value: Infinity },
      { value: () => true },
      { value: Symbol('x') },
      { value: new Date() },
    ];
    for (const metadata of invalid) {
      await assert.rejects(alice.express({ metadata, force: true }), error => error.code === 'invalid_args' && error.facts?.activityUnsent === true);
    }
    const cycle = {};
    cycle.self = cycle;
    await assert.rejects(alice.express({ metadata: cycle, force: true }));
    const oversized = { value: 'x'.repeat(ACTIVITY_METADATA_MAX_BYTES) };
    await assert.rejects(alice.express({ metadata: oversized, force: true }), error => error.code === 'invalid_args' && error.facts?.activityUnsent === true);
    const depth = (levels) => levels === 0 ? { leaf: true } : { next: depth(levels - 1) };
    const acceptedDepth = await alice.express({ metadata: depth(256), force: true });
    let leaf = acceptedDepth.activity.metadata;
    for (let index = 0; index < 256; index++) leaf = leaf.next;
    assert.equal(leaf.leaf, true);
    await assert.rejects(alice.express({ metadata: depth(257), force: true }), error => error.code === 'invalid_args' && error.facts?.activityUnsent === true && error.operation?.expressEffect === 'unsent');
    assert.equal((await square.history({ limit: null })).activities.length, before + 1);

    const empty = await alice.express({ body: 'body preserves empty object', metadata: {}, force: true });
    assert.deepEqual(empty.activity.metadata, {});
  } finally { await square.close(); }
});

test('stdio exposes the same object-form metadata activity result', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-metadata-stdio-'));
  const root = path.join(cwd, 'artifacts');
  const server = path.resolve('dist/stdio-server.js');
  const env = { ...process.env, HOME: cwd, SQUARE_INDEX: path.join(cwd, 'index.ndjsonl'), PI_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '', OPENCODE_SESSION_ID: '', PASEO_AGENT_ID: '' };
  const square = await Square.build({ path: 'stdio://local/metadata', cwd, env, backends: { local: { command: process.execPath, args: [server, '--root', root] } }, markdown: 'stdio metadata', body: body('stdio'), participant: 'Alice', force: true });
  t.after(async () => { await square.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const alice = (await square.join('Alice')).participant;
  const result = await alice.express({ metadata: { remote: true } }, { force: true });
  assert.deepEqual(result.activity.metadata, { remote: true });
  assert.deepEqual((await alice.history({ limit: null })).activities.at(-1)?.metadata, { remote: true });
  assert.equal(result.activity.body, undefined);
});

test('stored say validation rejects blank bodies with empty metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-metadata-corrupt-'));
  const location = path.join(root, 'corrupt.square');
  try {
    const square = await Square.build({ path: location, markdown: 'corrupt metadata', body: body('corrupt'), force: true });
    try {
      const alice = (await square.join('Alice')).participant;
      await alice.express({ body: 'valid', metadata: {}, force: true });
    } finally { await square.close(); }
    const database = new DatabaseSync(location);
    try { database.prepare('UPDATE activities SET payload_json=? WHERE act_index=1').run('{"body":"   ","metadata":{}}'); }
    finally { database.close(); }
    const reopened = await Square.at({ path: location });
    try { await assert.rejects(reopened.history({ limit: null }), /non-empty body or non-empty metadata/); }
    finally { await reopened.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('CLI metadata input and retry keep the original JSON without a body redirect', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-metadata-cli-'));
  const location = path.join(root, 'metadata.square');
  const env = { ...process.env, CODEX_THREAD_ID: 'metadata-cli', PI_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_CODE_CHILD_SESSION: '', OPENCODE_SESSION_ID: '', PASEO_AGENT_ID: '' };
  try {
    const square = await Square.build({ path: location, markdown: 'cli metadata', body: { channel: 'codex', session: 'metadata-cli' }, force: true });
    try { await square.join('Alice'); } finally { await square.close(); }
    const cli = spawnSync(process.execPath, [path.resolve('dist/square.js'), '--location', location, '--as', 'Alice', 'express', '--force', '--metadata', '{"cli":true}'], { env, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /structured activity/);
    const reopened = await Square.at({ path: location });
    try { assert.deepEqual((await reopened.history({ limit: null })).activities.at(-1)?.metadata, { cli: true }); }
    finally { await reopened.close(); }
    const retry = activityRetryCommand(location, 'Alice', { metadataJson: '{"cli":true}', bodyProvided: false });
    assert.match(retry, /--metadata '\{"cli":true\}'/);
    assert.doesNotMatch(retry, / -$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('structured express tool accepts optional body and metadata together', () => {
  const definition = SQUARE_TOOLS.find(tool => tool.name === 'express');
  assert.ok(definition);
  const parsed = definition.inputSchema.parse({ metadata: { tool: true } });
  assert.deepEqual(parsed.metadata, { tool: true });
});
