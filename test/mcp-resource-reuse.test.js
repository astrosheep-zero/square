import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Square } from '../dist/square-api.js';
import { createSquareMcpServer } from '../dist/mcp.js';
import { createSquareResourceOwner } from '../dist/artifact.js';

async function fixture(label, participant = 'rei') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `square-reuse-${label}-`));
  const squarePath = path.join(cwd, 'square.square');
  const index = path.join(cwd, 'index.ndjsonl');
  const body = { channel: 'codex', session: `mcp-${label}` };
  const env = {
    ...process.env, SQUARE_INDEX: index, CODEX_THREAD_ID: body.session, SQUARE_NOW_MS: '1000',
    SQUARE_DISABLE_PASEO_WAKE: '1',
  };
  const built = await Square.build({ path: squarePath, markdown: 'reuse scene', env, body });
  await built.close();
  return { cwd, squarePath, env, body, participant };
}

/** Connections are opened once: `busy_timeout` is emitted only by createArtifactPort's connection(). */
function countConnections(t, squarePath) {
  const file = fs.realpathSync(squarePath);
  const exec = DatabaseSync.prototype.exec;
  let opened = 0;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql, ...args) {
    if (this.location() === file && typeof sql === 'string' && sql.includes('busy_timeout')) opened += 1;
    return exec.call(this, sql, ...args);
  });
  return () => opened;
}

/** Counts the actual DatabaseSync.close() calls for one square file. */
function countCloses(t, squarePath) {
  const file = fs.realpathSync(squarePath);
  const close = DatabaseSync.prototype.close;
  let closed = 0;
  t.mock.method(DatabaseSync.prototype, 'close', function (...args) {
    if (this.location() === file) closed += 1;
    return close.apply(this, args);
  });
  return () => closed;
}

function serverFor({ cwd, squarePath, env, body, participant }) {
  return createSquareMcpServer({ cwd, env, path: squarePath, body, participant });
}

async function connect(server) {
  const client = new Client({ name: 'square-reuse-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test('one MCP server opens one connection for many tool calls', async (t) => {
  const { cwd, squarePath, env, body, participant } = await fixture('mcp');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const opened = countConnections(t, squarePath);
  const server = serverFor({ cwd, squarePath, env, body, participant });
  const client = await connect(server);
  t.after(async () => { await client.close().catch(() => undefined); await server.close(); });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  assert.equal(opened(), 0);
  await call('join', { as: participant });
  await call('express', { body: 'first', force: true });
  await call('express', { body: 'second', force: true });
  await call('history');
  await call('status');
  await call('status', { as: participant });
  assert.equal(opened(), 1, 'six tool calls must share the server connection');

  // Closing the server closes the connection: a later open starts from scratch.
  await server.close();
  assert.equal(opened(), 1);
  const fresh = await Square.at({ cwd, env: { ...env }, path: squarePath, body, participant: 'other' });
  await fresh.join('other');
  await fresh.close();
  assert.equal(opened(), 2);
});

test('concurrent MCP tool calls share one connection successfully', async (t) => {
  const { cwd, squarePath, env, body, participant } = await fixture('concurrent');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const opened = countConnections(t, squarePath);
  const server = serverFor({ cwd, squarePath, env, body, participant });
  const client = await connect(server);
  t.after(async () => { await client.close().catch(() => undefined); await server.close(); });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  await call('join', { as: participant });
  await call('hold', { reason: 'concurrency' });
  const [history, status, participants] = await Promise.all([
    call('history'), call('status'), call('status', { as: participant }),
  ]);
  for (const result of [history, status, participants]) {
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent, undefined);
  }
  await call('hold', { release: true });
  await call('express', { body: 'after concurrency', force: true });
  assert.equal(opened(), 1);
  assert.match((await call('history')).content[0].text, /after concurrency/);
});

test('MCP shutdown waits for an idle catch before releasing the connection', async (t) => {
  const { cwd, squarePath, env, body, participant } = await fixture('shutdown');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const server = serverFor({ cwd, squarePath, env, body, participant });
  const client = await connect(server);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  await call('join', { as: participant });
  const pending = call('catch', { idle: 60_000 }).then(() => 'settled', (error) => error);
  await sleep(50);
  const started = Date.now();
  await server.close();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `shutdown must abort the idle catch, took ${elapsed}ms`);
  await pending;
  await client.close().catch(() => undefined);
});

