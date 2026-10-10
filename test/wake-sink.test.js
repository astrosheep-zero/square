import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import { PaseoAdapter } from '../dist/paseo-delivery.js';
import { PaseoWakeSendError, sendPaseoWake } from '../dist/wake-sink.js';

const CONTROLLED = ['PASEO_HOST', 'PASEO_HOME', 'PASEO_PASSWORD'];

/** This machine's real Paseo environment must not reach any test. */
async function environment(t) {
  const saved = new Map(CONTROLLED.map((name) => [name, process.env[name]]));
  for (const name of CONTROLLED) delete process.env[name];
  const home = await mkdtemp(path.join(os.tmpdir(), 'square-paseo-wake-'));
  process.env.PASEO_HOME = home;
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return home;
}

const frame = (socket, message) => socket.send(JSON.stringify({ type: 'session', message }));
const accepted = (message) => ({
  type: 'send_agent_message_response',
  payload: { requestId: message.requestId, agentId: message.agentId, accepted: true, error: null },
});
const refused = (message, error) => ({
  type: 'send_agent_message_response',
  payload: { requestId: message.requestId, agentId: message.agentId, accepted: false, error },
});

/** A daemon stand-in that records the sends it was asked to perform. */
async function daemon(t, { onSend, onHello } = {}) {
  const state = { hellos: [], sends: [] };
  const sockets = new Set();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('message', (raw) => {
      const envelope = JSON.parse(raw.toString());
      if (envelope.type === 'ping') return void socket.send(JSON.stringify({ type: 'pong' }));
      if (envelope.type === 'hello') {
        state.hellos.push(envelope);
        if (onHello) return void onHello(socket, envelope, state);
        return void frame(socket, { type: 'status', payload: { status: 'server_info', serverId: 'srv_test', version: '0.11.2' } });
      }
      const message = envelope.message;
      state.sends.push(message);
      const answer = onSend?.(message, socket, state);
      if (answer !== undefined) frame(socket, answer);
    });
  });
  await once(server, 'listening');
  const endpoint = `tcp://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((done) => { for (const socket of sockets) socket.terminate(); server.close(done); }));
  return { state, endpoint };
}

async function deadEndpoint() {
  const closed = net.createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const endpoint = `tcp://127.0.0.1:${closed.address().port}`;
  await new Promise((done) => closed.close(done));
  return endpoint;
}

async function failureKind(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PaseoWakeSendError, `expected a PaseoWakeSendError, got ${error}`);
    return error.kind;
  }
  assert.fail('Expected the Paseo wake to fail.');
}

const attempt = { agentId: 'agent-one', prompt: '<system-reminder source="square">awareness</system-reminder>' };
const coordinates = { location: '/squares/PUBLIC.square', participant: 'Faye', activity: 'act/7', attemptN: 1 };

test('a Square Paseo wake steers with one stable id per attempt', async (t) => {
  await environment(t);
  const { state, endpoint } = await daemon(t, { onSend: accepted });
  process.env.PASEO_HOST = endpoint;
  const adapter = new PaseoAdapter({
    discover: () => ({ agents: [{ id: 'agent-one', name: 'Faye', status: 'idle' }] }),
    waitForBoundary: async () => true,
  });
  const dispatch = (context) => adapter.dispatch(
    { agentId: 'agent-one' },
    attempt.prompt,
    async () => true,
    5000,
    context
  );

  assert.deepEqual(await dispatch(coordinates), { outcome: 'accepted' });
  assert.deepEqual(await dispatch(coordinates), { outcome: 'accepted' });
  assert.equal(state.sends.length, 2);
  assert.equal(state.sends.every((message) => message.activeTurnBehavior === 'steer'), true);
  assert.equal(state.sends[0].text, attempt.prompt);
  assert.match(state.sends[0].messageId, /^square-[0-9a-f]{32}$/);
  assert.equal(state.sends[0].messageId, state.sends[1].messageId);

  await dispatch({ ...coordinates, attemptN: 2 });
  assert.equal(state.sends[2].activeTurnBehavior, 'steer');
  assert.notEqual(state.sends[2].messageId, state.sends[0].messageId);
});

test('a refused Paseo wake is a proven pre-accept rejection', async (t) => {
  await environment(t);
  const { endpoint } = await daemon(t, { onSend: (message) => refused(message, 'Agent not found: agent-one') });
  process.env.PASEO_HOST = endpoint;
  assert.equal(await failureKind(sendPaseoWake({ ...attempt, ...coordinates }, { timeoutMs: 2000 })), 'rejected');
});

test('a refused Paseo credential is a pre-accept rejection', async (t) => {
  await environment(t);
  const { state, endpoint } = await daemon(t, { onHello: (socket) => socket.close(4401, 'Incorrect password') });
  process.env.PASEO_HOST = endpoint;
  assert.equal(await failureKind(sendPaseoWake({ ...attempt, ...coordinates }, { timeoutMs: 2000 })), 'rejected');
  assert.deepEqual(state.sends, []);
});

test('an unreachable Paseo daemon is a transient pre-accept failure', async (t) => {
  await environment(t);
  process.env.PASEO_HOST = await deadEndpoint();
  assert.equal(await failureKind(sendPaseoWake({ ...attempt, ...coordinates }, { timeoutMs: 2000 })), 'transient');
});

test('a Paseo send dropped after the connection is unknown, never a retry', async (t) => {
  await environment(t);
  const { endpoint } = await daemon(t, { onSend: (_message, socket) => { socket.terminate(); } });
  process.env.PASEO_HOST = endpoint;
  assert.equal(await failureKind(sendPaseoWake({ ...attempt, ...coordinates }, { timeoutMs: 2000 })), 'unknown');
});

test('a daemon that never answers the send fails inside the dispatch budget', async (t) => {
  await environment(t);
  const { state, endpoint } = await daemon(t, { onSend: () => undefined });
  process.env.PASEO_HOST = endpoint;
  const started = Date.now();
  assert.equal(await failureKind(sendPaseoWake({ ...attempt, ...coordinates }, { timeoutMs: 200 })), 'unknown');
  const elapsed = Date.now() - started;
  assert.equal(state.sends.length, 1);
  assert.ok(elapsed < 1_000, `one wake spent more than its dispatch budget: ${elapsed}ms`);
});

test('unusable Paseo wake arguments fail before anything is sent', async (t) => {
  await environment(t);
  const { state, endpoint } = await daemon(t, { onSend: accepted });
  process.env.PASEO_HOST = endpoint;
  assert.equal(await failureKind(sendPaseoWake({ ...attempt, ...coordinates }, { timeoutMs: 0 })), 'rejected');
  assert.deepEqual(state.sends, []);
});
