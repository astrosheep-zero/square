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
import { Square, selectOwnSeat } from '../dist/square-api.js';
import { createArtifactPort } from '../dist/artifact.js';
import { createSquareMcpServer } from '../dist/mcp.js';
import { beginClaudeMcpCall, endClaudeMcpCall } from '../dist/claude-mcp-context.js';
import { commandIdentity } from '../dist/cli/context.js';
import { presentPendingAtBoundary } from '../dist/boundary-presentation.js';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import squarePiExtension from '../plugins/pi/square-pi.js';

const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

async function fixture(participant = 'rei', options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-mcp-'));
  const squarePath = path.join(cwd, 'square.square');
  const square = await Square.build({ path: squarePath, markdown: 'MCP scene', ...options });
  await square.close();
  const env = { ...process.env, SQUARE_INDEX: path.join(cwd, 'index.ndjsonl'), CODEX_THREAD_ID: `mcp-${participant}` };
  const body = "codex" + ":" + `mcp-${participant}`;
  return { cwd, squarePath, env, body, server: createSquareMcpServer({ cwd, env, path: squarePath, owner: body }) };
}

async function connectedClient(server) {
  const client = new Client({ name: 'square-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('CLI, MCP and Pi tools share addressless Pi seats despite Paseo in the environment', async t => {
  const { cwd, squarePath } = await fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env, SQUARE_INDEX: path.join(cwd, 'pi-index'), PI_SESSION_ID: 'parity', PASEO_AGENT_ID: 'managed',
    CODEX_THREAD_ID: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_CODE_CHILD_SESSION: '', OPENCODE_SESSION_ID: '' };
  delete env.SQUARE_OWNER;
  const cli = spawnSync(process.execPath, [path.resolve('dist/square.js'), '--location', squarePath, '--as', 'Cli', 'join'], { env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const identity = commandIdentity(env);
  const { client, close } = await connectedClient(createSquareMcpServer({ cwd, env, path: squarePath, ...identity }));
  const artifact = createArtifactPort(squarePath);
  const square = await Square.at({ path: squarePath, env });
  t.after(async () => { await close(); await artifact.close(); await square.close(); });
  const joined = await client.callTool({ name: 'join', arguments: { as: 'Mcp' } });
  assert.equal(joined.isError, undefined);
  const before = (await artifact.read(facts => facts.seat('Cli'))).value;
  const keys = ['SQUARE_INDEX', 'PASEO_AGENT_ID', 'PI_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'OPENCODE_SESSION_ID', 'SQUARE_OWNER'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) env[key] === undefined ? delete process.env[key] : process.env[key] = env[key];
  t.after(() => { for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]; });
  const tools = new Map();
  squarePiExtension({ registerTool: tool => tools.set(tool.name, tool), registerFlag() {}, getFlag() {}, on() {} });
  const ctx = { cwd, sessionManager: { getSessionId: () => 'parity' } };
  for (const as of ['Cli', 'Pi']) {
    const result = await tools.get('square_join').execute('test', { location: squarePath, as }, undefined, undefined, ctx);
    assert.equal(result.isError, undefined, result.content[0].text);
  }
  assert.equal((await artifact.read(facts => facts.seat('Cli'))).value.generation, before.generation);
  for (const name of ['Cli', 'Mcp', 'Pi']) {
    const seat = (await artifact.read(facts => facts.seat(name))).value;
    assert.equal(seat.owner, identity.owner);
    assert.equal(seat.wakeAddress, undefined);
  }
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  try {
    const session = await ledger.session(identity.owner);
    assert.equal(session.state, 'attached');
    assert.equal(session.routes.some(route => route.kind === 'paseo'), false);
  } finally { await ledger.close(); }
  const alice = (await square.join('Alice', { owner: 'test:alice' })).participant;
  await alice.express({ body: 'parity message', mentions: ['Cli', 'Mcp', 'Pi'], force: true });
  const delivered = await presentPendingAtBoundary(identity.owner, text => text, env);
  assert.match(delivered, /parity message/);
});

test('MCP tools validate JSON arguments and return only CLI text', async () => {
  const { server } = await fixture();
  const { client, close } = await connectedClient(server);
  try {
    assert.deepEqual(client.getServerVersion(), { name: 'square', version: packageVersion });
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((tool) => tool.name), [
      'join', 'express', 'catch', 'history', 'attention', 'done', 'status',
    ]);
    for (const tool of tools) assert.equal(tool.outputSchema, undefined);
    const invalid = await client.callTool({ name: 'express', arguments: { body: 7 } });
    assert.equal(invalid.isError, true);

    const joined = await client.callTool({ name: 'join', arguments: { as: 'rei' } });
    assert.match(joined.content[0].text, /you stepped into the square/);
    assert.match(joined.content[0].text, /MCP scene/);
    const reconnected = await client.callTool({ name: 'join', arguments: { as: 'rei' } });
    assert.match(reconnected.content[0].text, /already in the square/);
    const expressed = await client.callTool({ name: 'express', arguments: { body: '*waves*', mentions: [] } });
    assert.match(expressed.content[0].text, /your gesture lands/);
    const history = await client.callTool({ name: 'history', arguments: { after: 'act/0' } });
    assert.match(history.content[0].text, /\*waves\*/);
    const status = await client.callTool({ name: 'status', arguments: {} });
    assert.match(status.content[0].text, /not turned toward anyone/);
    for (const result of [invalid, joined, reconnected, expressed, history, status]) {
      assert.equal(result.structuredContent, undefined);
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, 'text');
      assert.equal(typeof result.content[0].text, 'string');
    }
  } finally { await close(); }
});

