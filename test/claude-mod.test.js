import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from '../claude-plugin/hooks/register.js';

// Fixture core only: real scheduling is recorded separately in claude-native-validation.md.
function fixture() {
  const handlers = new Map();
  const state = new Map();
  const calls = [];
  let id = 'old-session';
  let result = { recognized: true, current: true };
  const $ = {
    session: { id: async () => id, cwd: async () => '/fixture', version: async () => ({ version: '2.1.295' }) },
    env: { get: async (key) => key === 'CLAUDE_CODE_MESSAGING_SOCKET' ? '/fixture/in.sock' : undefined },
    clock: { now: async () => 100, after: (_ms, fn) => { fn(); } },
    state: { get: async (ref) => ({ value: state.get(`${ref.key}/${ref.id}`), version: 0 }), set: async (ref, value) => { state.set(`${ref.key}/${ref.id}`, structuredClone(value)); return { isSet: true, version: 1 }; } },
    ui: { log: async () => undefined },
    process: { run: async (argv, options) => {
      const input = JSON.parse(options.stdin);
      calls.push({ argv, options, input });
      return { exitCode: 0, stdout: JSON.stringify(input.operation === 'start' || input.operation === 'reconcile' ? { available: true, bindings: [{ location: '/fixture/test.square', participant: 'Bob', session: input.sessionId, epoch: 7 }] } : input.operation === 'cancel' ? { cancelledBindings: input.bindings } : result) };
    } },
  };
  register((name, handler) => handlers.set(name, handler));
  const invoke = async (name, e, next = async () => ({})) => { const result = await handlers.get(name)($, e, Object.assign(next, { budget: { remainingMs: 150 }, signal: new AbortController().signal })); await new Promise((resolve) => setImmediate(resolve)); return result; };
  return { $, handlers, calls, state, invoke, setId: (value) => { id = value; }, setResult: (value) => { result = value; }, reload: () => register((name, handler) => handlers.set(name, handler)) };
}
const text = '[square-inbox:opaque-attempt]\npreview\n[/square-inbox:opaque-attempt]';
const peer = { origin: { kind: 'peer' }, text };

test('mod reconciles initial/reload/classic coordinates and ends only the pinned old epoch', async () => {
  const f = fixture();
  assert.deepEqual([...f.handlers.keys()], ['session.start', 'classic.SessionStart', 'tool.call', 'turn.start', 'session.end', 'turn.abort', 'turn.complete', 'session.receive', 'session.append']);
  await f.invoke('session.start', {});
  f.reload();
  await f.invoke('session.start', {});
  f.setId('new-session');
  await f.invoke('classic.SessionStart', { session_id: 'new-session' });
  await f.invoke('session.end', { sessionId: 'old-session' });
  const end = f.calls.at(-1);
  assert.equal(end.input.sessionId, 'old-session');
  assert.equal(end.input.bindings[0].epoch, 7);
  assert.equal(end.options.timeoutMs, 150);
  assert.equal(f.state.get('inbox/new-session').coordinate.sessionId, 'new-session');
  for (const call of f.calls) { assert.deepEqual(call.argv, ['square', 'claude-mod']); assert.equal(call.options.env, undefined); }
});

test('receive next is called once; held/refused, consumed and changed results never claim admission', async () => {
  const f = fixture();
  for (const returned of [{ consumed: 'downstream' }, { text: 'rewritten' }]) {
    f.calls.length = 0;
    let passed = 0;
    assert.equal(await f.invoke('session.receive', peer, async () => { passed++; return returned; }), returned);
    assert.equal(passed, 1);
    assert.deepEqual(f.calls.map((call) => call.input.operation), ['guard']);
  }
  f.calls.length = 0;
  let passed = 0;
  await assert.rejects(f.invoke('session.receive', peer, async () => { passed++; throw new Error('delivery was not queued'); }), /not queued/);
  assert.equal(passed, 1);
  assert.deepEqual(f.calls.map((call) => call.input.operation), ['guard']);
  f.calls.length = 0;
  await f.invoke('session.receive', peer, async () => ({ text }));
  assert.deepEqual(f.calls.map((call) => call.input.operation), ['guard', 'admitted']);
  assert.equal(f.calls.some((call) => call.input.operation === 'stored'), false);
});

