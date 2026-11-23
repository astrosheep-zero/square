import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { Square, discover } from '../dist/api/square-api.js';
import { renderFailureLines } from '../dist/surfaces/operation-presentation.js';
import { spellAction } from '../dist/surfaces/presentation.js';
import { createSquareMcpServer } from '../dist/surfaces/mcp.js';
import { run, testEnv, withName, withPath } from './square-cli-helpers.js';

process.env.NO_COLOR = '1';
const at = 1_000;

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'square-mcp-presentation-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const bodyFor = (squarePath) => `codex:${encodeURIComponent(path.resolve(squarePath))}`;
const envFor = (squarePath) => testEnv({ CODEX_THREAD_ID: path.resolve(squarePath), SQUARE_NOW_MS: String(at) }, squarePath);

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
  return (name, { location = squarePath, ...args } = {}) => client.callTool({ name,
    arguments: location === null ? args : { location, ...args } });
}

test('history prints one CLI page through MCP text-only transport', async (t) => {
  const squarePath = await buildSquare(t);
  await seed(squarePath, async (square, body) => {
    await square.join('rei', { owner: body });
    await square.join('bob', { owner: body });
    const rei = await square.participant('rei', { owner: body });
    await rei.express('first words @bob', { force: true });
    await rei.express('*waves*', { force: true });
    await (await square.participant('bob', { owner: body })).attention({ target: 'rei', state: 'listen' });
  });
  const cli = run(withPath(squarePath, ['history']), { env: envFor(squarePath) });
  assert.equal(cli.status, 0, cli.stderr);
  const response = await (await openMcp(t, squarePath))('history');
  assert.equal(response.isError, undefined, JSON.stringify(response));
  assert.equal(response.structuredContent, undefined);
  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, 'text');
  assert.equal(response.content[0].text, cli.stdout);
});

test('every participant command reaches its MCP operation and shares its validation refusal', async (t) => {
  const cliSquare = await buildSquare(t);
  const toolSquare = await buildSquare(t);
  for (const file of [cliSquare, toolSquare]) await seed(file, (square, owner) => square.join('Bob', { owner }));
  const call = await openMcp(t, toolSquare);
  const cliRun = (args) => run(args, { cwd: path.dirname(cliSquare), env: envFor(cliSquare) });
  for (const [name, argv, args] of [
    ['join', ['join'], {}],
    ['express', ['express', 'hello'], { body: 'hello' }],
    ['perceive', ['perceive'], {}],
    ['history', ['history'], {}],
    ['attention', ['listen', 'Bob'], { state: 'listen', target: 'Bob' }],
    ['attention', ['unlisten', 'Bob'], { state: 'neutral', target: 'Bob' }],
    ['attention', ['ignore', 'Bob'], { state: 'ignore', target: 'Bob' }],
    ['status', ['status'], {}],
    ['mute', ['mute', '1m'], { duration: '1m' }],
    ['mute', ['mute', 'off'], { duration: 'off' }],
    ['done', ['done'], {}],
    ['list', ['ls'], {}],
  ]) {
    const as = name === 'done' ? 'Bob' : ['history', 'list'].includes(name) ? undefined : 'Alice';
    const cli = cliRun(name === 'list' ? argv : as ? withName(cliSquare, as, argv) : withPath(cliSquare, argv));
    assert.equal(cli.status, 0, cli.stderr);
    const tool = await call(name, { ...args, ...(as ? { as } : {}), ...(name === 'list' ? { location: null } : {}) });
    assert.equal(tool.isError, undefined, tool.content[0].text);
  }

  const alice = (argv) => withName(cliSquare, 'Alice', argv);
  for (const [name, argv, args] of [
    ['list', ['ls', '--after', toolSquare], { after: toolSquare, location: null }],
    ['express', alice(['express', '--reply', 'not-an-id', 'hello']), { as: 'Alice', reply: 'not-an-id', body: 'hello' }],
    ['perceive', alice(['perceive', '--replace']), { as: 'Alice', replace: true }],
    ['history', withPath(cliSquare, ['history', '--after', 'sideways']), { after: 'sideways' }],
    ['attention', alice(['listen', 'not a name']), { as: 'Alice', state: 'listen', target: 'not a name' }],
    ['status', withName(cliSquare, 'bad/', ['status']), { as: 'bad/' }],
    ['mute', alice(['mute', '0m']), { as: 'Alice', duration: '0m' }],
    ['done', withName(cliSquare, '', ['done']), { as: '' }],
  ]) {
    const cli = cliRun(argv);
    const tool = await call(name, args);
    assert.equal(cli.status, 2, `${name}: ${cli.stdout}${cli.stderr}`);
    assert.equal(tool.isError, true, `${name}: ${tool.content[0].text}`);
    const refusal = tool.content[0].text;
    assert.ok(cli.stderr.trim().split('\n').includes(refusal), `${name}: expected ${JSON.stringify(refusal)} in ${cli.stderr}`);
    if (name === 'list') await assert.rejects(discover({ cwd: path.dirname(toolSquare) }, { after: args.after }),
      { code: 'invalid_args', message: refusal });
  }
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
    spellAction({ operation: 'history', args: { location: squarePath, limit: 10 } }, 'tool'),
  ]);
  assert.deepEqual(renderFailureLines(reply, { squarePath, reply: 'act/8' }), [
    "Invalid --reply: act/8 is not in this square's history",
    `square --location '${squarePath}' history --limit 10`,
  ]);
});

test('history continuation preserves regex search and clipping arguments', async (t) => {
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
  const first = (await call('history', { search: '/needle \\d+/', maxChars: 20, limit: 1 })).content[0].text;
  const line = first.split('\n').find((row) => row.startsWith('history ') && row.includes('"before"'));
  assert.ok(line !== undefined, first);
  const args = JSON.parse(line.slice('history '.length));
  assert.equal(args.search, '/needle \\d+/');
  assert.equal(args.maxChars, 20);
  assert.equal(args.before, later);
  const second = (await call('history', args)).content[0].text;
  assert.ok(second.includes(earlier), second);
  const expanded = (await call('history', { ids: [earlier], context: 1 })).content[0].text;
  assert.ok(expanded.includes('REAL-TAIL'), expanded);
});