test('MCP retries an unsent express from an in-memory draft without repeating its arguments', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { cwd, squarePath, env, body: owner } = await fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const defaultPath = path.join(cwd, 'default.square');
  const other = await Square.build({ path: defaultPath, markdown: 'default' });
  await other.close();
  const { client, close } = await connectedClient(createSquareMcpServer({
    cwd, env, path: defaultPath, owner,
  }));
  try {
    await client.callTool({ name: 'join', arguments: { location: squarePath, as: 'rei' } });
    await client.callTool({ name: 'join', arguments: { location: squarePath, as: 'bob' } });
    const question = await client.callTool({ name: 'express', arguments: { location: squarePath, as: 'bob', body: 'question for rei', mentions: ['rei'] } });
    assert.equal(question.isError, undefined);
    now += 100_000;
    const body = 'a long answer that the model must not need to repeat\nwith every original option intact';
    const refused = await client.callTool({ name: 'express', arguments: {
      location: squarePath, as: 'rei', body, mentions: ['bob'], reply: 'act/2', noMention: true,
    } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /your words stay unsent/);
    assert.match(refused.content[0].text, /catch the pending activity/);
    const token = refused.content[0].text.match(/draft kept in memory: (dr_\S+)/)?.[1];
    assert.ok(token, refused.content[0].text);
    assert.doesNotMatch(refused.content[0].text, /a long answer/);
    assert.equal(fs.existsSync(path.join(cwd, 'drafts')), false);

    const foreign = await client.callTool({ name: 'express', arguments: { draft: token }, _meta: { threadId: 'foreign' } });
    assert.equal(foreign.isError, true);
    assert.match(foreign.content[0].text, /Unknown, expired, or inaccessible/);
    await client.callTool({ name: 'catch', arguments: { location: squarePath, as: 'rei' } });
    const retry = await client.callTool({ name: 'express', arguments: { draft: token } });
    assert.equal(retry.isError, undefined, retry.content[0].text);
    const history = await client.callTool({ name: 'history', arguments: { location: squarePath, limit: 10 } });
    assert.match(history.content[0].text, /a long answer that the model must not need to repeat/);
    const square = await Square.at({ path: squarePath, env });
    try {
      const landed = (await square.history({ limit: 1, order: 'desc' })).activities[0];
      assert.equal(landed.body, body);
      assert.deepEqual(landed.mentions, ['bob']);
      assert.equal(landed.reply, 'act/2');
    } finally { await square.close(); }
    const consumed = await client.callTool({ name: 'express', arguments: { draft: token } });
    assert.equal(consumed.isError, true);
    assert.match(consumed.content[0].text, /Unknown, expired, or inaccessible/);
  } finally { await close(); }
});

