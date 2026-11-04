import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { writeClaudeNative } from '../dist/packages/agent-delivery/src/claude-native.js';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { renderDeliveryReminder } from '../dist/delivery-frame.js';
import { attachDeliverySession, attachDeliverySessionRoutes, detachDeliverySession, markDeliverySessionDeleted } from '../dist/session-lifecycle.js';
import { HttpWakeTransport } from '../dist/http-delivery.js';
import { createClaudeWakeTransport, hashPayload } from '../dist/claude-transport.js';
import { PaseoWakeTransport } from '../dist/paseo-delivery.js';

const owner = 'test:push';
const card = { seq: 1, owner, key: 'producer:one', text: 'hello', postedAt: 1 };
const context = overrides => ({ token: 'handoff-token', deadline: Date.now() + 5000, signal: new AbortController().signal,
  prepare: async () => true, beforeSend: async () => true, ...overrides });

test('session reconnect preserves routes and stale generations cannot detach or delete', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-session-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = { SQUARE_DELIVERY: path.join(dir, 'delivery.sqlite') };
  const routes = [{ kind: 'http', address: { url: 'https://example.test/' } }];
  const first = await attachDeliverySession(owner, env, routes);
  assert.equal(await detachDeliverySession(owner, first.generation, env), true);
  const second = await attachDeliverySession(owner, env);
  assert.deepEqual(second.routes, routes);
  const third = await attachDeliverySessionRoutes(owner, env, [{ kind: 'paseo', address: { agentId: 'a' } }]);
  assert.deepEqual(third.routes, [...routes, { kind: 'paseo', address: { agentId: 'a' } }]);
  assert.equal(await detachDeliverySession(owner, first.generation, env), false);
  assert.equal(await markDeliverySessionDeleted(owner, third.generation, env), true);
  assert.equal(await attachDeliverySession(owner, env), false);
});

