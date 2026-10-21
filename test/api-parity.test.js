import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Square } from '../dist/square-api.js';
import { createSquareMcpServer } from '../dist/mcp.js';
import { readSquareSnapshot } from '../dist/artifact.js';

async function fixture(t, label) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `square-parity-${label}-`));
  const squarePath = path.join(cwd, 'SQUARE.square');
  const env = { ...process.env, SQUARE_REGISTRY: path.join(cwd, 'registry.ndjsonl'),
    SQUARE_HOST_LEDGER_ROOT: path.join(cwd, 'ledger'), SQUARE_NOW_MS: '1000',
    CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '', OPENCODE_SESSION_ID: '', PI_SESSION_ID: '', PASEO_AGENT_ID: '',
    SQUARE_PARTICIPANT_NAME: undefined, SQUARE_DISABLE_PASEO_WAKE: '1', NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  const square = await Square.build({ path: squarePath, markdown: 'parity context', env });
  t.after(async () => { await square.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, path: squarePath, env, square };
}
async function mcp(t, options) {
  const server = createSquareMcpServer(options);
  const client = new Client({ name: 'square-parity-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right), client.connect(left)]);
  t.after(async () => { await client.close(); await server.close(); });
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    return result.structuredContent;
  };
}
function cli(options, participant, args) {
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../dist/square.js'),
    '--location', options.path, '--as', participant, ...args], {
    cwd: options.cwd, env: options.env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

test('SDK, CLI and MCP land the same join, directed reply, listener and departure facts', async (t) => {
  const direct = await fixture(t, 'sdk'), terminal = await fixture(t, 'cli'), json = await fixture(t, 'mcp');
  const call = await mcp(t, json);
  for (const name of ['Alice', 'Bob']) {
    await direct.square.join(name);
    cli(terminal, name, ['join']);
    await call('join', { as: name });
  }
  const alice = await direct.square.participant('Alice'), bob = await direct.square.participant('Bob');
  await alice.express('first @Bob', { force: true });
  cli(terminal, 'Alice', ['express', '--force', 'first @Bob']);
  await call('express', { as: 'Alice', body: 'first @Bob', force: true });
  await bob.express('answer', { force: true, noMention: true, reply: 'act/2' });
  cli(terminal, 'Bob', ['express', '--force', '--no-mention', '--reply', 'act/2', 'answer']);
  await call('express', { as: 'Bob', body: 'answer', force: true, reply: 'act/2' });
  await alice.listen('Bob');
  cli(terminal, 'Alice', ['listen', 'Bob']);
  await call('listen', { as: 'Alice', target: 'Bob' });
  const caught = await alice.catch();
  cli(terminal, 'Alice', ['catch']);
  assert.deepEqual(await call('catch', { as: 'Alice' }), caught);
  await alice.ignore('Bob');
  cli(terminal, 'Alice', ['ignore', 'Bob']);
  await call('ignore', { as: 'Alice', target: 'Bob' });
  await bob.done();
  cli(terminal, 'Bob', ['done']);
  await call('done', { as: 'Bob' });
  const expected = await direct.square.history({ limit: 100 });
  assert.deepEqual(await terminal.square.history({ limit: 100 }), expected);
  assert.deepEqual(await call('history', { limit: 100 }), expected);
  const persisted = (await readSquareSnapshot(direct.path)).state;
  for (const options of [terminal, json]) {
    const actual = (await readSquareSnapshot(options.path)).state;
    assert.deepEqual(actual.acts, persisted.acts);
    assert.deepEqual(actual.runtime.observations, persisted.runtime.observations);
  }
});

test('all history callers default to ten; only explicit null reads the full archive, without receipts', async (t) => {
  const options = await fixture(t, 'archive'), { square } = options;
  const { participant } = await square.join('Alice');
  for (let index = 0; index < 12; index++) await participant.express(`message ${index}`, { force: true });
  const call = await mcp(t, options), before = (await readSquareSnapshot(options.path)).state;
  const recent = await square.history();
  assert.deepEqual(recent.activities.map((activity) => activity.id), Array.from({ length: 10 }, (_, index) => `act/${index + 3}`));
  assert.deepEqual(await call('history'), recent);
  assert.deepEqual(await participant.history(), recent);
  assert.equal((await square.history({ limit: null })).activities.length, 13);
  const observed = await square.history({ observe: true });
  assert.deepEqual(observed.observation.continuation, { direction: 'before', cursor: 'act/3', limit: 10 });
  cli(options, 'Alice', ['history']);
  assert.deepEqual((await readSquareSnapshot(options.path)).state, before);
});

test('departed express reenters exactly once and never-joined express is unsent for SDK and MCP', async (t) => {
  const direct = await fixture(t, 'reentry-sdk'), json = await fixture(t, 'reentry-mcp'), call = await mcp(t, json);
  const { participant: alice } = await direct.square.join('Alice');
  await alice.done();
  await call('join', { as: 'Alice' });
  await call('done', { as: 'Alice' });
  const { observation, delivery, ...expressed } = await alice.express('back', { force: true, observe: true });
  assert.equal(observation.reentry.kind, 'join');
  assert.equal(observation.reentry.id, 'act/2');
  assert.deepEqual(await call('express', { as: 'Alice', body: 'back', force: true }), expressed);
  const never = await direct.square.participant('Never');
  await assert.rejects(never.express('unsent'), (error) => {
    assert.equal(error.facts.reason, 'never_joined');
    assert.deepEqual(error.operation, { operation: 'express', participant: 'Never', subject: 'caller', expressEffect: 'unsent' });
    return true;
  });
  const client = new Client({ name: 'square-parity-error', version: '1' }), server = createSquareMcpServer(json);
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right), client.connect(left)]);
  t.after(async () => { await client.close(); await server.close(); });
  const refused = await client.callTool({ name: 'express', arguments: { as: 'Never', body: 'unsent' } });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.facts.reason, 'never_joined');
  assert.deepEqual(refused.structuredContent.error.operation, { operation: 'express', participant: 'Never', subject: 'caller', expressEffect: 'unsent' });
  assert.deepEqual(await direct.square.history(), await json.square.history());
  assert.equal((await direct.square.participants()).participants.some((participant) => participant.name === 'Never'), false);
});

