import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import squarePiExtension, { renderSquareCard } from '../plugins/pi/square-pi.js';
import { createSquareMcpServer } from '../dist/surfaces/mcp.js';
import { SquareError } from '../dist/core/model.js';
import { DeliveryLedger } from '../dist/ledger/delivery-ledger.js';
import { Square } from '../dist/api/square-api.js';
import { harnessOwner } from '../dist/core/owner.js';
import { SQUARE_TOOLS, SQUARE_TOOL_INSTRUCTIONS, squareToolsEnabled } from '../dist/surfaces/square-tools.js';
import { connectPi } from '../dist/packages/agent-delivery/src/pi-client.js';

function setEnv(t, key, value) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

function piFixture(endpoint) {
  const tools = [], renderers = new Map(), flags = new Map(), handlers = new Map(), sent = [];
  squarePiExtension({
    registerTool(tool) { tools.push(tool); },
    registerMessageRenderer(type, renderer) { renderers.set(type, renderer); },
    registerFlag(name, options) { flags.set(name, options); },
    getFlag(name) { assert.equal(name, 'agent-delivery-socket'); return endpoint; },
    on(event, handler) {
      const callbacks = handlers.get(event) ?? [];
      callbacks.push(handler);
      handlers.set(event, callbacks);
    },
    sendMessage(message, options) { sent.push({ message, options }); },
  });
  const emit = async (event, value, ctx) => {
    for (const handler of handlers.get(event) ?? []) await handler(value, ctx);
  };
  return { tools, renderers, flags, handlers, sent, emit };
}

test('SQUARE_TOOLS controls shared parsing, MCP exposure and Pi registration', async (t) => {
  for (const [enabled, values] of [
    [true, [undefined, '', '  ', '1', 'true', ' TrUe ']],
    [false, ['0', 'false', 'none', ' 0 ', ' FaLsE ', ' NoNe ']],
  ]) {
    for (const raw of values) await t.test(raw === undefined ? 'unset' : JSON.stringify(raw), async (t) => {
      setEnv(t, 'SQUARE_TOOLS', raw);
      const env = raw === undefined ? {} : { SQUARE_TOOLS: raw };
      assert.equal(squareToolsEnabled(env), enabled);
      assert.equal(squareToolsEnabled(), enabled);
      const pi = piFixture();
      assert.deepEqual(pi.tools.map(tool => tool.name), enabled ? SQUARE_TOOLS.map(tool => `square_${tool.name}`) : []);
      assert.equal(pi.renderers.get('square'), renderSquareCard);
      assert.equal(pi.flags.get('agent-delivery-socket').type, 'string');
      for (const event of ['session_start', 'agent_start', 'message_end', 'turn_start', 'turn_end', 'agent_settled', 'session_shutdown']) {
        assert.ok(pi.handlers.has(event), event);
      }

      // MCP uses its supplied environment, not the surrounding Pi process setting.
      process.env.SQUARE_TOOLS = enabled ? 'none' : 'true';
      const server = createSquareMcpServer({ env });
      const client = new Client({ name: 'square-tool-toggle-test', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        assert.equal(client.getInstructions(), enabled ? SQUARE_TOOL_INSTRUCTIONS : undefined);
        if (enabled) {
          assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), SQUARE_TOOLS.map(tool => tool.name));
        } else {
          assert.equal(client.getServerCapabilities().tools, undefined);
          await assert.rejects(client.listTools(), error => error.code === -32601);
        }
        assert.deepEqual(await client.ping(), {});
      } finally {
        // Exercise transport-initiated and explicit server shutdown, including repeat close.
        if (enabled) { await client.close(); await server.close(); }
        else { await server.close(); await client.close(); }
        await server.close();
      }
    });
  }
});