test('a shared resource owner saves one connection open per request Square', async (t) => {
  const { cwd, squarePath, env, body, participant } = await fixture('measure', 'rei');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const rounds = 8;
  const context = { cwd, path: squarePath, env, body, participant };
  const opened = countConnections(t, squarePath);

  const baselineStart = Date.now();
  for (let index = 0; index < rounds; index += 1) {
    const square = await Square.at(context);
    try { await square.status(); }
    finally { await square.close(); }
  }
  const baselineMs = Date.now() - baselineStart;
  assert.equal(opened(), rounds, 'without an owner every call opens its own connection');

  const resources = createSquareResourceOwner();
  const sharedStart = Date.now();
  for (let index = 0; index < rounds; index += 1) {
    const square = await Square.at({ ...context, resources });
    try { await square.status(); }
    finally { await square.close(); }
  }
  const sharedMs = Date.now() - sharedStart;
  t.after(() => resources.close());
  assert.equal(opened(), rounds + 1, 'with an owner the whole run opens exactly one more connection');
  t.diagnostic(`status x${rounds}: ${rounds} opens ${baselineMs}ms -> 1 open ${sharedMs}ms (avoided ${rounds - 1} opens)`);
});

test('a resource owner lends one connection, refuses a second location, and closes once', async (t) => {
  const { cwd, squarePath, body } = await fixture('owner');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const owner = createSquareResourceOwner();
  const artifact = owner.artifact(squarePath);
  assert.equal(owner.artifact(path.join(cwd, '.', 'square.square')), artifact, 'same path resolves to one connection');
  assert.throws(() => owner.artifact(path.join(cwd, 'other.square')), /already holds/);

  const borrowed = await Square.at({ path: squarePath, env: { SQUARE_INDEX: path.join(cwd, 'index.ndjsonl') }, resources: owner, body });
  await borrowed.close();
  assert.ok((await artifact.read((facts) => facts.header())).value.nextActIndex >= 0, 'closing a borrowed view leaves the connection open');

  await owner.close();
  await assert.rejects(() => artifact.read((facts) => facts.header()));
  assert.throws(() => owner.artifact(squarePath), /is closed/);
});

test('a cancelled borrowed request never closes or poisons the owner connection', async t => {
  const { cwd, squarePath, env, body } = await fixture('borrowed-cancellation');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const resources = createSquareResourceOwner();
  t.after(() => resources.close());
  const artifact = resources.artifact(squarePath);
  await artifact.read(facts => facts.header());
  const controller = new AbortController();
  controller.abort(new Error('request cancelled, owner remains'));
  await assert.rejects(Square.at({ path: squarePath, env, body, resources }, { signal: controller.signal }), /request cancelled/);
  const next = await Square.at({ path: squarePath, env, body, resources });
  await next.join('Alive');
  await next.close();
  assert.equal((await artifact.read(facts => facts.participant('Alive').joined)).value, true);
});

test('a transport disconnect releases the connection even without server.close()', async (t) => {
  const { cwd, squarePath, env, body, participant } = await fixture('disconnect-release');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const opened = countConnections(t, squarePath);
  const closed = countCloses(t, squarePath);
  const server = serverFor({ cwd, squarePath, env, body, participant });
  const client = await connect(server);
  t.after(async () => { await server.close().catch(() => undefined); });

  await client.callTool({ name: 'join', arguments: { as: participant } });
  assert.equal(opened(), 1);
  assert.equal(closed(), 0);
  await client.close();
  for (let attempt = 0; attempt < 200 && closed() === 0; attempt += 1) await sleep(10);
  assert.equal(closed(), 1, 'the server onclose path must drain and release the shared connection');
});

test('reused connections keep per-call participants and harness sessions separate', async (t) => {
  const { cwd, squarePath, env, body, participant } = await fixture('sessions');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const opened = countConnections(t, squarePath);
  const server = serverFor({ cwd, squarePath, env, body, participant });
  const client = await connect(server);
  t.after(async () => { await client.close().catch(() => undefined); await server.close(); });
  const call = (name, args, meta) => client.callTool({ name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) });

  const first = await call('join', { as: participant }, { threadId: 'session-one' });
  assert.match(first.content[0].text, /you stepped into the square/);
  const refused = await call('join', { as: participant }, { threadId: 'session-two' });
  assert.equal(refused.isError, true);
  const reconnected = await call('join', { as: participant }, { threadId: 'session-one' });
  assert.match(reconnected.content[0].text, /already in the square/);
  await call('join', { as: 'other' });
  const expressed = await call('express', { as: 'other', body: 'other speaks', force: true });
  assert.equal(expressed.isError, undefined);
  const history = await call('history');
  assert.match(history.content[0].text, /@other/);
  assert.match(history.content[0].text, /other speaks/);
  assert.equal(opened(), 1);
});