function measureArtifact(t, squarePath) {
  const file = fs.realpathSync(squarePath), exec = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare;
  let reads = 0, hydrated = 0;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql, ...args) {
    if (this.location() === file && sql.trim().toUpperCase() === 'BEGIN') reads++;
    return exec.call(this, sql, ...args);
  });
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    const statement = prepare.call(this, sql, ...args);
    if (this.location() === file && sql.startsWith('SELECT * FROM activities WHERE act_index IN ')) {
      const all = statement.all;
      statement.all = function (...values) { const rows = all.apply(this, values); hydrated += rows.length; return rows; };
    }
    return statement;
  });
  return async (operation) => {
    const before = { reads, hydrated }, value = await operation();
    return { value, reads: reads - before.reads, hydrated: hydrated - before.hydrated };
  };
}

test('optional observations add only requested reads; MCP never pays for a terminal feed', async (t) => {
  const options = await fixture(t, 'observations'), { square } = options;
  const { participant: alice } = await square.join('Alice'), { participant: bob } = await square.join('Bob');
  await bob.express('for Alice', { force: true, mentions: ['Alice'] });
  const call = await mcp(t, options), measure = measureArtifact(t, options.path);
  const plainJoin = await measure(() => square.join('Alice'));
  const fullJoin = await measure(() => square.join('Alice', { observe: true }));
  const dataJoin = await measure(() => call('join', { as: 'Alice' }));
  const { participant, observation, ...receipt } = fullJoin.value;
  assert.deepEqual(dataJoin.value, { ...receipt, participant: participant.name });
  assert.equal(plainJoin.value.observation, undefined);
  assert.equal(dataJoin.hydrated, 0);
  assert.ok(fullJoin.hydrated > 0);
  assert.equal(fullJoin.reads - plainJoin.reads, 1);
  const dataExpress = await measure(() => call('express', { as: 'Alice', body: 'data', force: true }));
  const plainExpress = await measure(() => alice.express('plain', { force: true }));
  const fullExpress = await measure(() => alice.express('presented', { force: true, observe: true }));
  assert.equal(dataExpress.hydrated, 0);
  assert.equal(plainExpress.value.observation, undefined);
  assert.equal(fullExpress.reads - plainExpress.reads, 1);
  assert.deepEqual(fullExpress.value.observation.pendingPublic.map((act) => act.body), ['for Alice']);
  const caught = await measure(() => call('catch', { as: 'Alice' }));
  assert.deepEqual(caught.value.activities.map((act) => act.body), ['for Alice']);
  assert.equal(caught.hydrated, 1, 'catch hydrates exactly its selected page');
  const plainEmpty = await measure(() => alice.catch()), fullEmpty = await measure(() => alice.catch({ observe: true }));
  const { observation: presence, ...empty } = fullEmpty.value;
  assert.deepEqual(plainEmpty.value, empty);
  assert.equal(fullEmpty.reads - plainEmpty.reads, 1);
  assert.ok(presence.presence);
  const archive = await measure(() => call('history'));
  assert.ok(archive.hydrated > 0);
  assert.deepEqual(archive.value, await square.history());
  assert.deepEqual(await call('status'), await square.status());
  assert.deepEqual(await call('participants'), await square.participants());
});

test('catch resolves caller and all filters in one read, retaining canonical error subjects', async (t) => {
  const options = await fixture(t, 'catch-names'), { square } = options;
  for (const name of ['Alice', 'Bob', 'Cara', 'Dan']) await square.join(name);
  await (await square.participant('Dan')).done();
  const alice = await square.participant('aLiCe'), measure = measureArtifact(t, options.path);
  const one = await measure(() => alice.catch({ from: ['BOB'] }));
  const many = await measure(() => alice.catch({ from: ['BOB', 'cara', 'Dan', 'BOB'] }));
  assert.equal(one.reads, many.reads);
  assert.deepEqual(one.value, many.value);
  assert.equal(many.value.observation, undefined);
  for (const [name, from, subject, canonical] of [['Nobody', ['Unknown'], 'caller', 'Nobody'], ['aLiCe', ['Unknown'], 'filter', 'Alice']]) {
    const participant = await square.participant(name);
    await assert.rejects(participant.catch({ from }), (error) => {
      assert.equal(error.code, 'invalid_args');
      assert.equal(error.facts.reason, 'never_joined');
      assert.deepEqual(error.operation, { operation: 'catch', subject, participant: canonical });
      return true;
    });
  }
});
