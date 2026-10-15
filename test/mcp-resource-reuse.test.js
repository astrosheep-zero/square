import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Square, createSquareApplication } from '../dist/square-application.js';
import { createSquareMcpServer } from '../dist/mcp.js';
import { createSquareResourceOwner, openSquare, closeOpenSquare } from '../dist/open-square.js';

async function fixture(label, participant = 'rei') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `square-reuse-${label}-`));
  const squarePath = path.join(cwd, 'square.square');
  const env = {
    ...process.env, SQUARE_REGISTRY: path.join(cwd, 'registry.ndjsonl'),
    SQUARE_HOST_LEDGER_ROOT: path.join(cwd, 'ledger'), SQUARE_NOW_MS: '1000',
    SQUARE_PARTICIPANT_NAME: participant, SQUARE_DISABLE_PASEO_WAKE: '1',
  };
  const built = await Square.build({ path: squarePath, markdown: 'reuse scene', env });
  await built.close();
  return { cwd, squarePath, env };
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

async function connect(server) {
  const client = new Client({ name: 'square-reuse-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test('one MCP server opens one connection for many tool calls', async (t) => {
  const { cwd, squarePath, env } = await fixture('mcp');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const opened = countConnections(t, squarePath);
  const server = createSquareMcpServer({ cwd, env, squarePath });
  const client = await connect(server);
  t.after(async () => { await client.close().catch(() => undefined); await server.close(); });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  assert.equal(opened(), 0);
  await call('join');
  await call('express', { body: 'first', force: true });
  await call('express', { body: 'second', force: true });
  await call('history');
  await call('status');
  await call('participants');
  assert.equal(opened(), 1, 'six tool calls must share the server connection');

  // Closing the server closes the connection: a later open starts from scratch.
  await server.close();
  assert.equal(opened(), 1);
  const fresh = createSquareApplication({ cwd, env: { ...env, SQUARE_PARTICIPANT_NAME: 'other' }, squarePath, participant: 'other' });
  await fresh.join();
  assert.equal(opened(), 2);
});

test('concurrent MCP tool calls share one connection successfully', async (t) => {
  const { cwd, squarePath, env } = await fixture('concurrent');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const opened = countConnections(t, squarePath);
  const server = createSquareMcpServer({ cwd, env, squarePath });
  const client = await connect(server);
  t.after(async () => { await client.close().catch(() => undefined); await server.close(); });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  await call('join');
  await call('hold', { reason: 'concurrency' });
  const [history, status, participants] = await Promise.all([
    call('history'), call('status'), call('participants'),
  ]);
  for (const result of [history, status, participants]) assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  await call('resume');
  await call('express', { body: 'after concurrency', force: true });
  assert.equal(opened(), 1);
  assert.deepEqual((await call('history')).structuredContent.activities.map((activity) => activity.body).filter((body) => body === 'after concurrency'), ['after concurrency']);
});

test('MCP shutdown waits for an idle catch before releasing the connection', async (t) => {
  const { cwd, squarePath, env } = await fixture('shutdown');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const server = createSquareMcpServer({ cwd, env, squarePath });
  const client = await connect(server);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  await call('join');
  const pending = call('catch', { idle: 60_000 }).then(() => 'settled', (error) => error);
  await sleep(50);
  const started = Date.now();
  await server.close();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `shutdown must abort the idle catch, took ${elapsed}ms`);
  await pending;
  await client.close().catch(() => undefined);
});

test('a shared resource owner saves one connection open per application call', async (t) => {
  const { cwd, squarePath, env } = await fixture('measure', 'rei');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const rounds = 8;
  const context = { cwd, squarePath, env };
  const opened = countConnections(t, squarePath);

  const baselineStart = Date.now();
  for (let index = 0; index < rounds; index += 1) {
    await createSquareApplication({ ...context, participant: 'rei' }).status();
  }
  const baselineMs = Date.now() - baselineStart;
  assert.equal(opened(), rounds, 'without an owner every call opens its own connection');

  const resources = createSquareResourceOwner();
  const sharedStart = Date.now();
  for (let index = 0; index < rounds; index += 1) {
    await createSquareApplication({ ...context, participant: 'rei', resources }).status();
  }
  const sharedMs = Date.now() - sharedStart;
  t.after(() => resources.close());
  assert.equal(opened(), rounds + 1, 'with an owner the whole run opens exactly one more connection');
  t.diagnostic(`status x${rounds}: ${rounds} opens ${baselineMs}ms -> 1 open ${sharedMs}ms (avoided ${rounds - 1} opens)`);
});

test('a resource owner lends one connection, refuses a second location, and closes once', async (t) => {
  const { cwd, squarePath } = await fixture('owner');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const owner = createSquareResourceOwner();
  const artifact = owner.artifact(squarePath);
  assert.equal(owner.artifact(path.join(cwd, '.', 'square.square')), artifact, 'same path resolves to one connection');
  assert.throws(() => owner.artifact(path.join(cwd, 'other.square')), /already holds/);

  const borrowed = await openSquare(squarePath, { artifact });
  assert.equal(borrowed.ownsArtifact, false);
  await closeOpenSquare(borrowed);
  assert.ok((await artifact.read((facts) => facts.header())).value.nextActIndex >= 0, 'closing a borrowed view leaves the connection open');

  await owner.close();
  await assert.rejects(() => artifact.read((facts) => facts.header()));
  assert.throws(() => owner.artifact(squarePath), /is closed/);
});

test('a transport disconnect releases the connection even without server.close()', async (t) => {
  const { cwd, squarePath, env } = await fixture('disconnect-release');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const opened = countConnections(t, squarePath);
  const closed = countCloses(t, squarePath);
  const server = createSquareMcpServer({ cwd, env, squarePath });
  const client = await connect(server);
  t.after(async () => { await server.close().catch(() => undefined); });

  await client.callTool({ name: 'join', arguments: {} });
  assert.equal(opened(), 1);
  assert.equal(closed(), 0);
  await client.close();
  for (let attempt = 0; attempt < 200 && closed() === 0; attempt += 1) await sleep(10);
  assert.equal(closed(), 1, 'the server onclose path must drain and release the shared connection');
});

test('reused connections keep per-call participants and harness sessions separate', async (t) => {
  const { cwd, squarePath, env } = await fixture('sessions');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const opened = countConnections(t, squarePath);
  const server = createSquareMcpServer({ cwd, env, squarePath });
  const client = await connect(server);
  t.after(async () => { await client.close().catch(() => undefined); await server.close(); });
  const call = (name, args, meta) => client.callTool({ name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) });

  const first = await call('join', {}, { threadId: 'session-one' });
  assert.equal(first.structuredContent.kind, 'joined');
  const refused = await call('join', {}, { threadId: 'session-two' });
  assert.equal(refused.structuredContent.error.code, 'already_joined');
  const reconnected = await call('join', {}, { threadId: 'session-one' });
  assert.equal(reconnected.structuredContent.kind, 'reconnected');
  await call('join', { as: 'other' });
  const expressed = await call('express', { as: 'other', body: 'other speaks', force: true });
  assert.equal(expressed.structuredContent.activity.actor, 'other');
  assert.equal(opened(), 1);
});