test('one MCP server accepts per-call participants without a configured default', async () => {
  const { cwd, squarePath, env, body } = await fixture();
  const baseEnv = { ...env };
  const beforeProcessEnv = { ...process.env };
  const beforeBaseEnv = { ...baseEnv };
  const { client, close } = await connectedClient(createSquareMcpServer({ cwd, path: squarePath, env: baseEnv, owner: body }));
  try {
    const tools = (await client.listTools()).tools;
    for (const name of ['join', 'express', 'catch', 'attention', 'done', 'status']) {
      const schema = tools.find((tool) => tool.name === name).inputSchema;
      assert.equal(schema.properties.as.type, 'string');
      assert.equal(schema.properties.as.description, name === 'status' ? 'Whose listening to show. Leave it out if you hold exactly one name here.' : name === 'join' ? 'Your name in the square. Give it explicitly when joining.' : 'Your name in the square. Leave it out if you hold exactly one name here.');
      assert.equal(schema.required?.includes('as') ?? false, false);
      assert.equal('session' in schema.properties, false);
    }
    const missing = await client.callTool({ name: 'join', arguments: {} });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /explicit participant name/);
    for (const as of ['alice', 'bob']) {
      const joined = await client.callTool({ name: 'join', arguments: { as } });
      assert.equal(joined.isError, undefined);
      const expressed = await client.callTool({ name: 'express', arguments: { as, body: `${as} speaks`, force: true } });
      assert.match(expressed.content[0].text, /your words land.*act\/\d+/);
    }
    const history = await client.callTool({ name: 'history', arguments: {} });
    const square = await Square.at({ path: squarePath, env: baseEnv });
    try {
      assert.deepEqual((await square.history()).activities.filter((activity) => activity.kind === 'say').map(({ actor, body }) => ({ actor, body })), [
        { actor: 'alice', body: 'alice speaks' }, { actor: 'bob', body: 'bob speaks' },
      ]);
    } finally { await square.close(); }
    assert.match(history.content[0].text, /alice speaks/);
    assert.match(history.content[0].text, /bob speaks/);
    await client.callTool({ name: 'attention', arguments: { as: 'alice', action: 'listen', target: 'bob' } });
    const listening = await client.callTool({ name: 'status', arguments: { as: 'alice' } });
    assert.match(listening.content[0].text, /you listen to\n  · @bob/);
    await client.callTool({ name: 'attention', arguments: { as: 'alice', action: 'ignore', target: 'bob' } });
    assert.match((await client.callTool({ name: 'status', arguments: { as: 'alice' } })).content[0].text, /not turned toward anyone/);
    for (const [name, args] of [['catch', {}], ['done', {}]]) {
      const result = await client.callTool({ name, arguments: { as: 'alice', ...args } });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.equal(result.structuredContent, undefined);
    }
    assert.deepEqual({ ...process.env }, beforeProcessEnv);
    assert.deepEqual(baseEnv, beforeBaseEnv);
  } finally { await close(); }
});

