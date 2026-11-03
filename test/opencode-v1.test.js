import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import plugin from '../dist/plugins/opencode-v1/index.js';
import { legacyTransport, nativeMessageId } from '../dist/plugins/opencode-v1/transport.js';
import { startReceiver } from '../dist/plugins/opencode-v1/runtime.js';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { harnessOwner } from '../dist/owner.js';
import { installOpenCodePlugin, uninstallOpenCodePlugin, verifyOpenCodeRuntime } from '../dist/harness-links.js';

test('v1 native message IDs are unique, ordered and native-shaped', () => {
  const ids = Array.from({ length: 100 }, nativeMessageId);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), ids);
  assert.ok(ids.every(id => /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id)));
});

test('v1 persists correlation before submission but never claims native acceptance', async () => {
  const events = [];
  const transport = legacyTransport({ session: { promptAsync: async input => { events.push(['call', input]); return { response: { status: 204 } }; } } }, 'ses_a', new AbortController().signal);
  const context = { token: 'handoff', signal: new AbortController().signal, deadline: Date.now() + 1000,
    prepare: async value => { events.push(['prepare', value]); return true; }, beforeSend: async () => { events.push(['check']); return true; } };
  assert.equal(await transport.send({ text: 'hello' }, { sessionId: 'ses_a' }, context), 'unknown');
  assert.deepEqual(events.map(event => event[0]), ['prepare', 'check', 'call']);
  assert.equal(events[0][1].token, 'handoff');
  assert.equal(events[0][1].messageId, events[2][1].body.messageID);
  assert.equal(events[0][1].payloadHash, createHash('sha256').update('hello').digest('hex'));
  assert.deepEqual(events[2][1].body.parts, [{ type: 'text', text: 'hello' }]);
});

test('v1 refuses an aborted final fence without invoking the SDK', async () => {
  const abort = new AbortController();
  let calls = 0;
  const transport = legacyTransport({ session: { promptAsync: async () => { calls++; return {}; } } }, 'ses_a', abort.signal);
  const result = await transport.send({ text: 'hello' }, { sessionId: 'ses_a' }, {
    token: 'handoff', signal: abort.signal, deadline: Date.now() + 1000, prepare: async () => true,
    beforeSend: async () => { abort.abort(); return true; },
  });
  assert.equal(result, 'not-capable');
  assert.equal(calls, 0);
});

test('v1 transform ignores synthetic parts and confirms only exact observed text', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-v1-context-'));
  const previous = process.env.SQUARE_DELIVERY;
  process.env.SQUARE_DELIVERY = path.join(root, 'delivery.sqlite');
  const ledger = await DeliveryLedger.open({ location: process.env.SQUARE_DELIVERY });
  const owner = harnessOwner({ channel: 'opencode', session: 'ses_v1' });
  await ledger.attach({ owner, expectedGeneration: null, routes: [] });
  const hooks = await startReceiver({ directory: root, project: { id: 'project' }, client: { session: {
    get: async () => ({ data: { id: 'ses_v1', projectID: 'project', directory: root } }),
    promptAsync: async () => ({ response: { status: 204 } }),
  } } });
  t.after(async () => {
    await hooks.dispose(); await ledger.close();
    if (previous === undefined) delete process.env.SQUARE_DELIVERY; else process.env.SQUARE_DELIVERY = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const message = synthetic => ({ info: { id: 'native-message', sessionID: 'ses_v1', role: 'user' },
    parts: [{ type: 'text', text: 'hello', sessionID: 'ses_v1', messageID: 'native-message', synthetic }] });
  await hooks['experimental.chat.messages.transform']({}, { messages: [message(false)] });
  const generation = (await ledger.session(owner)).generation;
  await ledger.post({ owner, key: 'card', text: 'hello' });
  const result = await ledger.dispatchHandoff(owner, 'card', { kind: 'opencode-server', async send(card, _address, context) {
    await context.prepare({ token: context.token, messageId: 'native-message', payloadHash: createHash('sha256').update(card.text).digest('hex') });
    return 'unknown';
  } }, { generation, timeoutMs: 1000 });
  assert.equal(result.outcome, 'unknown');
  await hooks['experimental.chat.messages.transform']({}, { messages: [message(true)] });
  assert.deepEqual(await ledger.receipts(owner), []);
  await hooks['experimental.chat.messages.transform']({}, { messages: [message(false)] });
  assert.equal((await ledger.receipts(owner)).length, 1);
  await ledger.post({ owner, key: 'interrupted', text: 'later' });
  await hooks.event({ event: { type: 'session.error', properties: { sessionID: 'ses_v1', error: { name: 'MessageAbortedError' } } } });
  const next = (await ledger.session(owner)).generation;
  assert.notEqual(next, generation);
  assert.deepEqual(await ledger.pending(owner, { generation: next }), []);
});

test('unavailable health leaves bounded shell-only integration', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('offline'); });
  t.mock.method(console, 'warn', () => {});
  const hooks = await plugin({ serverUrl: 'http://127.0.0.1', client: { session: {} } });
  assert.deepEqual(Object.keys(hooks), ['shell.env']);
  const output = { env: {} };
  await hooks['shell.env']({ sessionID: 'ses_one' }, output);
  assert.equal(output.env.OPENCODE_SESSION_ID, 'ses_one');
});

