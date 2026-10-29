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

async function fixture(t, options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-tools-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const squarePath = path.join(cwd, 'test.square');
  const square = await Square.build({ path: squarePath, markdown: 'Native tool scene', ...options });
  await square.close();
  const tools = registeredTools();
  const context = (id = 'pi-tools-first', directory = cwd) => ({ cwd: directory, sessionManager: { getSessionId: () => id } });
  const call = async (name, args = {}, ctx = context(), signal) => {
    const result = await tools.get(`square_${name}`).execute('test', { location: 'test.square', ...args }, signal, undefined, ctx);
    assert.equal(result.structuredContent, undefined);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    assert.equal(typeof result.content[0].text, 'string');
    return result;
  };
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
    assert.equal(tool.namespace.description, 'A shared square where agents gather to talk, think, and act together.');
    assert.equal(tool.description, shared.description);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal('session' in tool.parameters.properties, false);
    assert.equal(tool.outputSchema, undefined);
    for (const [name, schema] of Object.entries(tool.parameters.properties)) {
      assert.ok(schema.description?.length > 0, `${shared.name}.${name} explains its purpose`);
    }
  }
  assert.equal(tools.get('square_express').parameters.properties.noMention.type, 'boolean');
});

test('Pi calls use live context, preserve environment, and return human text and failures', async (t) => {
  const { cwd, squarePath, context, call } = await fixture(t);
  const before = { ...process.env };
  const ambient = await call('status');
  assert.equal(ambient.isError, undefined);
  assert.doesNotMatch(ambient.content[0].text, /you listen to/);
  const joined = await call('join', { as: 'rei' });
  assert.match(joined.content[0].text, /you stepped into the square/);
  assert.match(joined.content[0].text, /Native tool scene/);
  const firstSeat = await readSeat(squarePath, 'rei');
  assert.deepEqual(firstSeat?.owner, "pi" + ":" + ('pi-tools-first'));

  const refused = await call('join', { as: 'rei' }, context('pi-tools-second'));
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /rei/);
  assert.match((await call('join', { as: 'rei' })).content[0].text, /already in the square/);

  // A fresh context's cwd, not startup state, resolves the relative location.
  const subdir = path.join(cwd, 'other');
  fs.mkdirSync(subdir);
  const secondSquarePath = path.join(subdir, 'test.square');
  const other = await Square.build({ path: secondSquarePath, markdown: 'Other square' });
  await other.close();
  assert.match((await call('join', { as: 'rei' }, context('pi-tools-second', subdir))).content[0].text, /you stepped into the square/);
  const secondSeat = await readSeat(secondSquarePath, 'rei');
  assert.deepEqual(secondSeat?.owner, "pi" + ":" + ('pi-tools-second'));

  for (const args of [{ body: 7 }, { body: 'no', session: 'forged' }, { body: 'no', reply: 'act/01' }]) {
    const invalid = await call('express', args);
    assert.equal(invalid.isError, true);
    assert.ok(invalid.content[0].text.length > 0);
  }
  await call('join', { as: 'bob' });
  await call('attention', { as: 'bob', action: 'listen', target: 'rei' });
  assert.match((await call('status', { as: 'BOB' })).content[0].text, /you listen to\s+· @rei/);
  const ambiguous = await call('status');
  assert.equal(ambiguous.isError, undefined);
  assert.doesNotMatch(ambiguous.content[0].text, /you listen to/);
  assert.match((await call('attention', { as: 'bob', action: 'unlisten', target: 'rei' })).content[0].text, /stops listening to @rei/);
  assert.match((await call('status', { as: 'bob' })).content[0].text, /not turned toward anyone/);
  assert.equal((await call('attention', { as: 'bob', action: 'deafen', target: 'rei' })).isError, true);
  const bare = await call('express', { as: 'rei', body: 'literal @bob', noMention: true, force: true });
  assert.match(bare.content[0].text, /your words land.*act\/\d+/);
  const directed = await call('express', { as: 'rei', body: 'hello', noMention: true, mentions: ['bob'], force: true });
  assert.match(directed.content[0].text, /you walk over to @bob/);
  const caught = await call('catch', { as: 'bob' });
  assert.match(caught.content[0].text, /hello/);
  assert.doesNotMatch(caught.content[0].text, /literal @bob/);
  await call('catch', { as: 'bob' });
  const history = await call('history');
  assert.match(history.content[0].text, /literal @bob/);
  assert.match(history.content[0].text, /hello/);
  const unmatched = await call('express', { as: 'rei', body: '@bob @Eve @eve', force: true });
  assert.match(unmatched.content[0].text, /you walk over to @bob/);
  assert.match(unmatched.content[0].text, /@Eve isn't standing here/);
  const conflict = await call('express', { as: 'rei', body: '@bob', reach: 'bell', mentions: ['bob'], force: true });
  assert.equal(conflict.isError, true);
  assert.ok(conflict.content[0].text.length > 0);
  assert.deepEqual({ ...process.env }, before);
});

test('Pi cancellation reaches a waiting operation without landing its body', async (t) => {
  const { call } = await fixture(t, { throttlePerMinute: 1 });
  await call('join', { as: 'rei' });
  await call('express', { as: 'rei', body: 'first word' });
  const controller = new AbortController();
  const pending = call('express', { as: 'rei', body: 'must not land' }, undefined, controller.signal);
  const timer = setTimeout(() => controller.abort(), 30);
  t.after(() => clearTimeout(timer));
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cancelled/i);
  const history = await call('history');
  assert.doesNotMatch(history.content[0].text, /must not land/);
});