test('MCP request metadata binds the participant seat to the live call body', async (t) => {
  for (const [key, channel] of [['threadId', 'codex'], ['ai.opencode/sessionID', 'opencode']]) {
    await t.test(channel, async (t) => {
      const { cwd, squarePath, env } = await fixture();
      t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
      const configuredBody = "configured" + ":" + `startup-${channel}`;
      const beforeProcessEnv = { ...process.env };
      const beforeBaseEnv = { ...env };
      const { client, close } = await connectedClient(createSquareMcpServer({ cwd, env: { ...env, PASEO_AGENT_ID: 'managed-agent', CODEX_HOME: '/recipient/codex', SQUARE_CODEX_ENDPOINT: ' unix:///recipient/control.sock ' }, path: squarePath, owner: configuredBody,
        wakeAddress: { kind: 'paseo', address: { agentId: 'managed-agent' } } }));
      const artifact = createArtifactPort(squarePath);
      const readSeats = () => artifact.read(facts => ({
        seat: facts.seat('rei'),
        callBodySeats: facts.seatsForOwner(`${channel}:${channel}-first`),
        configuredBodySeats: facts.seatsForOwner(configuredBody),
      }));
      try {
        const callJoin = (session) => client.callTool({ name: 'join', arguments: { as: 'rei' }, _meta: { [key]: session } });
        const callBody = { channel, session: `${channel}-first` };
        const joined = await callJoin(callBody.session);
        assert.match(joined.content[0].text, /you stepped into the square/);
        let seats = (await readSeats()).value;
        assert.deepEqual(seats.seat.owner, `${channel}:${callBody.session}`);
        const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
        try {
          const session = await ledger.session(seats.seat.owner);
          assert.deepEqual(session.routes, [channel === 'codex'
            ? { kind: 'codex-queue', address: { threadId: callBody.session, codexHome: '/recipient/codex', endpoint: 'unix:///recipient/control.sock' } }
            : { kind: 'paseo', address: { agentId: 'managed-agent' } }]);
        } finally { await ledger.close(); }
        assert.deepEqual(seats.callBodySeats.map(({ participant }) => participant), ['rei']);

        const refused = await callJoin(`${channel}-second`);
        assert.equal(refused.isError, true);
        seats = (await readSeats()).value;
        assert.deepEqual(seats.seat.owner, `${channel}:${callBody.session}`);
        assert.deepEqual(seats.callBodySeats.map(({ participant }) => participant), ['rei']);

        const reconnected = await callJoin(callBody.session);
        assert.match(reconnected.content[0].text, /already in the square/);
        const fallback = await client.callTool({ name: 'join', arguments: { as: 'rei' } });
        assert.equal(fallback.isError, true);
        const startupJoin = await client.callTool({ name: 'join', arguments: { as: 'Startup' } });
        assert.match(startupJoin.content[0].text, /you stepped into the square/);
        seats = (await readSeats()).value;
        assert.deepEqual(seats.configuredBodySeats.map(({ participant }) => participant), ['Startup']);
        assert.deepEqual(seats.seat.owner, `${channel}:${callBody.session}`);

        assert.deepEqual({ ...process.env }, beforeProcessEnv);
        assert.deepEqual(env, beforeBaseEnv);
      } finally {
        try { await close(); }
        finally { await artifact.close(); }
      }
    });
  }
});

test('MCP call-local identities supply distinct bodies and keep configured body without a call identity', async (t) => {
  const { cwd, squarePath, env } = await fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const configuredBody = "configured" + ":" + ('configured-session') + ":agent:configured-agent";
  const { client, close } = await connectedClient(createSquareMcpServer({ cwd, path: squarePath, env, owner: configuredBody }));
  const identities = [
    { as: 'Codex', metadata: { threadId: 'call-codex' }, owner: 'codex:call-codex' },
    { as: 'OpenCode', metadata: { 'ai.opencode/sessionID': 'call-opencode' }, owner: 'opencode:call-opencode' },
  ];
  const recognizes = async (body, expectedName) => {
    const square = await Square.at({ cwd, path: squarePath, env });
    try { assert.equal((await selectOwnSeat(square, body)).name, expectedName); }
    finally { await square.close(); }
  };
  try {
    const joins = await Promise.all(identities.map(({ as, metadata }) => client.callTool({
      name: 'join', arguments: { as }, _meta: metadata,
    })));
    for (const joined of joins) {
      assert.equal(joined.isError, undefined, JSON.stringify(joined));
      assert.match(joined.content[0].text, /you stepped into the square/);
    }
    await Promise.all(identities.map(({ as, owner }) => recognizes(owner, as)));

    const configured = await client.callTool({ name: 'join', arguments: { as: 'Configured' } });
    assert.equal(configured.isError, undefined, JSON.stringify(configured));
    await recognizes(configuredBody, 'Configured');
  } finally { await close(); }
});