test('HTTP accepted is custody only and card fields are producer-neutral', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-http-'));
  const ledger = await DeliveryLedger.open({ location: path.join(dir, 'ledger.sqlite') });
  t.after(async () => { await ledger.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const session = await ledger.attach({ owner, expectedGeneration: null, routes: [{ kind: 'http', address: { url: 'https://example.test/' } }] });
  await ledger.post({ owner, key: card.key, text: card.text });
  let body;
  const transport = new HttpWakeTransport({ fetch: async (_url, options) => { body = JSON.parse(options.body); return new Response(null, { status: 204 }); } });
  const result = await ledger.dispatchHandoff(owner, card.key, transport, { generation: session.generation, timeoutMs: 1000 });
  assert.equal(result.outcome, 'accepted');
  assert.deepEqual(body, { owner, key: card.key, text: card.text });
  assert.deepEqual(await ledger.receipts(owner), []);
});

test('HTTP unknown after a lost acknowledgement never automatically replays', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-http-unknown-'));
  const ledger = await DeliveryLedger.open({ location: path.join(dir, 'ledger.sqlite') });
  t.after(async () => { await ledger.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const session = await ledger.attach({ owner, expectedGeneration: null, routes: [{ kind: 'http', address: { url: 'https://example.test/' } }] });
  await ledger.post({ owner, key: card.key, text: card.text });
  let sends = 0;
  const transport = new HttpWakeTransport({ fetch: async () => { sends++; throw new Error('connection lost'); } });
  const dispatch = () => ledger.dispatchHandoff(owner, card.key, transport, { generation: session.generation, timeoutMs: 1000 });
  assert.equal((await dispatch()).outcome, 'unknown');
  assert.equal((await dispatch()).outcome, 'not-invoked');
  assert.equal(sends, 1);
  assert.deepEqual(await ledger.receipts(owner), []);
});

test('HTTP refuses an expired final-send deadline without starting I/O', async () => {
  let sends = 0;
  const transport = new HttpWakeTransport({ fetch: async () => { sends++; return new Response(null, { status: 204 }); } });
  const result = await transport.send(card, { url: 'https://example.test/' }, context({ deadline: Date.now() - 1 }));
  assert.equal(result, 'not-capable');
  assert.equal(sends, 0);
});

test('Paseo requires idle and hands the ledger token to the sender as its message id', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-paseo-'));
  const ledger = await DeliveryLedger.open({ location: path.join(dir, 'ledger.sqlite') });
  t.after(async () => { await ledger.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const session = await ledger.attach({ owner, expectedGeneration: null, routes: [{ kind: 'paseo', address: { agentId: 'agent' } }] });
  await ledger.post({ owner, key: card.key, text: card.text });
  let status = 'running', sent;
  const transport = new PaseoWakeTransport({ discover: async () => ({ agents: [{ id: 'agent', status }] }),
    waitForBoundary: async () => true, sendWake: async request => { sent = request; } });
  const dispatch = () => ledger.dispatchHandoff(owner, card.key, transport, { generation: session.generation, timeoutMs: 1000 });
  assert.equal((await dispatch()).outcome, 'failed');
  assert.equal(sent, undefined);
  status = 'idle';
  const result = await dispatch();
  assert.equal(result.outcome, 'accepted');
  assert.equal(sent.messageId, result.token);
  assert.equal(sent.prompt, renderDeliveryReminder([card.text], { tagged: true }));
  assert.deepEqual(await ledger.receipts(owner), []);
});

test('Claude native checks the final fence after connecting and suppresses all bytes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-claude-'));
  const endpoint = path.join(dir, 'socket');
  let bytes = '';
  const closed = Promise.withResolvers();
  const server = net.createServer(socket => { socket.on('data', data => { bytes += data; }); socket.on('end', () => closed.resolve()); });
  server.listen(endpoint);
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  let checked = false;
  const result = await writeClaudeNative({ sessionId: 'test', endpoint, claudeHome: dir }, 'hello', {
    deadline: Date.now() + 1000, beforeSend: async () => { checked = true; return false; },
  });
  await closed.promise;
  assert.equal(checked, true);
  assert.equal(result.outcome, 'unavailable');
  assert.equal(bytes, '');
});

test('Claude native carries the ledger token and records the exact frame hash, without claiming admission', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-claude-frame-'));
  const endpoint = path.join(dir, 'socket');
  const received = Promise.withResolvers();
  const server = net.createServer(socket => { let bytes = ''; socket.on('data', data => { bytes += data; }); socket.on('end', () => received.resolve(bytes)); });
  server.listen(endpoint);
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  let correlation;
  const result = await createClaudeWakeTransport({ CLAUDE_CONFIG_DIR: dir }).send(card,
    { loaded: 'true', endpoint, sessionId: 'test' }, context({ prepare: async value => { correlation = value; return true; } }));
  const frame = JSON.parse((await received.promise).trim().split('\n').at(-1));
  assert.equal(result, 'unknown');
  assert.equal(correlation.token, 'handoff-token');
  assert.equal(correlation.messageId, frame.uuid);
  assert.equal(correlation.payloadHash, hashPayload(frame.message.content));
  assert.match(frame.message.content, /^This is an external notification, not a direct message from the user\.\n\n\[square-inbox:handoff-token\]\nhello\n\[\/square-inbox:handoff-token\]$/);
  assert.doesNotMatch(frame.message.content, /<\/?system-reminder>/);
});

test('Paseo forwards its final ledger fence to the sink', async () => {
  let calls = 0;
  const paseo = new PaseoWakeTransport({ discover: async () => ({ agents: [{ id: 'id', status: 'idle' }] }),
    waitForBoundary: async () => true, sendWake: async (_request, opts) => { if (await opts.beforeSend()) calls++; } });
  await paseo.send(card, { agentId: 'id' }, context({ beforeSend: async () => false }));
  assert.equal(calls, 0);
});