test('mute and unmute are standalone optional-location tools with the configured ledger', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-mute-tools-'));
  const squarePath = path.join(root, 'MUTE.square');
  const ledgerLocation = path.join(root, 'delivery.sqlite');
  let now = Date.now();
  const clock = () => now;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const built = await Square.build({ path: squarePath, markdown: 'Tool mute scene', ledgerLocation, clock });
  await built.close();
  const env = { ...process.env, SQUARE_TOOLS: 'true', SQUARE_DELIVERY: ledgerLocation };
  const connect = async (server) => {
    const client = new Client({ name: 'square-mute-tool-test', version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(right), client.connect(left)]);
    t.after(async () => { await client.close(); await server.close(); });
    return client;
  };
  const client = await connect(createSquareMcpServer({ cwd: root, env, owner: 'test:owner', clock }));
  const tools = new Map((await client.listTools()).tools.map(tool => [tool.name, tool]));
  assert.equal(tools.get('mute').description, 'Step back from notifications for a while. Whatever reaches you stays waiting for perceive.');
  assert.equal(tools.get('unmute').description, 'Resume automatic notifications early.');
  assert.deepEqual(tools.get('mute').inputSchema.required, ['duration']);
  assert.equal(tools.get('mute').inputSchema.properties.duration.description, 'How long to pause automatic notifications, like "30m" or "2h".');
  assert.equal(tools.get('mute').inputSchema.properties.location.description, 'Path to the .square file. Omit to mute the entire ledger.');
  assert.equal(tools.get('mute').inputSchema.properties.as.description, 'Your name in the square.');
  assert.equal(tools.get('unmute').inputSchema.properties.location.description, 'Path to the .square file. Omit to unmute the entire ledger.');
  assert.equal(tools.get('mute').inputSchema.additionalProperties, false);
  assert.equal(tools.get('unmute').inputSchema.additionalProperties, false);
  assert.equal('target' in tools.get('mute').inputSchema.properties, false);

  const globalMute = await client.callTool({ name: 'mute', arguments: { duration: '30m' } });
  assert.equal(globalMute.isError, undefined, globalMute.content[0].text);
  assert.match(globalMute.content[0].text, /notifications pause until/);
  let ledger = await DeliveryLedger.open({ location: ledgerLocation, clock });
  try { assert.equal(await ledger.mutedUntil(), now + 30 * 60_000); }
  finally { await ledger.close(); }

  assert.equal((await client.callTool({ name: 'join', arguments: { location: squarePath, as: 'Alice' } })).isError, undefined);
  const localMute = await client.callTool({ name: 'mute', arguments: { location: squarePath, as: 'Alice', duration: '1m' } });
  assert.equal(localMute.isError, undefined, localMute.content[0].text);
  assert.match(localMute.content[0].text, /@Alice steps back from notifications until/);
  const square = await Square.at({ path: squarePath, ledgerLocation, clock });
  const generation = (await square.seatsOf('test:owner')).find(seat => seat.name === 'Alice').generation;
  await square.close();
  ledger = await DeliveryLedger.open({ location: ledgerLocation, clock });
  try {
    assert.equal(await ledger.mutedUntil(), now + 30 * 60_000);
    const seatId = 'square-mute:' + JSON.stringify(['test:owner', ['square', await fs.promises.realpath(squarePath),
      'recipient', 'alice', 'join', generation]]);
    assert.equal((await ledger.suppression({ owner: 'test:owner', id: seatId })).expiresAt, now + 60_000);
  } finally { await ledger.close(); }

  const localUnmute = await client.callTool({ name: 'unmute', arguments: { location: squarePath, as: 'Alice' } });
  assert.equal(localUnmute.isError, undefined, localUnmute.content[0].text);
  assert.match(localUnmute.content[0].text, /@Alice ends their notification hold/);
  const globalUnmute = await client.callTool({ name: 'unmute', arguments: {} });
  assert.equal(globalUnmute.isError, undefined, globalUnmute.content[0].text);
  assert.match(globalUnmute.content[0].text, /the notification hold ends/);

  const invalid = await client.callTool({ name: 'mute', arguments: { duration: '0m' } });
  assert.equal(invalid.isError, true);
  const missing = path.join(root, 'missing.sqlite');
  const refusedClient = await connect(createSquareMcpServer({ cwd: root, env: { ...env, SQUARE_DELIVERY: missing }, owner: 'test:owner', clock }));
  const refused = await refusedClient.callTool({ name: 'mute', arguments: { as: 'Alice', duration: '1m' } });
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, 'as needs a square location for mute');
  assert.equal(fs.existsSync(missing), false);
});

test('unrecognized SQUARE_TOOLS fails fast at each entry point', (t) => {
  setEnv(t, 'SQUARE_TOOLS', 'maybe');
  const invalid = error => error instanceof SquareError && error.code === 'invalid_args'
    && error.message === 'Invalid SQUARE_TOOLS: expected 0, 1, true, false, or none.';
  for (const raw of ['maybe', 'yes', '2']) assert.throws(() => squareToolsEnabled({ SQUARE_TOOLS: raw }), invalid);
  assert.throws(() => createSquareMcpServer({ env: { SQUARE_TOOLS: 'maybe' } }), invalid);
  assert.throws(() => piFixture(), invalid);
});

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Pi notification did not reach its expected delivery boundary');
}

test('hidden Pi tools preserve the local receiver and pending notification delivery', { timeout: 15_000 }, async (t) => {
  for (const raw of ['0', 'false', 'none']) await t.test(raw, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-tools-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    setEnv(t, 'SQUARE_TOOLS', raw);
    setEnv(t, 'SQUARE_DELIVERY', path.join(root, 'delivery.sqlite'));
    const sessionId = `hidden-tools-${raw}`;
    const owner = harnessOwner({ channel: 'pi', session: sessionId });
    const ledger = await DeliveryLedger.open();
    const endpoint = process.platform === 'darwin' ? path.join(root, 'pi.sock') : undefined;
    const pi = piFixture(endpoint);
    const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
    assert.deepEqual(pi.tools, []);
    try {
      await pi.emit('session_start', {}, ctx);
      if (endpoint !== undefined) {
        assert.equal((await connectPi({ harness: 'pi', sessionId, endpoint, timeoutMs: 2_000 })).sessionId, sessionId);
      }
      await ledger.post({ owner, key: ["producer","card"], text: 'still listening @Bob' });
      await waitUntil(() => pi.sent.length === 1);
      const { message, options } = pi.sent[0];
      assert.match(message.content, /still listening @Bob/);
      assert.equal(message.customType, 'square');
      assert.deepEqual(options, { deliverAs: 'steer', triggerTurn: true });
      assert.deepEqual(await ledger.receipts(owner), []);
      await pi.emit('message_end', { message: { role: 'custom', ...message } }, ctx);
      await waitUntil(async () => (await ledger.receipts(owner)).length === 1);
    } finally {
      await pi.emit('session_shutdown', {}, ctx);
      assert.equal((await ledger.session(owner)).state, 'detached');
      await ledger.close();
    }
    if (endpoint !== undefined) assert.equal(fs.existsSync(endpoint), false);
  });
});
