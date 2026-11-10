import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { runClaudeMod } from '../dist/claude-mod.js';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { harnessOwner } from '../dist/owner.js';
import { beginClaudeMcpCall, readClaudeMcpCall } from '../dist/claude-mcp-context.js';

async function until(check) {
  const deadline = Date.now() + 4000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Claude mod condition did not settle');
    await sleep(5);
  }
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-claude-mod-'));
  const env = { SQUARE_DELIVERY: path.join(root, 'delivery.sqlite') };
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  const module = await import(`../plugins/claude/hooks/register.js?test=${randomUUID()}`);
  const hooks = new Map(), children = [], effects = [], logs = [], requests = [];
  let sessionId = 'native-session';
  const owner = agent => harnessOwner({ channel: 'claude-code', session: sessionId, ...(agent ? { agent } : {}) });
  if (options.routes) await ledger.attach({ owner: owner(), expectedGeneration: null, routes: options.routes });
  const event = (name, input, next = async () => ({})) => hooks.get(name)($, input, next);
  const $ = {
    session: {
      id: async () => sessionId, cwd: async () => root,
      append: async input => {
        effects.push({ kind: 'append', input });
        if (options.append) return options.append(input);
        return { message: { type: 'user', role: 'user', isMeta: true, content: input.message.content }, uuid: randomUUID() };
      },
    },
    prompt: { submit: async input => {
      effects.push({ kind: 'submit', input });
      if (options.submit) return options.submit(input);
      await event('turn.start', { turnId: randomUUID(), text: input.text });
      return { text: input.text, origin: { kind: 'plugin', name: 'square' } };
    } },
    ui: { log: (text, opts) => logs.push({ text, debug: opts?.to === 'debug' }) },
    clock: { after: (_ms, fn) => { const timer = setTimeout(fn, 0); return { cancel: () => clearTimeout(timer) }; } },
    http: { fetch: async (url, init) => {
      const input = JSON.parse(init.body);
      requests.push(input);
      const response = await fetch(url, init);
      const result = { ok: response.ok, status: response.status, text: await response.text() };
      if (options.response) await options.response(input, result);
      return result;
    } },
    process: { spawn: input => {
      assert.deepEqual(input.argv, ['square', 'claude-mod']);
      const controller = new AbortController(), queue = [], readers = [];
      let done = false;
      const push = value => readers.length ? readers.shift()(value) : queue.push(value);
      const running = runClaudeMod(input.input, env, controller.signal, line => { push({ done: false, value: { stream: 'stdout', text: line } }); })
        .finally(() => { done = true; while (readers.length) readers.shift()({ done: true }); });
      children.push({ controller, running });
      return {
        next: () => queue.length ? Promise.resolve(queue.shift()) : done ? Promise.resolve({ done: true }) : new Promise(resolve => readers.push(resolve)),
        return: async () => { controller.abort(); await running; return { done: true }; },
      };
    } },
  };
  module.register((name, matcher, handler) => {
    hooks.set(name, handler ?? matcher);
    return { catch() {} };
  });
  t.after(async () => {
    for (const child of children) child.controller.abort();
    await Promise.all(children.map(child => child.running));
    await ledger.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await event('session.start', {});
  const post = (key, text = key, agent) => ledger.post({ owner: owner(agent), key, text });
  return { $, env, root, ledger, owner, event, post, effects, logs, requests, children, setSession: value => { sessionId = value; } };
}

test('busy mod appends and logs each card once; exact native acceptance alone settles presentation', async t => {
  const f = await fixture(t, { routes: [{ kind: 'http', address: { url: 'http://127.0.0.1:1' } }] });
  assert.deepEqual((await f.ledger.session(f.owner())).routes.map(route => route.kind), ['claude-mod']);
  await f.event('turn.start', { turnId: 'main' });
  await f.post('one', 'full card one');
  await until(async () => (await f.ledger.receipts(f.owner())).length === 1);
  assert.equal(f.effects.length, 1);
  assert.equal(f.effects[0].kind, 'append');
  assert.equal(f.effects[0].input.agentId, undefined);
  assert.match(f.effects[0].input.message.content[0].text, /external notification[\s\S]*full card one/);
  assert.deepEqual(f.logs.filter(log => !log.debug).map(log => log.text), ['full card one']);
  await f.post('one', 'full card one');
  await f.post('two', 'full card two');
  await until(async () => (await f.ledger.receipts(f.owner())).length === 2);
  assert.deepEqual(f.effects.map(effect => effect.kind), ['append', 'append']);
});

test('idle mod submits an attributed prompt, never append plus submit, and rearms after normal completion', async t => {
  const f = await fixture(t);
  await f.post('idle-one');
  await until(async () => (await f.ledger.receipts(f.owner())).length === 1);
  assert.equal(f.effects[0].kind, 'submit');
  assert.equal('asUser' in f.effects[0].input, false);
  assert.deepEqual(f.logs.filter(log => !log.debug), []);
  await f.event('turn.complete', { turnId: 'wake-one', isAborted: false });
  await f.post('idle-two');
  await until(async () => (await f.ledger.receipts(f.owner())).length === 2);
  assert.deepEqual(f.effects.map(effect => effect.kind), ['submit', 'submit']);
});

test('Stop fences an in-flight guard, suppresses its batch without receipts, and requires new native input', async t => {
  const guarded = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, { response: async input => {
    if (input.op === 'guard') { guarded.resolve(); await release.promise; }
  } });
  await f.event('turn.start', { turnId: 'before-stop' });
  await f.post('cancelled');
  await guarded.promise;
  await f.event('turn.complete', { turnId: 'before-stop', isAborted: true });
  release.resolve();
  await f.post('after-stop');
  await sleep(50);
  assert.deepEqual(f.effects, []);
  assert.deepEqual(await f.ledger.receipts(f.owner()), []);
  await f.event('turn.start', { turnId: 'new-user-turn' });
  await until(async () => (await f.ledger.receipts(f.owner())).length === 1);
  assert.deepEqual((await f.ledger.receipts(f.owner())).map(row => row.key), ['after-stop']);
});

