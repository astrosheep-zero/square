import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Square } from '../dist/square-wiring.js';
import { createSquareMcpServer } from '../dist/mcp.js';
import { createSquareApplication } from '../dist/square-application.js';
import { hostLedgerForEnv, readParticipantOwner } from '../dist/registry.js';

const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

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
    assert.deepEqual(client.getServerVersion(), { name: 'square', version: packageVersion });
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), [
      'join', 'express', 'catch', 'history', 'listen', 'ignore', 'listening', 'hold', 'resume', 'done', 'status', 'participants',
    ]);
    const invalid = await client.callTool({ name: 'express', arguments: { body: 7 } });
    assert.equal(invalid.isError, true);

    const joined = await client.callTool({ name: 'join', arguments: {} });
    assert.equal(joined.structuredContent.participant, 'rei');
    const reconnected = await client.callTool({ name: 'join', arguments: {} });
    assert.equal(reconnected.structuredContent.kind, 'reconnected');
    const expressed = await client.callTool({ name: 'express', arguments: { body: '*waves*', mentions: [] } });
    assert.equal(expressed.structuredContent.activity.body, '*waves*');
    const history = await client.callTool({ name: 'history', arguments: { after: joined.structuredContent.activity.id } });
    assert.equal(history.structuredContent.activities.at(-1).body, '*waves*');
    const status = await client.callTool({ name: 'status', arguments: {} });
    assert.equal('state' in status.structuredContent, false);
    assert.deepEqual(JSON.parse(JSON.stringify(status.structuredContent)), status.structuredContent);
  } finally { await close(); }
});

test('one MCP server accepts per-call participants without a configured default', async () => {
  const { cwd, squarePath, env } = await fixture();
  const baseEnv = { ...env };
  delete baseEnv.SQUARE_PARTICIPANT_NAME;
  const beforeProcessEnv = { ...process.env };
  const beforeBaseEnv = { ...baseEnv };
  const { client, close } = await connectedClient(createSquareMcpServer({ cwd, squarePath, env: baseEnv }));
  try {
    const tools = (await client.listTools()).tools;
    for (const name of ['join', 'express', 'catch', 'listen', 'ignore', 'listening', 'hold', 'resume', 'done']) {
      const schema = tools.find((tool) => tool.name === name).inputSchema;
      assert.equal(schema.properties.as.type, 'string');
      assert.equal(schema.properties.as.description, "Participant name, same as --as. Defaults to the server's configured participant.");
      assert.equal(schema.required?.includes('as') ?? false, false);
      assert.equal('session' in schema.properties, false);
    }
    const missing = await client.callTool({ name: 'join', arguments: {} });
    assert.equal(missing.structuredContent.error.code, 'invalid_args');
    assert.match(missing.structuredContent.error.message, /unambiguous participant name/);
    for (const as of ['alice', 'bob']) {
      const joined = await client.callTool({ name: 'join', arguments: { as } });
      assert.equal(joined.structuredContent.participant, as);
      const expressed = await client.callTool({ name: 'express', arguments: { as, body: `${as} speaks`, force: true } });
      assert.equal(expressed.structuredContent.activity.actor, as);
    }
    const history = await client.callTool({ name: 'history', arguments: {} });
    assert.deepEqual(history.structuredContent.activities.filter((activity) => activity.kind === 'say').map(({ actor, body }) => ({ actor, body })), [
      { actor: 'alice', body: 'alice speaks' }, { actor: 'bob', body: 'bob speaks' },
    ]);
    await client.callTool({ name: 'listen', arguments: { as: 'alice', target: 'bob' } });
    assert.deepEqual((await client.callTool({ name: 'listening', arguments: { as: 'alice' } })).structuredContent.listening, ['bob']);
    await client.callTool({ name: 'ignore', arguments: { as: 'alice', target: 'bob' } });
    assert.deepEqual((await client.callTool({ name: 'listening', arguments: { as: 'alice' } })).structuredContent.listening, []);
    for (const name of ['catch', 'hold', 'resume', 'done']) {
      const result = await client.callTool({ name, arguments: { as: 'alice' } });
      assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    }
    assert.deepEqual({ ...process.env }, beforeProcessEnv);
    assert.deepEqual(baseEnv, beforeBaseEnv);
  } finally { await close(); }
});

