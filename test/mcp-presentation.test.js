import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Square } from '../dist/square-api.js';
import { createSquareMcpServer } from '../dist/mcp.js';
import { ROOT, run, testEnv } from './square-cli-helpers.js';

// Presentation is styled for terminals; both sides must render the same unstyled text.
process.env.NO_COLOR = '1';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-mcp-presentation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function bodyFor(squarePath) {
  return { channel: 'codex', session: path.resolve(squarePath) };
}

function envFor(squarePath) {
  const body = bodyFor(squarePath);
  return testEnv({ CODEX_THREAD_ID: body.session }, squarePath);
}

async function buildSquare(t) {
  const squarePath = path.join(tempDir(t), 'parity.square');
  const body = bodyFor(squarePath);
  const square = await Square.build({ path: squarePath, markdown: 'a quiet room with a fountain', env: envFor(squarePath), body });
  await square.close();
  return squarePath;
}

async function seed(squarePath, setup) {
  const body = bodyFor(squarePath);
  const square = await Square.at({ path: squarePath, env: envFor(squarePath), body });
  try { await setup(square); } finally { await square.close(); }
}

async function openMcp(t, squarePath, participant) {
  const body = bodyFor(squarePath);
  const server = createSquareMcpServer({
    cwd: path.dirname(squarePath), env: envFor(squarePath), path: squarePath, participant, body,
  });
  const client = new Client({ name: 'square-mcp-presentation-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close().catch(() => undefined); await server.close(); });
  return (name, args = {}) => client.callTool({ name, arguments: args });
}

/** Square paths differ between the paired artifacts; everything else must be byte-identical. */
function normalized(text, squarePath) {
  return text.split(squarePath).join('<square>');
}

function cli(squarePath, args) {
  return run(['--location', squarePath, ...args], { cwd: ROOT });
}

/** Run the CLI and MCP against state-identical squares and compare the printed text. */
async function assertTextParity(t, setup, cliArgs, tool, toolArgs) {
  const cliPath = await buildSquare(t);
  const mcpPath = await buildSquare(t);
  for (const squarePath of [cliPath, mcpPath]) if (setup !== undefined) await seed(squarePath, setup);
  const result = cli(cliPath, cliArgs);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const asIndex = cliArgs.indexOf('--as');
  const call = await openMcp(t, mcpPath, asIndex === -1 ? 'rei' : cliArgs[asIndex + 1]);
  const response = await call(tool, toolArgs);
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  assert.equal(normalized(response.content[0].text, mcpPath), normalized(result.stdout, cliPath),
    `${tool} content text must be the CLI's human text`);
  return response;
}

const joinReiAndBob = async (square) => {
  await square.join('rei');
  await square.join('bob');
};

test('read-only tools print the same page as the CLI', async (t) => {
  const squarePath = await buildSquare(t);
  await seed(squarePath, async (square) => {
    await joinReiAndBob(square);
    const rei = await square.participant('rei');
    const bob = await square.participant('bob');
    await rei.express('first words @bob', { force: true });
    await rei.express('*waves*', { force: true, noMention: true });
    await bob.listen('rei');
    await rei.hold('writing');
  });
  const call = await openMcp(t, squarePath, 'rei');
  const cases = [
    { tool: 'history', args: {}, cliArgs: ['history'] },
    { tool: 'status', args: {}, cliArgs: ['--as', 'rei', 'status'] },
    { tool: 'participants', args: {}, cliArgs: ['participants'] },
    { tool: 'listening', args: { as: 'bob' }, cliArgs: ['--as', 'bob', 'listening'] },
  ];
  for (const { tool, args, cliArgs } of cases) {
    const result = cli(squarePath, cliArgs);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const response = await call(tool, args);
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent), tool);
    assert.equal(response.content[0].text, result.stdout, `${tool} content text must be the CLI's human text`);
    assert.equal('observation' in response.structuredContent, false, `${tool} structuredContent stays a receipt`);
    assert.notEqual(response.content[0].text.trim(), JSON.stringify(response.structuredContent), `${tool} text is not JSON`);
  }
});

test('mutating tools print the same result as the CLI', async (t) => {
  await t.test('join', async (t) => {
    await assertTextParity(t, undefined, ['--as', 'rei', 'join'], 'join', { as: 'rei' });
  });
  await t.test('express', async (t) => {
    await assertTextParity(t, joinReiAndBob, ['--as', 'rei', 'express', 'hello @bob'], 'express',
      { as: 'rei', body: 'hello @bob' });
  });
  await t.test('catch', async (t) => {
    await assertTextParity(t, async (square) => {
      await joinReiAndBob(square);
      await (await square.participant('bob')).express('@rei ping', { force: true });
    }, ['--as', 'rei', 'catch'], 'catch', { as: 'rei' });
  });
  await t.test('listen', async (t) => {
    await assertTextParity(t, joinReiAndBob, ['--as', 'rei', 'listen', 'bob'], 'listen', { as: 'rei', target: 'bob' });
  });
  await t.test('ignore', async (t) => {
    await assertTextParity(t, joinReiAndBob, ['--as', 'rei', 'ignore', 'bob'], 'ignore', { as: 'rei', target: 'bob' });
  });
  await t.test('unlisten', async (t) => {
    await assertTextParity(t, async (square) => {
      await joinReiAndBob(square);
      await (await square.participant('rei')).listen('bob');
    }, ['--as', 'rei', 'unlisten', 'bob'], 'unlisten', { as: 'rei', target: 'bob' });
  });
  await t.test('hold', async (t) => {
    await assertTextParity(t, async (square) => { await square.join('rei'); },
      ['--as', 'rei', 'hold', 'deep work'], 'hold', { as: 'rei', reason: 'deep work' });
  });
  await t.test('resume', async (t) => {
    await assertTextParity(t, async (square) => {
      await square.join('rei');
      await (await square.participant('rei')).hold('deep work');
    }, ['--as', 'rei', 'resume'], 'resume', { as: 'rei' });
  });
  await t.test('done', async (t) => {
    await assertTextParity(t, async (square) => { await square.join('rei'); },
      ['--as', 'rei', 'done'], 'done', { as: 'rei' });
  });
});

test('failures print the CLI recovery lines instead of JSON', async (t) => {
  const cliPath = await buildSquare(t);
  const mcpPath = await buildSquare(t);
  const result = cli(cliPath, ['--as', 'ghost', 'catch']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const call = await openMcp(t, mcpPath, 'ghost');
  const response = await call('catch', { as: 'ghost' });
  assert.equal(response.isError, true);
  const text = response.content[0].text;
  assert.equal(response.structuredContent.error.facts.reason, 'never_joined');
  assert.throws(() => JSON.parse(text));
  assert.match(text, /✕ @ghost has never stepped into this square/);
  // The CLI prefixes a freshly observed count; the refusal lines themselves are shared.
  const body = result.stderr.split('\n\n').slice(1).join('\n\n');
  assert.equal(normalized(text, mcpPath).trim(), normalized(body, cliPath).trim());
  assert.match(text, new RegExp(`--location '${mcpPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' --as 'ghost' join`));
});