test('unknown peer messages pass through; recognized stale messages are consumed before queueing', async () => {
  const f = fixture();
  f.setResult({ recognized: false, current: false });
  let nextCount = 0;
  await f.invoke('session.receive', peer, async () => { nextCount++; return { text }; });
  assert.equal(nextCount, 1);
  f.setResult({ recognized: true, current: false });
  const consumed = await f.invoke('session.receive', peer, async () => { throw new Error('must not queue'); });
  assert.match(consumed.consumed, /stale or cancelled/);
});

test('append confirms only the returned main user-role stored text block, not entry or subagent rows', async () => {
  const f = fixture();
  const e = { origin: { kind: 'peer' }, message: { role: 'user', content: [{ type: 'text', text }] } };
  await f.invoke('session.append', e, async () => ({ message: { role: 'user', content: [{ type: 'text', text: 'removed' }] } }));
  assert.equal(f.calls.length, 0);
  const stored = { message: { role: 'user', content: [{ type: 'text', text: `native framing\n${text}\npolicy` }] } };
  assert.equal(await f.invoke('session.append', e, async () => stored), stored);
  assert.equal(f.calls.at(-1).input.operation, 'stored');
  f.calls.length = 0;
  await f.invoke('session.append', { ...e, agentId: 'child' }, async () => stored);
  await f.invoke('session.append', e, async () => ({ message: { role: 'assistant', content: stored.message.content } }));
  assert.equal(f.calls.length, 0);
});

test('bridge/state/timer errors preserve exactly one next and returned native results', async () => {
  const f = fixture();
  let count = 0;
  const next = async () => { count++; return { text }; };
  f.$.process.run = async () => { throw new Error('bridge unavailable'); };
  await f.invoke('session.receive', peer, next);
  assert.equal(count, 1);
  f.$.clock.now = async () => { throw new Error('clock unavailable'); };
  await f.invoke('session.end', { sessionId: 'old-session' }, next);
  assert.equal(count, 2);
  const g = fixture();
  g.$.clock.after = () => { throw new Error('timer denied'); };
  assert.deepEqual(await g.invoke('session.receive', peer, next), { text });
  assert.equal(count, 3);
  g.$.state.get = async () => { throw new Error('state denied'); };
  await g.invoke('session.receive', peer, next);
  assert.equal(count, 4);
});

test('classic resume uses pinned target while session API still reads the ending coordinate', async () => {
  const f = fixture();
  await f.invoke('classic.SessionStart', { session_id: 'resumed-session', source: 'resume' });
  assert.equal(f.calls[0].input.sessionId, 'resumed-session');
  assert.equal(f.calls[0].input.resume, true);
});

test('failed tool still reconciles committed memberships without body injection', async () => {
  const f = fixture();
  await assert.rejects(f.invoke('tool.call', {}, async () => { throw new Error('aborted tool'); }), /aborted tool/);
  assert.equal(f.calls.at(-1).input.operation, 'reconcile');
  assert.equal(f.calls.at(-1).input.text, undefined);
});

test('explicit abort suppression survives code reload; ordinary completion is not cancellation', async () => {
  const f = fixture();
  await f.invoke('session.start', {});
  await f.invoke('turn.abort', { turnId: 'turn' });
  assert.equal(f.state.get('cancelAt/old-session').at, 100);
  assert.equal(f.state.get('cancelAt/old-session').bindings[0].epoch, 7);
  f.reload();
  await f.invoke('session.start', {});
  assert.equal(f.calls.at(-1).input.cancelAt, 100);
  await f.invoke('session.receive', peer, async () => ({ text }));
  assert.equal(f.calls.at(-1).input.cancelAt, 100);
  const cancellations = f.calls.filter((call) => call.input.operation === 'cancel').length;
  await f.invoke('turn.complete', { reason: 'answer' });
  assert.equal(f.calls.filter((call) => call.input.operation === 'cancel').length, cancellations);
  await f.invoke('turn.complete', { reason: 'aborted' });
  assert.equal(f.calls.filter((call) => call.input.operation === 'cancel').length, cancellations + 1);
});