test('MCP Claude child call body retains agent ownership', async (t) => {
  const { cwd, squarePath, env } = await fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const claudeEnv = { ...env, SQUARE_CLAUDE_MCP_CONTEXT: '1' };
  const call = { toolUseId: 'mcp-child-call', sessionId: 'claude-call-session', cwd, agentId: 'child-agent' };
  const { client, close } = await connectedClient(createSquareMcpServer({ cwd, path: squarePath, env: claudeEnv }));
  let token;
  const childBody = `claude-code:${call.sessionId}:agent:${call.agentId}`;
  const recognizes = async (body) => {
    const square = await Square.at({ cwd, path: squarePath, env: claudeEnv });
    try { return await selectOwnSeat(square, body); }
    finally { await square.close(); }
  };
  try {
    ({ token } = await beginClaudeMcpCall(call, claudeEnv));
    const joined = await client.callTool({
      name: 'join', arguments: { as: 'ClaudeChild' }, _meta: { 'claudecode/toolUseId': call.toolUseId },
    });
    assert.equal(joined.isError, undefined, JSON.stringify(joined));
    assert.equal((await recognizes(childBody)).name, 'ClaudeChild');
    await assert.rejects(recognizes("claude-code" + ":" + (call.sessionId)), (error) => error.code === 'invalid_args');
  } finally {
    try { await close(); }
    finally { if (token !== undefined) await endClaudeMcpCall(call.toolUseId, token, claudeEnv); }
  }
});

test('MCP tool schemas reject unknown fields and malformed activity ids', async () => {
  const { server } = await fixture('kite');
  const { client, close } = await connectedClient(server);
  try {
    const unknownField = await client.callTool({ name: 'join', arguments: { as: 'kite', takeover: false, bogus: 1 } });
    assert.equal(unknownField.isError, true);

    const sessionField = await client.callTool({ name: 'join', arguments: { as: 'kite', session: 'not-a-schema-field' } });
    assert.equal(sessionField.isError, true);

    const malformed = await client.callTool({ name: 'history', arguments: { after: 'act/01' } });
    assert.equal(malformed.isError, true);

    const joined = await client.callTool({ name: 'join', arguments: { as: 'kite', takeover: false } });
    assert.equal(joined.isError, undefined);
    await client.callTool({ name: 'express', arguments: { body: 'schema check' } });
    const history = await client.callTool({ name: 'history', arguments: { after: 'act/0' } });
    assert.equal(history.isError, undefined);
    assert.match(history.content[0].text, /schema check/);
  } finally { await close(); }
});

