import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import squarePiExtension, { renderSquareCard } from '../plugins/pi/square-pi.js';
import { createSquareMcpServer } from '../dist/mcp.js';
import { SquareError } from '../dist/model.js';
import { Square } from '../dist/square-api.js';
import { SQUARE_TOOLS, SQUARE_TOOL_INSTRUCTIONS, squareToolsEnabled } from '../dist/square-tools.js';
import { connectPi } from '../dist/packages/agent-delivery/src/pi-client.js';
import { hasPresentedForOwner } from './presentation-fixtures.js';

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
    setEnv(t, 'SQUARE_INDEX', path.join(root, 'index.ndjsonl'));
    const sessionId = `hidden-tools-${raw}`;
    const squarePath = path.join(root, 'test.square');
    const square = await Square.build({ path: squarePath, markdown: 'Hidden tools, live notifications' });
    try {
      const { participant: alice } = await square.join('Alice', { owner: `pi:${sessionId}-author` });
      await square.join('Bob', { owner: `pi:${sessionId}` });
      const { activity } = await alice.express('still listening @Bob', { force: true });
      const endpoint = process.platform === 'darwin' ? path.join(root, 'pi.sock') : undefined;
      const pi = piFixture(endpoint);
      const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
      assert.deepEqual(pi.tools, []);
      try {
        await pi.emit('session_start', {}, ctx);
        if (endpoint !== undefined) {
          assert.equal((await connectPi({ harness: 'pi', sessionId, endpoint, timeoutMs: 2_000 })).sessionId, sessionId);
        }
        await waitUntil(() => pi.sent.length === 1);
        const { message, options } = pi.sent[0];
        assert.match(message.content, /still listening @Bob/);
        assert.equal(message.customType, 'square');
        assert.equal(message.details.items[0].body, 'still listening @Bob');
        assert.deepEqual(options, { deliverAs: 'steer', triggerTurn: true });
        await pi.emit('message_end', { message: { role: 'custom', ...message } }, ctx);
        await waitUntil(() => hasPresentedForOwner(sessionId, squarePath, 'Bob', Number(activity.id.slice(4))));
      } finally {
        await pi.emit('session_shutdown', {}, ctx);
      }
      if (endpoint !== undefined) assert.equal(fs.existsSync(endpoint), false);
      const { participants } = await square.status();
      assert.equal(participants.find(participant => participant.name === 'Bob').presence, 'away');
    } finally { await square.close(); }
  });
});
