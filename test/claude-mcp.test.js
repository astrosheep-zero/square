import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSquareMcpServer } from '../dist/mcp.js';
import { Square } from '../dist/square-application.js';
import { runClaudeMod } from '../dist/claude-mod.js';
import { readClaudeMcpCall } from '../dist/claude-mcp-context.js';
import { hostLedgerForEnv, readParticipantOwner } from '../dist/registry.js';
import { register } from '../plugins/claude/hooks/register.js';

async function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-claude-mcp-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const squarePath = path.join(cwd, 'test.square');
  const square = await Square.build({ path: squarePath, markdown: 'Claude MCP' });
  await square.close();
  const env = { ...process.env, SQUARE_HOST_LEDGER_ROOT: path.join(cwd, 'ledger'), SQUARE_CLAUDE_MCP_CONTEXT: '1', CLAUDE_CODE_SESSION_ID: 'stale-startup' };
  const server = createSquareMcpServer({ cwd: '/stale/cwd', env });
  const client = new Client({ name: 'claude-code-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); });
  const handlers = new Map();
  const coordinate = { sessionId: 'current-main', cwd };
  const $ = {
    session: { id: async () => coordinate.sessionId, cwd: async () => coordinate.cwd, version: async () => ({ version: '2.1.299' }) },
    env: { get: async () => undefined },
    state: { get: async () => ({ version: 0 }), set: async () => ({}) },
    ui: { log: async () => {} },
    process: { run: async (argv, options) => {
      assert.deepEqual(argv, ['square', 'claude-mod']);
      return { exitCode: 0, stdout: await runClaudeMod(options.stdin, env) };
    } },
  };
  register((name, handler) => handlers.set(name, handler));
  let index = 0;
  const call = async (name, args = {}, agentId, signal = new AbortController().signal) => {
    const id = `toolu_test_${index++}`;
    const event = { ...args, tool: `mcp__plugin_square_square__${name}`, tool_use_id: id, agentId };
    const next = Object.assign(async (received) => {
      assert.equal(received, event, 'mod does not rewrite model arguments');
      const context = await readClaudeMcpCall(id, env);
      assert.equal(context.sessionId, coordinate.sessionId);
      assert.equal(context.agentId, agentId);
      return client.callTool({ name, arguments: args, _meta: { 'claudecode/toolUseId': id } }, undefined, { signal });
    }, { signal });
    try { return await handlers.get('tool.call')($, event, next); }
    finally { await assert.rejects(readClaudeMcpCall(id, env), /context|identity|unavailable|missing|expired/i); }
  };
  return { env, cwd, squarePath, client, call, coordinate };
}

test('Claude MCP business schemas stay clean while mod supplies live main and child ownership', async (t) => {
  const { env, squarePath, client, call, coordinate } = await fixture(t);
  const before = { ...process.env };
  for (const tool of (await client.listTools()).tools) {
    for (const field of ['sessionId', 'agentId', 'toolUseId', 'token']) assert.equal(field in tool.inputSchema.properties, false);
  }
  const joined = await call('join', { location: 'test.square', as: 'main' });
  assert.equal(joined.structuredContent.kind, 'joined');
  const ledger = hostLedgerForEnv(env);
  assert.equal((await readParticipantOwner(squarePath, 'main', ledger)).session, 'current-main');
  const childReconnect = await call('join', { location: 'test.square', as: 'main' }, 'child-a');
  assert.equal(childReconnect.structuredContent.kind, 'reconnected', 'a child loop retains its native parent session, as before');
  const children = await Promise.all(['child-a', 'child-b'].map(agentId => call('join', { location: 'test.square', as: agentId }, agentId)));
  assert.ok(children.every(result => !result.isError));
  for (const name of ['child-a', 'child-b']) assert.equal((await readParticipantOwner(squarePath, name, ledger)).session, 'current-main');

  coordinate.sessionId = 'after-clear';
  const newMain = await call('join', { location: 'test.square', as: 'after-clear' });
  assert.equal(newMain.structuredContent.kind, 'joined');
  assert.equal((await readParticipantOwner(squarePath, 'after-clear', ledger)).session, 'after-clear');
  assert.deepEqual({ ...process.env }, before);
});

test('Claude MCP refuses absent host association instead of using startup identity', async (t) => {
  const { client } = await fixture(t);
  for (const meta of [undefined, { 'claudecode/toolUseId': 'toolu_missing' }]) {
    const result = await client.callTool({ name: 'join', arguments: { location: 'test.square', as: 'unbound' }, _meta: meta });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'unavailable');
  }
});

test('cancelling Claude MCP work cleans the association and does not land a held body', async (t) => {
  const { call } = await fixture(t);
  await call('join', { location: 'test.square', as: 'main' });
  await call('hold', { location: 'test.square', as: 'main' });
  const controller = new AbortController();
  const pending = call('express', { location: 'test.square', as: 'main', body: 'cancelled body' }, undefined, controller.signal);
  const timer = setTimeout(() => controller.abort(), 40);
  try { await assert.rejects(pending); } finally { clearTimeout(timer); }
  const result = await call('history', { location: 'test.square' });
  assert.equal(result.structuredContent.activities.some(activity => activity.body === 'cancelled body'), false);
});
