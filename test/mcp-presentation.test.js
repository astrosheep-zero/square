import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { Square } from '../dist/square-api.js';
import { historyCommand } from '../dist/cli/observation-commands.js';
import { renderFailureLines } from '../dist/operation-presentation.js';
import { formatToolAction } from '../dist/presentation.js';
import { createSquareMcpServer } from '../dist/mcp.js';
import { ROOT, testEnv } from './square-cli-helpers.js';

process.env.NO_COLOR = '1';
const at = 1_000;

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'square-mcp-presentation-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const bodyFor = (squarePath) => `codex:${encodeURIComponent(path.resolve(squarePath))}`;
const envFor = (squarePath) => testEnv({ CODEX_THREAD_ID: path.resolve(squarePath), SQUARE_NOW_MS: String(at) }, squarePath);
function commandContext(squarePath) {
  return { command: 'history', cwd: ROOT, env: envFor(squarePath), squarePath, homeDir: os.homedir() };
}

async function buildSquare(t) {
  const squarePath = path.join(tempDir(t), 'parity.square');
  const square = await Square.build({ path: squarePath, markdown: 'a quiet room with a fountain', clock: () => at });
  await square.close();
  return squarePath;
}
async function seed(squarePath, setup) {
  const square = await Square.at({ path: squarePath, clock: () => at });
  try { await setup(square, bodyFor(squarePath)); } finally { await square.close(); }
}
async function openMcp(t, squarePath) {
  const server = createSquareMcpServer({ cwd: path.dirname(squarePath), env: envFor(squarePath),
    owner: bodyFor(squarePath), clock: () => at });
  const client = new Client({ name: 'square-mcp-presentation-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close().catch(() => undefined); await server.close(); });
  return (name, args = {}) => client.callTool({ name, arguments: { location: squarePath, ...args } });
}

test('history prints one CLI page through MCP text-only transport', async (t) => {
  const squarePath = await buildSquare(t);
  await seed(squarePath, async (square, body) => {
    await square.join('rei', { owner: body });
    await square.join('bob', { owner: body });
    const rei = await square.participant('rei', { owner: body });
    await rei.express('first words @bob', { force: true });
    await rei.express('*waves*', { force: true, noMention: true });
    await (await square.participant('bob', { owner: body })).listen('rei');
  });
  const context = commandContext(squarePath);
  const expected = await historyCommand.execute(historyCommand.parse([], context), context);
  const response = await (await openMcp(t, squarePath))('history');
  assert.equal(response.isError, undefined, JSON.stringify(response));
  assert.equal(response.structuredContent, undefined);
  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, 'text');
  assert.equal(response.content[0].text, expected);
});

test('a missing seat reports a tool-shaped join action', async (t) => {
  const squarePath = await buildSquare(t);
  const response = await (await openMcp(t, squarePath))('perceive', { as: 'ghost' });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent, undefined);
  const text = response.content[0].text;
  assert.match(text, /✕ @ghost has never stepped into this square/);
  assert.ok(text.includes(`join ${JSON.stringify({ location: squarePath, as: 'ghost' })}`), text);
  assert.doesNotMatch(text, /square --location/);
});

test('invalid reply recovery has CLI and tool actions for the same typed failure', () => {
  const squarePath = '/tmp/recovery.square';
  const reply = { code: 'invalid_args', message: 'bad', facts: { reason: 'invalid_reply', activityExists: false } };
  assert.deepEqual(renderFailureLines(reply, { squarePath, surface: 'tool', reply: 'act/8' }), [
    "Invalid reply: act/8 is not in this square's history",
    formatToolAction('history', { location: squarePath, limit: 10 }),
  ]);
  assert.deepEqual(renderFailureLines(reply, { squarePath, reply: 'act/8' }), [
    "Invalid --reply: act/8 is not in this square's history",
    `square --location '${squarePath}' history --limit 10`,
  ]);
});

test('history continuation and full expansion round-trip through tool arguments', async (t) => {
  const squarePath = await buildSquare(t);
  const tail = `${'x'.repeat(300)} REAL-TAIL`;
  let earlier, later;
  await seed(squarePath, async (square, body) => {
    const { participant } = await square.join('rei', { owner: body });
    earlier = (await participant.express(`needle 7 ${tail}`, { force: true })).activity.id;
    await participant.express(`hay ${'y'.repeat(300)}`, { force: true });
    later = (await participant.express(`needle 9 ${'z'.repeat(300)} REAL-TAIL`, { force: true })).activity.id;
  });
  const call = await openMcp(t, squarePath);
  const first = (await call('history', { search: 'needle \\d+', regex: true, full: true, limit: 1 })).content[0].text;
  const line = first.split('\n').find((row) => row.startsWith('history ') && row.includes('"before"'));
  assert.ok(line !== undefined, first);
  const args = JSON.parse(line.slice('history '.length));
  assert.equal(args.search, 'needle \\d+');
  assert.equal(args.regex, true);
  assert.equal(args.full, true);
  assert.equal(args.before, later);
  const second = (await call('history', args)).content[0].text;
  assert.ok(second.includes(earlier), second);
  const expanded = (await call('history', { at: [earlier], context: 1, full: true })).content[0].text;
  assert.ok(expanded.includes('REAL-TAIL'), expanded);
});