test('MCP shares location and noMention parameters with native tools', async (t) => {
  const { cwd, squarePath, env, server } = await fixture('rei');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { client, close } = await connectedClient(server);
  try {
    await client.callTool({ name: 'join', arguments: { as: 'rei' } });
    await client.callTool({ name: 'join', arguments: { as: 'bob' } });
    const bare = await client.callTool({ name: 'express', arguments: { as: 'rei', body: 'literal @bob', noMention: true, force: true } });
    assert.match(bare.content[0].text, /your words land/);
    const other = await Square.build({ path: path.join(cwd, 'other.square'), markdown: 'Other square' });
    await other.close();
    const joined = await client.callTool({ name: 'join', arguments: { as: 'rei', location: 'other.square' } });
    assert.match(joined.content[0].text, /you stepped into the square/);
    const history = await client.callTool({ name: 'history', arguments: { location: 'other.square' } });
    assert.doesNotMatch(history.content[0].text, /literal @bob/);
    const square = await Square.at({ path: squarePath, env });
    try {
      const bareActivity = (await square.history()).activities.at(-1);
      const directed = await client.callTool({ name: 'express', arguments: { as: 'rei', body: '@Eve', noMention: true, mentions: ['bob'], reply: bareActivity.id, force: true } });
      assert.match(directed.content[0].text, /you walk over to @bob/);
      assert.doesNotMatch(directed.content[0].text, /isn't standing here/);
      const bell = await client.callTool({ name: 'express', arguments: { as: 'rei', body: '@bob @Eve', reach: 'bell', force: true } });
      assert.match(bell.content[0].text, /you ring the bell/);
      assert.doesNotMatch(bell.content[0].text, /isn't standing here/);
      const original = await client.callTool({ name: 'history', arguments: {} });
      assert.match(original.content[0].text, /@bob @Eve/);
      const activities = (await square.history()).activities;
      assert.deepEqual(bareActivity.mentions, []);
      const landed = activities.find(a => a.body === '@Eve');
      assert.deepEqual(landed.mentions, ['bob']);
      assert.equal(landed.reply, bareActivity.id);
      assert.deepEqual(activities.at(-1).mentions, []);
    } finally { await square.close(); }
  } finally { await close(); }
});

test('MCP cancellation reaches an in-progress application operation', async () => {
  const { server } = await fixture('aoi', { throttlePerMinute: 1 });
  const { client, close } = await connectedClient(server);
  try {
    await client.callTool({ name: 'join', arguments: { as: 'aoi' } });
    await client.callTool({ name: 'express', arguments: { body: 'first word' } });
    const controller = new AbortController();
    const pending = client.callTool({ name: 'express', arguments: { body: 'waiting' } }, undefined, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(() => pending);
    const history = await client.callTool({ name: 'history', arguments: {} });
    assert.doesNotMatch(history.content[0].text, /waiting/);
  } finally { await close(); }
});

test('stdio disconnect aborts throttled express and idle catch without later mutation or consumption', async (t) => {
  const { cwd, squarePath, env, body } = await fixture('disconnected', { throttlePerMinute: 1 });
  const app = await Square.at({ cwd, path: squarePath, env });
  t.after(() => app.close());
  const child = spawn(process.execPath, [path.resolve('dist/square.js'), '--as', 'disconnected', 'mcp-server'], {
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
    assert.equal(response.result.isError, undefined, JSON.stringify(response.result));
    return response.result;
  };
  await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'disconnect-test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await request('tools/call', { name: 'join', arguments: { as: 'disconnected' } });
  await request('tools/call', { name: 'express', arguments: { body: 'first word' } });
  await request('tools/call', { name: 'catch', arguments: {} });
  send('tools/call', { name: 'express', arguments: { body: 'orphan expression' } });
  send('tools/call', { name: 'catch', arguments: { idle: 60_000 } });
  await request('ping');
  await sleep(100);

  const disconnected = once(child, 'exit', { signal: AbortSignal.timeout(3000) });
  child.stdin.end();
  assert.deepEqual(await disconnected, [0, null], stderr);
  assert.equal((await app.history()).activities.some((activity) => activity.body === 'orphan expression'), false);
  const writerBody = "codex" + ":" + ('mcp-writer');
  const writer = await Square.at({ cwd, path: squarePath, env: { ...env, CODEX_THREAD_ID: 'mcp-writer' } });
  t.after(() => writer.close());
  const { participant } = await writer.join('writer', { owner: writerBody });
  const expressed = await participant.express('after disconnect', { force: true, mentions: ['disconnected'] });
  const caught = await (await app.participant('disconnected', { owner: body })).catch();
  assert.ok(caught.activities.some((activity) => activity.id === expressed.activity.id));
});

test('square mcp-server starts without a fixed location and speaks newline-delimited JSON-RPC', async () => {
  const { cwd, env } = await fixture('stdio');
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'ping' },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';
  const child = spawnSync(process.execPath, [path.resolve('dist/square.js'), 'mcp-server'], {
    cwd,
    env: { ...env, SQUARE_LOCATION: '' },
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
