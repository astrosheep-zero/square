import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Square, squareLocation, diagnoseSquare, migrateSquare, discover, createSquareResourceOwner } from '../dist/square-api.js';
import { createSquareMcpServer } from '../dist/mcp.js';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { readSquareSnapshot } from '../dist/artifact.js';
import { displayPath, participantCommandPrefix } from '../dist/presentation.js';

const server = path.resolve(import.meta.dirname, '../dist/stdio-server.js');
const fixtureServer = path.resolve(import.meta.dirname, 'fixtures/stdio-backend-process.js');
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-stdio-'));
  const root = path.join(cwd, 'artifacts');
  const env = { ...process.env, HOME: cwd, SQUARE_HOST_LEDGER_ROOT: path.join(cwd, 'ledger'),
    SQUARE_BACKENDS_CONFIG: undefined, SQUARE_LOCATION: undefined, SQUARE_PARTICIPANT_NAME: '',
    SQUARE_NOW_MS: undefined, NO_COLOR: '1' };
  const backends = { local: { command: process.execPath, args: [server, '--root', root],
    // Startup identity must not replace any request coordinate, including an explicitly empty one.
    env: { CLAUDE_CODE_SESSION_ID: 'startup-claude', PI_SESSION_ID: 'startup-pi', PASEO_AGENT_ID: 'startup-paseo', SQUARE_PARTICIPANT_NAME: 'Startup' } } };
  const input = { cwd, env, backends, path: 'stdio://local/discussion' };
  const resources = [];
  t.after(async () => { await Promise.all(resources.map(square => square.close())); fs.rmSync(cwd, { recursive: true, force: true }); });
  const open = async (name, extra = {}) => {
    const square = await Square.at({ ...input, env: { ...env, CODEX_THREAD_ID: name ? `session-${name}` : '' }, participant: name, ...extra });
    resources.push(square); return square;
  };
  const build = async () => { const square = await Square.build({ ...input, markdown: 'A shared backend square' }); resources.push(square); return square; };
  const cli = (name, args, extraEnv = {}) => spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../dist/square.js'), '--location', input.path,
    ...(name ? ['--as', name] : []), ...args], { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 8000 });
  return { cwd, root, env, input, resources, open, build, cli };
}
function assertDead(pid) { assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH'); }

test('stdio clients and real CLI share SQLite activity, ownership, observations and nonconsuming history', async t => {
  const f = fixture(t); await f.build();
  const aliceSquare = await f.open('Alice'), bobSquare = await f.open('Bob');
  assert.equal(aliceSquare.location, f.input.path);
  const selected = await aliceSquare.participant();
  assert.equal(selected.name, 'Alice');
  assert.equal((await aliceSquare.participants()).participants.length, 0, 'selection does not join');
  const alice = (await aliceSquare.join(undefined, { observe: true })).participant;
  const joined = await bobSquare.join(undefined, { observe: true });
  const bob = joined.participant;
  assert.equal(joined.observation.location, f.input.path);
  assert.equal(joined.observation.automaticDeliveryAvailable, false);
  await alice.express('only Bob hears @Bob', { force: true });
  const history = await bobSquare.history({ observe: true });
  await assert.rejects(bobSquare.history({ limit: Infinity }), error => error.code === 'invalid_args');
  assert.deepEqual((await bobSquare.history({ limit: null })).activities, history.activities, 'explicit null still reads the unbounded archive');
  const directed = history.activities.find(activity => activity.kind === 'say');
  assert.equal((await bob.catch()).activities.filter(activity => activity.kind === 'say').length, 1, 'history did not consume');
  const reply = await bob.express('reply to Alice', { reply: directed.id, force: true, observe: true });
  assert.equal(reply.observation.automaticDeliveryAvailable, false);
  assert.deepEqual((await alice.catch()).activities.filter(activity => activity.kind === 'say').map(activity => activity.body), ['reply to Alice']);
  await alice.listen('Bob');
  assert.deepEqual((await alice.listening()).listening, ['Bob']);
  await alice.unlisten('Bob'); await alice.ignore('Bob');
  await bob.hold('pause'); assert.equal((await aliceSquare.status()).hold.by, 'Bob');
  await bob.resume();
  const config = path.join(f.cwd, 'backends.json'); fs.writeFileSync(config, JSON.stringify({ backends: f.input.backends }));
  const cliEnv = { SQUARE_BACKENDS_CONFIG: './backends.json' };
  const joinedCli = f.cli('Carol', ['join'], cliEnv); assert.equal(joinedCli.status, 0, joinedCli.stderr);
  const sentCli = f.cli('Carol', ['express', '--force', 'hello @Bob'], cliEnv); assert.equal(sentCli.status, 0, sentCli.stderr);
  assert.match(sentCli.stdout, /stdio:\/\/local\/discussion/);
  assert.equal((await bob.catch()).activities.find(activity => activity.body === 'hello @Bob')?.actor, 'Carol');
  const caughtCarol = f.cli('Carol', ['catch', '--now'], cliEnv); assert.equal(caughtCarol.status, 0, caughtCarol.stderr);
  assert.doesNotMatch(caughtCarol.stdout, /only Bob hears/);
  const absent = f.cli('NeverJoined', ['express', 'raw draft'], cliEnv);
  assert.notEqual(absent.status, 0); assert.match(absent.stderr, /stdio:\/\/local\/discussion/);
  assert.equal(fs.existsSync(path.join(f.cwd, 'stdio:')), false);
  assert.equal(fs.readdirSync(path.join(f.cwd, 'drafts')).length, 1);
  assert.equal(displayPath(f.input.path), f.input.path);
  assert.match(participantCommandPrefix(f.input.path, 'Alice'), /--location 'stdio:\/\/local\/discussion'/);
  assert.match(f.cli(undefined, ['stream'], cliEnv).stderr, /--location 'stdio:\/\/local\/discussion'/);
  const snapshot = await readSquareSnapshot(path.join(f.root, 'discussion.square'));
  assert.deepEqual(snapshot.state.routes, [], 'no automatic wake routes registered');
  const ledger = createHostLedgerPort({ rootPath: f.env.SQUARE_HOST_LEDGER_ROOT });
  const rows = await ledger.listPresence({ location: path.join(f.root, 'discussion.square') });
  assert.equal(rows.find(row => row.participant === 'Alice').session, 'session-Alice');
  assert.equal(rows.some(row => row.session.startsWith('startup-')), false);
  const foreign = await f.open('Alice', { env: { ...f.env, CODEX_THREAD_ID: 'other-session' } });
  await assert.rejects(foreign.join(), error => error.code === 'already_joined');
  const resumed = await f.open(undefined, { env: { ...f.env, CODEX_THREAD_ID: 'session-Alice' } });
  assert.equal((await resumed.participant()).name, 'Alice', 'discovery uses the forwarded coordinate');
  const noIdentity = await f.open(undefined);
  await assert.rejects(noIdentity.participant(), error => error.code === 'invalid_args', 'backend startup identity was cleared');
  await bob.done(); assert.equal((await bobSquare.status()).participants.find(p => p.name === 'Bob').state, 'done');
  await assert.rejects(aliceSquare.snapshot(), /snapshot/);
  assert.throws(() => aliceSquare.stream({}), /stream/);
});

test('MCP location overrides route above server-owned SQLite lending and keep call-local identity', async t => {
  const f = fixture(t); await f.build();
  const localPath = path.join(f.cwd, 'configured.square');
  const local = await Square.build({ path: localPath, env: f.env, markdown: 'local' }); f.resources.push(local);
  const server = createSquareMcpServer({ ...f.input, path: localPath, env: { ...f.env, CODEX_THREAD_ID: 'startup' } });
  const client = new Client({ name: 'stdio-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right), client.connect(left)]);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name, args, threadId) => {
    const result = await client.callTool({ name, arguments: args, _meta: { threadId } });
    assert.equal(result.isError, undefined, JSON.stringify(result)); return result.structuredContent;
  };
  await call('join', { location: f.input.path, as: 'Mcp' }, 'mcp-call');
  await call('express', { location: f.input.path, as: 'Mcp', body: 'external bare activity', force: true }, 'mcp-call');
  assert.equal((await call('history', { location: f.input.path }, 'mcp-call')).activities.some(a => a.body === 'external bare activity'), true);
  assert.equal((await local.participants()).participants.length, 0);
  await call('join', { as: 'Local' }, 'local-call');
  assert.equal((await local.participants()).participants.length, 1);
  const rows = await createHostLedgerPort({ rootPath: f.env.SQUARE_HOST_LEDGER_ROOT }).listPresence({ location: path.join(f.root, 'discussion.square') });
  assert.equal(rows.find(row => row.participant === 'Mcp').session, 'mcp-call');
});

test('overlapping requests correlate; cancel waits for catch lease release without aborting another request', async t => {
  const f = fixture(t); await f.build();
  const square = await f.open('Alice'), alice = (await square.join()).participant;
  const controller = new AbortController();
  let start; const started = new Promise(resolve => { start = resolve; });
  const waiting = alice.catch({ idle: 10000 }, { signal: controller.signal, onProgress: p => { if (p.kind === 'catch-started') start(p); } });
  const rejected = assert.rejects(waiting);
  assert.equal((await started).participant, 'Alice');
  const [history, status, names] = await Promise.all([square.history(), square.status(), square.participants()]);
  assert.ok(Array.isArray(history.activities)); assert.equal(status.activeCount, 1); assert.equal(names.participants[0].name, 'Alice');
  controller.abort(); await rejected;
  const retry = await alice.catch({ idle: 1 }); assert.equal(retry.idleExpired, true); assert.equal(retry.status, undefined);
  let next; const nextStarted = new Promise(resolve => { next = resolve; });
  const outstanding = alice.catch({ idle: 10000 }, { onProgress: p => { if (p.kind === 'catch-started') next(); } });
  const settled = assert.rejects(outstanding);
  await nextStarted; await square.close(); await settled; await square.close();
});

test('configuration and URI refusals never treat backend locations as paths', async t => {
  const f = fixture(t);
  assert.equal(squareLocation({ ...f.input, path: 'stdio://local/hello%20world' }), 'stdio://local/hello%20world');
  for (const location of ['slack://workspace/key', 'stdio://user@local/key', 'stdio://local/key?x', 'stdio://local/%2Fescape', 'stdio://local/../escape'])
    assert.throws(() => squareLocation({ ...f.input, path: location }), error => error.code === 'invalid_args');
  await assert.rejects(Square.at({ ...f.input, backends: {} }), /not configured/);
  await assert.rejects(Square.at({ ...f.input, backends: undefined, env: { ...f.env, SQUARE_BACKENDS_CONFIG: './missing.json' } }), error => error.code === 'invalid_args');
  const invalid = path.join(f.cwd, 'bad.json'); fs.writeFileSync(invalid, '{');
  await assert.rejects(Square.at({ ...f.input, backends: undefined, env: { ...f.env, SQUARE_BACKENDS_CONFIG: invalid } }), error => error.code === 'invalid_args');
  await f.build(); // explicit SDK config wins over an invalid file
  const local = await Square.build({ path: path.join(f.cwd, 'local.square'), markdown: '', env: f.env }); f.resources.push(local);
  for (const operation of [diagnoseSquare, migrateSquare, discover])
    assert.throws(() => operation(f.input), /local square artifact/);
  const resources = createSquareResourceOwner();
  const remote = await f.open('Borrower', { resources });
  await remote.join(); await remote.close(); await resources.close();
  assert.equal(fs.existsSync(path.join(f.cwd, 'stdio:')), false);
  fs.symlinkSync(path.join(f.cwd, 'local.square'), path.join(f.root, 'escape.square'));
  await assert.rejects(f.open('x', { path: 'stdio://local/escape' }), /escapes/);
});

test('protocol mismatch, malformed output and lost express response settle without replay or leaked children', async t => {
  const f = fixture(t);
  for (const mode of ['version', 'malformed', 'lost']) {
    const marker = path.join(f.cwd, `${mode}.pid`), log = path.join(f.cwd, `${mode}.log`);
    const input = { ...f.input, backends: { local: { command: process.execPath, args: [fixtureServer, mode, log, marker] } } };
    if (mode !== 'lost') await assert.rejects(Square.at(input), /protocol|Malformed/);
    else {
      const square = await Square.at(input); f.resources.push(square);
      const participant = await square.participant('Alice');
      await assert.rejects(participant.express('once'), error => error.code === 'unavailable' && error.operation.expressEffect === 'unknown');
      await square.close();
      assert.equal(fs.readFileSync(log, 'utf8'), 'express\n');
    }
    assertDead(Number(fs.readFileSync(marker, 'utf8')));
  }
});

test('close is bounded even when the child ignores close and SIGTERM, and settles pending requests', async t => {
  const f = fixture(t), marker = path.join(f.cwd, 'stubborn.pid');
  const square = await Square.at({ ...f.input, backends: { local: { command: process.execPath, args: [fixtureServer, 'stubborn', '', marker] } } });
  f.resources.push(square);
  const pending = assert.rejects(square.history(), /timed out|closed/);
  await square.close(); await pending; await square.close();
  assertDead(Number(fs.readFileSync(marker, 'utf8')));
});
