import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Square, createSquareApplication } from '../dist/square-application.js';
import { createSquareMcpServer } from '../dist/mcp.js';
import { readSquareSnapshot } from '../dist/artifact.js';

async function fixture(t, label) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `square-parity-${label}-`));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const squarePath = path.join(cwd, 'SQUARE.square');
  const env = { ...process.env, SQUARE_REGISTRY: path.join(cwd, 'registry.ndjsonl'),
    SQUARE_HOST_LEDGER_ROOT: path.join(cwd, 'ledger'), SQUARE_NOW_MS: '1000',
    CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '', OPENCODE_SESSION_ID: '', PI_SESSION_ID: '', PASEO_AGENT_ID: '',
    SQUARE_PARTICIPANT_NAME: undefined, SQUARE_DISABLE_PASEO_WAKE: '1', NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  const built = await Square.build({ path: squarePath, markdown: 'parity context', env });
  await built.close();
  return { cwd, squarePath, env, app: (participant) => createSquareApplication({ cwd, squarePath, env, participant }) };
}

async function mcp(t, options) {
  const server = createSquareMcpServer(options);
  const client = new Client({ name: 'square-parity-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right), client.connect(left)]);
  t.after(async () => { await client.close(); await server.close(); });
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    return result.structuredContent;
  };
}

function cli(options, participant, args) {
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../dist/square.js'),
    '--location', options.squarePath, '--as', participant, ...args], {
    cwd: options.cwd, env: options.env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

// Compare public facts, not terminal wording or implementation call sequences.
test('CLI and MCP land the same join, directed reply, listener and departure facts as the application', async (t) => {
  const application = await fixture(t, 'application');
  const terminal = await fixture(t, 'cli');
  const json = await fixture(t, 'mcp');
  const call = await mcp(t, json);
  for (const participant of ['Alice', 'Bob']) {
    await application.app(participant).join();
    cli(terminal, participant, ['join']);
    await call('join', { as: participant });
  }
  const alice = application.app('Alice');
  await alice.express('first @Bob', { force: true });
  cli(terminal, 'Alice', ['express', '--force', 'first @Bob']);
  await call('express', { as: 'Alice', body: 'first @Bob', force: true });
  await application.app('Bob').express('answer', { force: true, noMention: true, reply: 'act/2' });
  cli(terminal, 'Bob', ['express', '--force', '--no-mention', '--reply', 'act/2', 'answer']);
  await call('express', { as: 'Bob', body: 'answer', force: true, reply: 'act/2' });
  await alice.listen('Bob');
  cli(terminal, 'Alice', ['listen', 'Bob']);
  await call('listen', { as: 'Alice', target: 'Bob' });
  const caught = await alice.catch();
  cli(terminal, 'Alice', ['catch']);
  assert.deepEqual(await call('catch', { as: 'Alice' }), caught.data);
  await alice.ignore('Bob');
  cli(terminal, 'Alice', ['ignore', 'Bob']);
  await call('ignore', { as: 'Alice', target: 'Bob' });
  await application.app('Bob').done();
  cli(terminal, 'Bob', ['done']);
  await call('done', { as: 'Bob' });
  const expected = (await alice.history({ limit: 100 })).data;
  assert.deepEqual((await terminal.app().history({ limit: 100 })).data, expected);
  assert.deepEqual(await call('history', { limit: 100 }), expected);
  const persisted = (await readSquareSnapshot(application.squarePath)).state;
  for (const options of [terminal, json]) {
    const actual = (await readSquareSnapshot(options.squarePath)).state;
    assert.deepEqual(actual.acts, persisted.acts);
    assert.deepEqual(actual.runtime.observations, persisted.runtime.observations);
  }
});

test('history application/MCP default to ten while SDK archive is unbounded, and none writes receipts', async (t) => {
  const options = await fixture(t, 'archive');
  const alice = options.app('Alice');
  await alice.join();
  for (let index = 0; index < 12; index++) await alice.express(`message ${index}`, { force: true });
  const sdk = await Square.at({ path: options.squarePath, env: options.env });
  t.after(() => sdk.close());
  const participant = await sdk.join('Alice');
  const call = await mcp(t, options);
  const before = (await readSquareSnapshot(options.squarePath)).state;
  const recent = await options.app().history();
  assert.deepEqual(recent.data.activities.map((activity) => activity.id), Array.from({ length: 10 }, (_, index) => `act/${index + 3}`));
  assert.deepEqual(await call('history'), recent.data);
  assert.deepEqual(await participant.history(), recent.data.activities);
  assert.equal((await sdk.history()).length, 13);
  assert.deepEqual(recent.projection.continuation, { direction: 'before', cursor: 'act/3', limit: 10 });
  cli(options, 'Alice', ['history']);
  assert.deepEqual((await readSquareSnapshot(options.squarePath)).state, before);
});

test('departed express reenters exactly once and never-joined express is unsent on both application and MCP', async (t) => {
  const direct = await fixture(t, 'reentry-direct');
  const json = await fixture(t, 'reentry-mcp');
  const call = await mcp(t, json);
  const alice = direct.app('Alice');
  await alice.join();
  await alice.done();
  await call('join', { as: 'Alice' });
  await call('done', { as: 'Alice' });
  const expressed = await alice.express('back', { force: true });
  assert.equal(expressed.projection.reentry.kind, 'join');
  assert.equal(expressed.projection.reentry.id, 'act/2');
  assert.deepEqual(await call('express', { as: 'Alice', body: 'back', force: true }), expressed.data);
  await assert.rejects(direct.app('Never').express('unsent'), (error) => {
    assert.equal(error.facts.reason, 'never_joined');
    assert.deepEqual(error.operation, { operation: 'express', participant: 'Never', subject: 'caller', expressEffect: 'unsent' });
    return true;
  });
  const client = new Client({ name: 'square-parity-error', version: '1' });
  const server = createSquareMcpServer(json);
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right), client.connect(left)]);
  t.after(async () => { await client.close(); await server.close(); });
  const refused = await client.callTool({ name: 'express', arguments: { as: 'Never', body: 'unsent' } });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.facts.reason, 'never_joined');
  assert.deepEqual(refused.structuredContent.error.operation, { operation: 'express', participant: 'Never', subject: 'caller', expressEffect: 'unsent' });
  assert.deepEqual((await direct.app().history()).data, (await json.app().history()).data);
  assert.equal((await direct.app().participants()).data.participants.some((participant) => participant.name === 'Never'), false);
});