test('MCP request metadata owns the name with the live harness coordinate, not startup env', async (t) => {
  for (const [key, channel] of [['threadId', 'codex'], ['ai.opencode/sessionID', 'opencode']]) {
    await t.test(channel, async () => {
      const { server, squarePath, env } = await fixture();
      const beforeProcessEnv = { ...process.env };
      const beforeBaseEnv = { ...env };
      const { client, close } = await connectedClient(server);
      const ledger = hostLedgerForEnv(env);
      try {
        const callJoin = (session) => client.callTool({ name: 'join', arguments: {}, _meta: { [key]: session } });
        const joined = await callJoin(`${channel}-first`);
        assert.equal(joined.structuredContent.kind, 'joined');
        const owner = await readParticipantOwner(squarePath, 'rei', ledger);
        assert.equal(owner.session, `${channel}-first`);
        assert.equal(owner.channel, channel);
        const refused = await callJoin(`${channel}-second`);
        assert.equal(refused.structuredContent.error.code, 'already_joined');
        assert.equal((await readParticipantOwner(squarePath, 'rei', ledger)).session, `${channel}-first`);
        const reconnected = await callJoin(`${channel}-first`);
        assert.equal(reconnected.structuredContent.kind, 'reconnected');
        const fallback = await client.callTool({ name: 'join', arguments: {} });
        assert.equal(fallback.structuredContent.error.code, 'already_joined');
        assert.deepEqual({ ...process.env }, beforeProcessEnv);
        assert.deepEqual(env, beforeBaseEnv);
      } finally { await close(); }
    });
  }
});

test('MCP tool schemas reject unknown fields and malformed activity ids', async () => {
  const { server } = await fixture('kite');
  const { client, close } = await connectedClient(server);
  try {
    const unknownField = await client.callTool({ name: 'join', arguments: { takeover: false, bogus: 1 } });
    assert.equal(unknownField.isError, true);

    const sessionField = await client.callTool({ name: 'join', arguments: { session: 'not-a-schema-field' } });
    assert.equal(sessionField.isError, true);

    const malformed = await client.callTool({ name: 'history', arguments: { after: 'act/01' } });
    assert.equal(malformed.isError, true);

    const joined = await client.callTool({ name: 'join', arguments: { takeover: false } });
    assert.equal(joined.isError, undefined);
    await client.callTool({ name: 'express', arguments: { body: 'schema check' } });
    const history = await client.callTool({ name: 'history', arguments: { after: joined.structuredContent.activity.id } });
    assert.equal(history.isError, undefined);
    assert.deepEqual(history.structuredContent.activities.map((activity) => activity.body), ['schema check']);
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

test('stdio disconnect aborts held express and idle catch without later mutation or consumption', async (t) => {
  const { cwd, squarePath, env } = await fixture('disconnected');
  const app = createSquareApplication({ cwd, squarePath, env, participant: 'disconnected' });
  const child = spawn(process.execPath, [path.resolve('dist/square.js'), 'mcp-server'], {
    cwd, env: { ...env, SQUARE_LOCATION: squarePath }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const responses = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  let id = 0;
  const send = (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
    return id;
  };
  const request = async (method, params) => {
    const requestId = send(method, params);
    const response = JSON.parse((await responses.next()).value);
    assert.equal(response.id, requestId);
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    return response.result;
  };
  await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'disconnect-test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await request('tools/call', { name: 'join', arguments: {} });
  await request('tools/call', { name: 'hold', arguments: {} });
  await request('tools/call', { name: 'catch', arguments: {} });
  send('tools/call', { name: 'express', arguments: { body: 'orphan expression', force: true } });
  send('tools/call', { name: 'catch', arguments: { idle: 60_000 } });
  await request('ping');
  await sleep(100);

  const disconnected = once(child, 'exit', { signal: AbortSignal.timeout(3000) });
  child.stdin.end();
  assert.deepEqual(await disconnected, [0, null], stderr);
  await app.resume();
  assert.equal((await app.history()).some((activity) => activity.body === 'orphan expression'), false);
  const writer = createSquareApplication({ cwd, squarePath, env: { ...env, CODEX_THREAD_ID: 'mcp-writer' }, participant: 'writer' });
  await writer.join();
  const expressed = await writer.express('after disconnect', { force: true, mentions: ['disconnected'] });
  const caught = await app.catch();
  assert.ok(caught.activities.some((activity) => activity.id === expressed.activity.id));
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
  assert.deepEqual(responses[0].result.serverInfo, { name: 'square', version: packageVersion });
  assert.equal(responses[1].result.tools[0].name, 'join');
  assert.deepEqual(responses[2].result, {});

  const help = spawnSync(process.execPath, [path.resolve('dist/square.js'), 'mcp-server', '--help'], { cwd, encoding: 'utf8', timeout: 5000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: square \[--location <square>\] mcp-server$/m);
  assert.match(help.stdout, /Participant tools accept as on each call/);
  assert.match(help.stdout, /_meta\.threadId/);
});
