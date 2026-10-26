import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import squarePiExtension from '../plugins/pi/square-pi.js';
import { Square } from '../dist/square-api.js';
import { createArtifactPort } from '../dist/artifact.js';
import { SQUARE_TOOLS } from '../dist/square-tools.js';

function registeredTools() {
  const tools = new Map();
  squarePiExtension({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerFlag() {}, getFlag() {}, on() {},
    sendMessage() { throw new Error('registration must not send messages'); },
  });
  return tools;
}

async function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-tools-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const squarePath = path.join(cwd, 'test.square');
  const square = await Square.build({ path: squarePath, markdown: 'Native tool scene' });
  await square.close();
  const tools = registeredTools();
  const context = (id = 'pi-tools-first', directory = cwd) => ({ cwd: directory, sessionManager: { getSessionId: () => id } });
  const call = (name, args = {}, ctx = context(), signal) => tools.get(`square_${name}`).execute('test', { location: 'test.square', ...args }, signal, undefined, ctx);
  return { cwd, squarePath, tools, context, call };
}

async function readSeat(squarePath, participant) {
  const artifact = createArtifactPort(squarePath);
  try { return (await artifact.read(facts => facts.seat(participant))).value; }
  finally { await artifact.close(); }
}

test('Pi registers the shared contract as namespaced codemode tools', () => {
  const tools = registeredTools();
  assert.deepEqual([...tools.keys()], SQUARE_TOOLS.map(tool => `square_${tool.name}`));
  for (const shared of SQUARE_TOOLS) {
    const tool = tools.get(`square_${shared.name}`);
    assert.equal(tool.exposure, 'codemode');
    assert.equal(tool.namespace.name, 'square');
    assert.equal(tool.description, shared.description);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal('session' in tool.parameters.properties, false);
    assert.equal(tool.outputSchema.type, 'object');
  }
  assert.equal(tools.get('square_express').parameters.properties.noMention.type, 'boolean');
});

test('Pi calls use live context, preserve environment, and return structured data and errors', async (t) => {
  const { cwd, squarePath, context, call } = await fixture(t);
  const before = { ...process.env };
  const joined = await call('join', { as: 'rei' });
  assert.equal(joined.structuredContent.participant, 'rei');
  assert.match(joined.content[0].text, /you stepped into the square/);
  assert.doesNotMatch(joined.content[0].text, /"observation"/);
  const firstSeat = await readSeat(squarePath, 'rei');
  assert.deepEqual(firstSeat?.body, { channel: 'pi', session: 'pi-tools-first' });

  const refused = await call('join', { as: 'rei' }, context('pi-tools-second'));
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.code, 'already_joined');
  assert.equal((await call('join', { as: 'rei' })).structuredContent.kind, 'reconnected');

  // A fresh context's cwd, not startup state, resolves the relative location.
  const subdir = path.join(cwd, 'other');
  fs.mkdirSync(subdir);
  const secondSquarePath = path.join(subdir, 'test.square');
  const other = await Square.build({ path: secondSquarePath, markdown: 'Other square' });
  await other.close();
  assert.equal((await call('join', { as: 'rei' }, context('pi-tools-second', subdir))).structuredContent.kind, 'joined');
  const secondSeat = await readSeat(secondSquarePath, 'rei');
  assert.deepEqual(secondSeat?.body, { channel: 'pi', session: 'pi-tools-second' });

  for (const args of [{ body: 7 }, { body: 'no', session: 'forged' }, { body: 'no', reply: 'act/01' }]) {
    const invalid = await call('express', args);
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent.error.code, 'invalid_args');
  }
  await call('join', { as: 'bob' });
  await call('listen', { as: 'bob', target: 'rei' });
  assert.equal((await call('unlisten', { as: 'bob', target: 'rei' })).structuredContent.activity.kind, 'unlisten');
  assert.deepEqual((await call('listening', { as: 'bob' })).structuredContent.listening, []);
  const bare = await call('express', { as: 'rei', body: 'literal @bob', noMention: true, force: true });
  assert.deepEqual(bare.structuredContent.activity.mentions, []);
  assert.equal(typeof bare.structuredContent.hint, 'string', 'the first expression carries the shared hint');
  const directed = await call('express', { as: 'rei', body: 'hello', noMention: true, mentions: ['bob'], force: true });
  assert.deepEqual(directed.structuredContent.activity.mentions, ['bob']);
  assert.equal(directed.structuredContent.hint, undefined);
  const caught = await call('catch', { as: 'bob' });
  assert.equal(caught.structuredContent.activities.length, 1);
  assert.equal(typeof caught.structuredContent.hint, 'string', 'the first catch carries the shared hint');
  assert.equal((await call('catch', { as: 'bob' })).structuredContent.hint, undefined, 'an empty catch carries no hint');
  const history = await call('history');
  assert.deepEqual(history.structuredContent.activities.filter(a => a.kind === 'say').map(a => a.body), ['literal @bob', 'hello']);
  const unmatched = await call('express', { as: 'rei', body: '@bob @Eve @eve', force: true });
  assert.deepEqual(unmatched.structuredContent.activity.mentions, ['bob']);
  assert.deepEqual(unmatched.structuredContent.unmatchedMentions, ['Eve']);
  const conflict = await call('express', { as: 'rei', body: '@bob', reach: 'bell', mentions: ['bob'], force: true });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.error.facts.reason, 'bell_mention_conflict');
  assert.deepEqual({ ...process.env }, before);
});

test('Pi cancellation reaches a waiting operation without landing its body', async (t) => {
  const { call } = await fixture(t);
  await call('join', { as: 'rei' });
  await call('hold', { as: 'rei', reason: 'wait' });
  const controller = new AbortController();
  const pending = call('express', { as: 'rei', body: 'must not land' }, undefined, controller.signal);
  const timer = setTimeout(() => controller.abort(), 30);
  t.after(() => clearTimeout(timer));
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'cancelled');
  const history = await call('history');
  assert.equal(history.structuredContent.activities.some(a => a.body === 'must not land'), false);
  assert.equal((await call('resume', { as: 'rei' })).isError, undefined);
});
