import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import { PaseoWakeTransport } from '../dist/paseo-delivery.js';
import { createArtifactPort } from '../dist/artifact.js';
import { emptyRuntimeState } from '../dist/square-sqlite.js';
import { DeliveryError } from '../dist/packages/agent-delivery/src/index.js';
import { sendPaseoWake } from '../dist/wake-sink.js';
import { waitForPaseoToolBoundary } from '../dist/paseo-timeline.js';

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
  const state = { hellos: [], sends: [], closes: [], headers: [] };
  const sockets = new Set();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket, request) => {
    sockets.add(socket);
    state.headers.push(request.headers);
    state.closes.push(once(socket, 'close'));
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

/** The wake failure itself: one DeliveryError, classified by code and certainty. */
async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DeliveryError, `expected a DeliveryError, got ${error}`);
    return error;
  }
  assert.fail('Expected the Paseo wake to fail.');
}

const attempt = { agentId: 'agent-one', prompt: '<system-reminder source="square">awareness</system-reminder>' };
const coordinates = { location: '/squares/PUBLIC.square', participant: 'Faye', activity: 'act/7', attemptN: 1 };

test('the Paseo fixture uses the SDK version pinned by the repository', async () => {
  const require = createRequire(new URL('../dist/packages/agent-delivery/src/paseo-native.js', import.meta.url));
  const client = require.resolve('@getpaseo/client/internal/daemon-client');
  const installed = JSON.parse(await readFile(path.join(path.dirname(client), '..', 'package.json'), 'utf8'));
  const declared = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(installed.version, declared.devDependencies['@getpaseo/client'],
    'Paseo SDK differs from the repository pin; run npm ci before testing.');
});

test('a Square Paseo wake steers with one stable id per attempt', async (t) => {
  await environment(t);
  const { state, endpoint } = await daemon(t, { onSend: accepted });
  process.env.PASEO_HOST = endpoint;
  const artifact = createArtifactPort(':memory:', { hardCap: null, preamble: [], warmup: [], acts: [], runtime: emptyRuntimeState() });
  t.after(() => artifact.close());
  const join = async (name) => (await artifact.transactAs({ kind: 'join', participant: name,
    owner: `test:${name}` }, facts => {
    facts.land({ kind: 'join', actor: name, at: 1 });
    return facts.seat(name);
  })).value;
  const bev = await join('Bev');
  const seat = await join('Faye');
  await artifact.transactAs({ kind: 'participant', seat: bev }, facts =>
    facts.land({ kind: 'say', actor: 'Bev', at: 2, body: 'stored preview', mentions: ['Faye'] }));
  const transport = new PaseoWakeTransport({
    discover: () => ({ agents: [{ id: 'agent-one', name: 'Faye', status: 'idle' }] }),
    waitForBoundary: async () => true,
  });
  const dispatch = (context) => transport.attempt({ ...context, activity: 'act/2', seat, artifact,
    route: { kind: 'paseo', address: { agentId: 'agent-one' } } }, 5000, async () => true);

  assert.deepEqual(await dispatch(coordinates), { outcome: 'accepted' });
  assert.deepEqual(await dispatch(coordinates), { outcome: 'accepted' });
  assert.equal(state.sends.length, 2);
  assert.equal(state.sends.every((message) => message.activeTurnBehavior === 'steer'), true);
  assert.match(state.sends[0].text, /stored preview/);
  assert.match(state.sends[0].text, /Bev spoke your name\./);
  assert.match(state.sends[0].messageId, /^square-[0-9a-f]{32}$/);
  assert.equal(state.sends[0].messageId, state.sends[1].messageId);

  await dispatch({ ...coordinates, attemptN: 2 });
  assert.equal(state.sends[2].activeTurnBehavior, 'steer');
  assert.notEqual(state.sends[2].messageId, state.sends[0].messageId);
  await Promise.all(state.closes);
});

