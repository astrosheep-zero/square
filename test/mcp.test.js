import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Square } from '../dist/square-wiring.js';
import { createSquareMcpServer } from '../dist/mcp.js';

async function fixture(participant = 'rei') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-mcp-'));
  const squarePath = path.join(cwd, 'square.square');
  const square = await Square.build({ path: squarePath, markdown: 'MCP scene' });
  await square.close();
  const env = { ...process.env, SQUARE_REGISTRY: path.join(cwd, 'registry.ndjsonl'), SQUARE_PARTICIPANT_NAME: participant, CODEX_THREAD_ID: `mcp-${participant}` };
  return { cwd, squarePath, env, server: createSquareMcpServer({ cwd, env, squarePath, participant }) };
}

async function connectedClient(server) {
  const client = new Client({ name: 'square-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('MCP tools validate JSON arguments and return stable JSON projections', async () => {
  const { server } = await fixture();
  const { client, close } = await connectedClient(server);
  try {
    assert.equal(client.getServerVersion().name, 'square');
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), [
      'join', 'express', 'catch', 'history', 'listen', 'ignore', 'listening', 'hold', 'resume', 'done', 'status', 'participants',
    ]);
    const invalid = await client.callTool({ name: 'express', arguments: { body: 7 } });
    assert.equal(invalid.isError, true);

    const joined = await client.callTool({ name: 'join', arguments: {} });
    assert.equal(joined.structuredContent.participant, 'rei');
    const expressed = await client.callTool({ name: 'express', arguments: { body: '*waves*', mentions: [] } });
    assert.equal(expressed.structuredContent.activity.body, '*waves*');
    const history = await client.callTool({ name: 'history', arguments: { after: joined.structuredContent.activity.id } });
    assert.equal(history.structuredContent.activities.at(-1).body, '*waves*');
    const status = await client.callTool({ name: 'status', arguments: {} });
    assert.equal('state' in status.structuredContent, false);
    assert.deepEqual(JSON.parse(JSON.stringify(status.structuredContent)), status.structuredContent);
  } finally { await close(); }
});

test('MCP cancellation reaches an in-progress application operation', async () => {
  const { server } = await fixture('aoi');
  const { client, close } = await connectedClient(server);
  try {
    await client.callTool({ name: 'join', arguments: {} });
    await client.callTool({ name: 'hold', arguments: { reason: 'test cancellation' } });
    const controller = new AbortController();
    const pending = client.callTool({ name: 'express', arguments: { body: 'waiting' } }, undefined, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(() => pending);
    const history = await client.callTool({ name: 'history', arguments: {} });
    assert.equal(history.structuredContent.activities.some((activity) => activity.body === 'waiting'), false);
  } finally { await close(); }
});

test('square mcp-server speaks newline-delimited JSON-RPC on stdio', async () => {
  const { cwd, squarePath, env } = await fixture('stdio');
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'ping' },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';
  const child = spawnSync(process.execPath, [path.resolve('dist/square.js'), 'mcp-server'], {
    cwd,
    env: { ...env, SQUARE_LOCATION: squarePath },
    input,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(child.status, 0, child.stderr);
  const responses = child.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(responses.map((response) => response.id), [1, 2, 3]);
  assert.equal(responses[0].result.serverInfo.name, 'square');
  assert.equal(responses[1].result.tools[0].name, 'join');
  assert.deepEqual(responses[2].result, {});

  const help = spawnSync(process.execPath, [path.resolve('dist/square.js'), 'mcp-server', '--help'], { cwd, encoding: 'utf8', timeout: 5000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: square \[--location <square>\] mcp-server$/m);
});