test('native append uncertainty is held without submit fallback or false receipts', async t => {
  const f = await fixture(t, { append: async () => { throw new Error('native result lost'); } });
  await f.event('turn.start', { turnId: 'main' });
  await f.post('uncertain');
  await until(async () => (await f.ledger.health(f.owner())).unknownAttempts.length === 1);
  await f.event('turn.complete', { isAborted: false });
  await f.post('uncertain');
  await sleep(40);
  assert.deepEqual(f.effects.map(effect => effect.kind), ['append']);
  assert.deepEqual(await f.ledger.receipts(f.owner()), []);
});

test('rewritten append content is not reported as exact presentation', async t => {
  const f = await fixture(t, { append: async () => ({ uuid: randomUUID(), message: { content: [{ type: 'text', text: 'rewritten' }] } }) });
  await f.event('turn.start', { turnId: 'main' });
  await f.post('rewritten');
  await until(async () => (await f.ledger.health(f.owner())).unknownAttempts.length === 1);
  assert.deepEqual(await f.ledger.receipts(f.owner()), []);
});

test('idle Escape refuses submit, cancels that batch, and does not keep retrying it', async t => {
  const f = await fixture(t, { submit: async () => ({ drop: 'the session was stopped and nobody has sent input since' }) });
  await f.post('idle-stopped');
  await until(() => f.requests.some(request => request.op === 'state' && request.mode === 'stopped'));
  await f.post('idle-stopped');
  await sleep(50);
  assert.deepEqual(f.effects.map(effect => effect.kind), ['submit']);
  assert.deepEqual(await f.ledger.receipts(f.owner()), []);
});

test('clear closes the captured attachment; the next prompt starts a new helper without another session.start', async t => {
  const f = await fixture(t);
  const oldOwner = f.owner();
  await f.event('session.end', { sessionId: 'native-session', reason: 'clear' });
  assert.equal((await f.ledger.session(oldOwner)).state, 'detached');
  f.setSession('after-clear');
  await f.event('prompt.submit', { text: 'new input' });
  await f.event('turn.start', { turnId: 'new-session' });
  await f.ledger.post({ owner: oldOwner, key: 'old-session', text: 'must not leak' });
  await f.post('new-session');
  await until(async () => (await f.ledger.receipts(f.owner())).length === 1);
  assert.equal(f.children.length, 2);
  assert.equal(f.effects.length, 1);
  assert.match(f.effects[0].input.message.content[0].text, /new-session/);
  assert.doesNotMatch(f.effects[0].input.message.content[0].text, /must not leak/);
});

test('main and child MCP identities come from native tool metadata; collision denies and finally cleans the exact call', async t => {
  const f = await fixture(t);
  await f.event('turn.start', { turnId: 'main' });
  await f.event('turn.start', { turnId: 'child', agentId: 'child-agent' });
  for (const agentId of [undefined, 'child-agent']) {
    const tool = { tool: 'mcp__plugin_square_square__join', tool_use_id: randomUUID(), agentId, sessionId: 'model-forgery' };
    const returned = await f.event('tool.call', tool, async () => {
      assert.deepEqual(await readClaudeMcpCall(tool.tool_use_id, f.env), { toolUseId: tool.tool_use_id, sessionId: 'native-session', cwd: f.root, ...(agentId === undefined ? {} : { agentId }) });
      const collision = await f.event('tool.call', tool, () => assert.fail('duplicate call must not run'));
      assert.match(collision.deny, /identity is unavailable/);
      return { result: 'real tool result' };
    });
    assert.equal(returned.result, 'real tool result');
    await assert.rejects(readClaudeMcpCall(tool.tool_use_id, f.env), { code: 'unavailable' });
  }
  const foreign = { toolUseId: 'foreign', sessionId: 'another-session', cwd: f.root };
  await beginClaudeMcpCall(foreign, f.env);
  const denied = await f.event('tool.call', { tool: 'mcp__plugin_square_square__join', tool_use_id: 'foreign' }, () => assert.fail('collision must not invoke the MCP server'));
  assert.match(denied.deny, /identity is unavailable/);
  assert.deepEqual(await readClaudeMcpCall('foreign', f.env), foreign);
  await f.post('child-card', 'only the child reads this', 'child-agent');
  await until(async () => (await f.ledger.receipts(f.owner('child-agent'))).length === 1);
  assert.equal(f.effects[0].input.agentId, 'child-agent');
  assert.deepEqual(await f.ledger.receipts(f.owner()), []);
  await f.event('turn.complete', { agentId: 'child-agent', isAborted: false });
  assert.equal((await f.ledger.session(f.owner('child-agent'))).state, 'detached');
  await f.event('turn.start', { agentId: 'aborted-child' });
  await f.event('turn.complete', { agentId: 'aborted-child', isAborted: true });
  assert.equal((await f.ledger.session(f.owner('aborted-child'))).state, 'detached');
  await f.post('after-child-abort');
  await until(async () => (await f.ledger.receipts(f.owner())).length === 1);
  assert.equal(f.effects.at(-1).input.agentId, undefined, 'Child cancellation must not stop the main receiver');
});