test('the installed Paseo SDK reads a real timeline and retires its socket', { timeout: 5000 }, async (t) => {
  await environment(t);
  const { state, endpoint } = await daemon(t, { onSend: (message) => {
    assert.equal(message.type, 'fetch_agent_timeline_request');
    return { type: 'fetch_agent_timeline_response', payload: {
      requestId: message.requestId, agentId: message.agentId,
      agent: { id: message.agentId, provider: 'codex', cwd: '/tmp', model: null,
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        lastUserMessageAt: null, status: 'idle', currentModeId: null, availableModes: [],
        pendingPermissions: [], persistence: null, title: null,
        capabilities: { supportsStreaming: true, supportsSessionPersistence: true,
          supportsDynamicModes: false, supportsMcpServers: false, supportsReasoningStream: false,
          supportsToolInvocations: true } },
      direction: 'tail', projection: 'projected', epoch: 'epoch', reset: false,
      staleCursor: false, gap: false, window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
      startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, entries: [], error: null,
    } };
  } });
  process.env.PASEO_HOST = endpoint;
  process.env.PASEO_PASSWORD = 'fixture-password';
  assert.equal(await waitForPaseoToolBoundary('agent-one'), true);
  assert.equal(state.sends.length, 1);
  assert.equal(state.sends[0].agentId, 'agent-one');
  assert.equal(state.sends[0].projection, 'projected');
  assert.equal(state.headers.length, 1);
  assert.equal(state.headers[0].authorization, 'Bearer fixture-password');
  assert.equal(state.headers[0]['sec-websocket-protocol'], 'paseo.bearer.fixture-password');
  await Promise.all(state.closes);
});

test('a refused Paseo wake is a proven pre-accept rejection', async (t) => {
  await environment(t);
  const { endpoint } = await daemon(t, { onSend: (message) => refused(message, 'Agent not found: agent-one') });
  process.env.PASEO_HOST = endpoint;
  const error = await failure(sendPaseoWake({ ...attempt, ...coordinates }, { timeoutMs: 2000 }));
  assert.equal(error.code, 'session_not_found');
  assert.equal(error.maybeDelivered, false);
});

test('a refused Paseo credential is a pre-accept rejection', async (t) => {
  await environment(t);
  const { state, endpoint } = await daemon(t, { onHello: (socket) => socket.close(4401, 'Incorrect password') });
  process.env.PASEO_HOST = endpoint;
  const error = await failure(sendPaseoWake({ ...attempt, ...coordinates }, { timeoutMs: 2000 }));
  assert.equal(error.code, 'authentication_failed');
  assert.equal(error.maybeDelivered, false);
  assert.deepEqual(state.sends, []);
});

test('an unreachable Paseo daemon is a transient pre-accept failure', async (t) => {
  await environment(t);
  process.env.PASEO_HOST = await deadEndpoint();
  const error = await failure(sendPaseoWake({ ...attempt, ...coordinates }, { timeoutMs: 2000 }));
  assert.equal(error.code, 'unavailable');
  assert.equal(error.maybeDelivered, false);
});

test('a Paseo send dropped after the connection is unknown, never a retry', async (t) => {
  await environment(t);
  const { endpoint } = await daemon(t, { onSend: (_message, socket) => { socket.terminate(); } });
  process.env.PASEO_HOST = endpoint;
  const error = await failure(sendPaseoWake({ ...attempt, ...coordinates }, { timeoutMs: 2000 }));
  assert.equal(error.maybeDelivered, true);
});

test('a daemon that never answers the send fails inside the dispatch budget', async (t) => {
  await environment(t);
  const { state, endpoint } = await daemon(t, { onSend: () => undefined });
  process.env.PASEO_HOST = endpoint;
  const started = Date.now();
  const error = await failure(sendPaseoWake({ ...attempt, ...coordinates }, { timeoutMs: 200 }));
  assert.equal(error.maybeDelivered, true);
  const elapsed = Date.now() - started;
  assert.equal(state.sends.length, 1);
  assert.ok(elapsed < 1_000, `one wake spent more than its dispatch budget: ${elapsed}ms`);
});

test('unusable Paseo wake arguments fail before anything is sent', async (t) => {
  await environment(t);
  const { state, endpoint } = await daemon(t, { onSend: accepted });
  process.env.PASEO_HOST = endpoint;
  const error = await failure(sendPaseoWake({ ...attempt, ...coordinates }, { timeoutMs: 0 }));
  assert.equal(error.code, 'invalid_arguments');
  assert.equal(error.maybeDelivered, false);
  assert.deepEqual(state.sends, []);
});