test('major one installs only owned file URL and diagnoses moved file without removing lookalikes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-v1-install-'));
  const prev = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  t.after(() => { if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev; fs.rmSync(root, { recursive: true, force: true }); });
  const config = path.join(root, 'config/opencode/opencode.jsonc'); fs.mkdirSync(path.dirname(config), { recursive: true });
  const previous = path.join(root, 'gone/node_modules/@astrosheep/square');
  fs.mkdirSync(previous, { recursive: true });
  fs.writeFileSync(path.join(previous, 'package.json'), JSON.stringify({ name: '@astrosheep/square' }));
  const old = pathToFileURL(path.join(previous, 'dist/plugins/opencode-v1/index.js')).href;
  const lookalike = pathToFileURL(path.join(root, 'other/dist/plugins/opencode-v1/index.js')).href;
  fs.writeFileSync(config, JSON.stringify({ plugin: [old, lookalike], plugins: ['other'] }));
  assert.match(verifyOpenCodeRuntime(root), /plugin file missing/);
  const source = fs.readFileSync(config, 'utf8');
  assert.throws(() => installOpenCodePlugin(root, false, () => ({ status: 0, stdout: '3.0.0', stderr: '' })), /Unsupported OpenCode version/);
  assert.equal(fs.readFileSync(config, 'utf8'), source);
  const calls = [];
  installOpenCodePlugin(root, false, (_home, args) => { calls.push(args); return { status: 0, stdout: '1.19.5', stderr: '' }; });
  const parsed = JSON.parse(fs.readFileSync(config));
  assert.deepEqual(calls, [['--version']]);
  assert.equal(parsed.plugin.length, 2); assert.equal(parsed.plugin[0], lookalike); assert.match(parsed.plugin[1], /^file:/);
  assert.deepEqual(parsed.plugins, ['other']);
  assert.match(verifyOpenCodeRuntime(root), /ownership unverified/);
  installOpenCodePlugin(root, false, (_home, args) => { calls.push(args); return { status: 0, stdout: '1.19.5', stderr: '' }; });
  assert.deepEqual(JSON.parse(fs.readFileSync(config)), parsed);
  uninstallOpenCodePlugin(root);
  assert.deepEqual(JSON.parse(fs.readFileSync(config)).plugin, [lookalike]);
});

test('v1 lookalike paths with missing or wrong manifests are preserved and diagnosed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-v1-unproven-'));
  const prev = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  t.after(() => { if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev; fs.rmSync(root, { recursive: true, force: true }); });
  const config = path.join(root, 'config/opencode/opencode.json'); fs.mkdirSync(path.dirname(config), { recursive: true });
  const missing = path.join(root, 'missing/node_modules/@astrosheep/square');
  const wrong = path.join(root, 'wrong/node_modules/@astrosheep/square');
  fs.mkdirSync(wrong, { recursive: true });
  fs.writeFileSync(path.join(wrong, 'package.json'), JSON.stringify({ name: 'someone-else' }));
  const urls = [missing, wrong].map(dir => pathToFileURL(path.join(dir, 'dist/plugins/opencode-v1/index.js')).href);
  for (const url of urls) {
    const source = JSON.stringify({ plugin: [url] });
    fs.writeFileSync(config, source);
    assert.match(verifyOpenCodeRuntime(root), /ownership unverified/);
    assert.deepEqual(uninstallOpenCodePlugin(root), []);
    assert.equal(fs.readFileSync(config, 'utf8'), source);
    installOpenCodePlugin(root, false, () => ({ status: 0, stdout: '1.19.5', stderr: '' }));
    assert.ok(JSON.parse(fs.readFileSync(config)).plugin.includes(url));
    assert.match(verifyOpenCodeRuntime(root), /ownership unverified/);
    uninstallOpenCodePlugin(root);
    assert.deepEqual(JSON.parse(fs.readFileSync(config)).plugin, [url]);
  }
});
