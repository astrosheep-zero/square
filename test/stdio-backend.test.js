import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Square, squareLocation, diagnoseSquare, migrateSquare, discover } from '../dist/square-api.js';
import { createSquareMcpServer } from '../dist/mcp.js';
import { createArtifactPort } from '../dist/artifact.js';
import { displayPath, participantCommandPrefix } from '../dist/presentation.js';

const server = path.resolve(import.meta.dirname, '../dist/stdio-server.js');
const fixtureServer = path.resolve(import.meta.dirname, 'fixtures/stdio-backend-process.js');
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-stdio-'));
  const root = path.join(cwd, 'artifacts');
  const env = { ...process.env, HOME: cwd,
    SQUARE_BACKENDS_CONFIG: undefined, SQUARE_LOCATION: undefined, SQUARE_PARTICIPANT_NAME: '',
    SQUARE_NOW_MS: undefined, NO_COLOR: '1' };
  const backends = { local: { command: process.execPath, args: [server, '--root', root],
    // Backend startup identity must not override the call-local native coordinates.
    env: { CLAUDE_CODE_SESSION_ID: 'startup-claude', PI_SESSION_ID: 'startup-pi', PASEO_AGENT_ID: 'startup-paseo', SQUARE_PARTICIPANT_NAME: 'Startup' } } };
  const input = { cwd, env, backends, path: 'stdio://local/discussion' };
  const resources = [];
  t.after(async () => { await Promise.all(resources.map(square => square.close())); fs.rmSync(cwd, { recursive: true, force: true }); });
  const open = async (extra = {}) => {
    const square = await Square.at({ ...input, env: { ...env, CODEX_THREAD_ID: '' }, ...extra });
    resources.push(square);
    return square;
  };
  const cli = (args, extraEnv = {}) => spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../dist/square.js'), '--location', input.path,
    ...args], { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 8000 });
  return { cwd, root, env, input, resources, open, cli };
}
function assertDead(pid) { assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH'); }

async function seedArtifact(location, env, markdown, body, participant, activity) {
  const square = await Square.build({ path: location, env, markdown, body, participant });
  try {
    const joined = await square.join();
    if (activity !== undefined) await joined.participant.express(activity, { force: true });
  } finally { await square.close(); }
}

test('stdio clients and the real CLI read the same artifact history without consuming it', async t => {
  const f = fixture(t);
  const artifactPath = path.join(f.root, 'discussion.square');
  const body = { channel: 'codex', session: 'artifact-seed' };
  await seedArtifact(artifactPath, f.env, 'A shared backend square', body, 'Alice', 'one artifact-shared activity');

  const square = await f.open();
  assert.equal(square.location, f.input.path);
  const history = await square.history({ observe: true });
  assert.equal(history.activities.some(activity => activity.body === 'one artifact-shared activity'), true);
  assert.equal(history.observation.location, f.input.path);
  await assert.rejects(square.history({ limit: Infinity }), error => error.code === 'invalid_args');
  assert.deepEqual((await square.history({ limit: null })).activities, history.activities, 'explicit null reads the full archive');
  assert.deepEqual((await square.history({ observe: true })).activities, history.activities, 'history is nonconsuming');

  const config = path.join(f.cwd, 'backends.json');
  fs.writeFileSync(config, JSON.stringify({ backends: f.input.backends }));
  const cliEnv = { SQUARE_BACKENDS_CONFIG: './backends.json' };
  const cliHistory = f.cli(['history', '--limit', '10'], cliEnv);
  assert.equal(cliHistory.status, 0, cliHistory.stderr);
  assert.match(cliHistory.stdout, /one artifact-shared activity/);
  assert.equal(fs.existsSync(path.join(f.cwd, 'stdio:')), false);
  assert.equal(displayPath(f.input.path), f.input.path);
  assert.match(participantCommandPrefix(f.input.path, 'Alice'), /--location 'stdio:\/\/local\/discussion'/);
  assert.match(f.cli(['stream'], cliEnv).stderr, /--location 'stdio:\/\/local\/discussion'/);

  const artifact = createArtifactPort(artifactPath);
  try {
    assert.deepEqual((await artifact.read(facts => facts.seatsForBody(body))).value.map(seat => seat.participant), ['Alice']);
    assert.equal((await artifact.read(facts => facts.seatsForBody({ channel: 'pi', session: 'startup-pi' }))).value.length, 0);
  } finally { await artifact.close(); }
});

test('stdio open carries the exact typed Body for remote join and express while body-less history stays readable', async t => {
  const f = fixture(t);
  const artifactPath = path.join(f.root, 'discussion.square');
  const body = { channel: 'stdio-channel', session: 'stdio-session', agent: 'worker/one' };
  const square = await Square.build({ ...f.input, body, participant: 'Remote', markdown: 'remote body test' });
  f.resources.push(square);
  const joined = await square.join('Remote');
  await joined.participant.express('written through the remote backend');
  const artifact = createArtifactPort(artifactPath);
  try {
    assert.deepEqual((await artifact.read(facts => facts.seat('Remote'))).value.body, body);
    assert.equal((await artifact.read(facts => facts.activity(1))).value.body, 'written through the remote backend');
  } finally { await artifact.close(); }

  const bodyless = await f.open();
  const history = await bodyless.history();
  assert.equal(history.activities.some(activity => activity.body === 'written through the remote backend'), true);
});

test('MCP location overrides the configured resource for read-only backend calls', async t => {
  const f = fixture(t);
  const artifactPath = path.join(f.root, 'discussion.square');
  await seedArtifact(artifactPath, f.env, 'backend', { channel: 'codex', session: 'seed' }, 'Mcp', 'activity in the backend artifact');
  const localPath = path.join(f.cwd, 'configured.square');
  const local = await Square.build({ path: localPath, env: f.env, markdown: 'local' });
  const server = createSquareMcpServer({ ...f.input, path: localPath, env: { ...f.env, CODEX_THREAD_ID: 'startup' } });
  const client = new Client({ name: 'stdio-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right), client.connect(left)]);
  t.after(async () => { await client.close(); await server.close(); await local.close(); });
  const call = async args => {
    const result = await client.callTool({ name: 'history', arguments: args, _meta: { threadId: 'mcp-call' } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return result.structuredContent;
  };
  const remoteHistory = await call({ location: f.input.path });
  assert.equal(remoteHistory.activities.some(activity => activity.body === 'activity in the backend artifact'), true);
  assert.deepEqual((await call({})).activities, []);
  assert.deepEqual((await local.participants()).participants, []);
});

test('cancelling a blocked history read leaves another backend request usable', async t => {
  const f = fixture(t);
  const artifactPath = path.join(f.root, 'discussion.square');
  await seedArtifact(artifactPath, f.env, 'cancellation', { channel: 'codex', session: 'seed' }, 'Alice');
  const square = await f.open();
  const database = new DatabaseSync(artifactPath);
  database.exec('BEGIN EXCLUSIVE');
  const controller = new AbortController();
  const waiting = square.history({}, { signal: controller.signal });
  const rejected = assert.rejects(waiting, /aborted|cancel/i);
  const status = square.status();
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.abort(new Error('cancel history'));
    await rejected;
  } finally {
    database.exec('ROLLBACK');
    database.close();
  }
  const result = await status;
  assert.equal(result.activeCount, 1);
  assert.deepEqual(result.participants.map(participant => participant.name), ['Alice']);
  await square.close();
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
  const local = await Square.build({ path: path.join(f.cwd, 'local.square'), markdown: '', env: f.env }); f.resources.push(local);
  for (const operation of [diagnoseSquare, migrateSquare, discover])
    assert.throws(() => operation(f.input), /local square artifact/);
  assert.equal(fs.existsSync(path.join(f.cwd, 'stdio:')), false);
  fs.mkdirSync(f.root, { recursive: true });
  fs.symlinkSync(path.join(f.cwd, 'local.square'), path.join(f.root, 'escape.square'));
  await assert.rejects(f.open({ path: 'stdio://local/escape' }), /escapes/);
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
