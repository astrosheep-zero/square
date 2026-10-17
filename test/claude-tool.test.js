import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from '../plugins/claude/hooks/register.js';

function fixture({ refuseTool = false } = {}) {
  const handlers = new Map();
  const registrations = [];
  const calls = [];
  const bridged = [];
  const logs = [];
  const coordinate = { id: 'initial-session', cwd: '/initial' };
  let output = { stdout: 'CLI output\n', stderr: '', exitCode: 0 };
  const $ = {
    session: { id: async () => coordinate.id, cwd: async () => coordinate.cwd, version: async () => ({ version: '2.1.296' }) },
    env: { get: async () => undefined },
    state: { get: async () => ({ version: 0 }), set: async () => ({ isSet: true, version: 1 }) },
    ui: { log: async (text) => { logs.push(text); } },
    tool: { register: async (spec) => { if (refuseTool) throw new Error('refused: no built-in tools'); registrations.push(spec); return { tool: 'mcp__square__square' }; } },
    process: { run: async (argv, options) => {
      if (argv.length === 2 && argv[1] === 'claude-mod') return bridged.push(options), { stdout: JSON.stringify({ available: false, bindings: [], diagnostic: 'Native inbox unavailable' }), exitCode: 0 };
      calls.push({ argv, options });
      if (output instanceof Error) throw output;
      return output;
    } },
  };
  register((name, handler) => handlers.set(name, handler));
  const invoke = (name, e, next = async () => { throw new Error('handled tool must not fall through'); }, signal = new AbortController().signal) => handlers.get(name)($, e, Object.assign(next, { signal }));
  return { coordinate, registrations, calls, bridged, logs, invoke, setOutput: (value) => { output = value; } };
}
const tool = 'mcp__square__square';

test('a refused square tool still lets the native inbox reconcile at session start', async () => {
  const f = fixture({ refuseTool: true });
  const started = {};
  assert.equal(await f.invoke('session.start', {}, async () => started), started);
  assert.equal(f.registrations.length, 0);
  assert.equal(f.bridged.length, 1);
  assert.match(f.logs[0], /Square tool unavailable: refused/);
});

test('square is upfront without native inbox capability and runs direct argv with the live main/child coordinate', async () => {
  const f = fixture();
  const started = {};
  assert.equal(await f.invoke('session.start', {}, async () => started), started);
  assert.deepEqual(f.registrations, [{
    name: 'square',
    description: "Run the square CLI. args are exactly the words after `square`; `--help` after an operation shows its usage. Pass a `-` body as stdin.",
    inputSchema: { type: 'object', properties: { args: { type: 'array', items: { type: 'string' } }, stdin: { type: 'string' } }, required: ['args'] },
    isDeferred: false,
  }]);
  f.coordinate.id = 'current-session';
  f.coordinate.cwd = '/current directory';
  const args = ['--location', '.square/PUBLIC.square', '--as', 'faye', 'express', '--mention', 'bob', '-'];
  const stdin = '*points* $HOME; $(not-a-shell)\nsecond line\n';
  assert.deepEqual(await f.invoke('tool.call', { tool, args, stdin }), { result: 'CLI output\n' });
  assert.deepEqual(f.calls[0], {
    argv: ['square', ...args],
    options: { cwd: '/current directory', stdin, env: { CLAUDE_CODE_SESSION_ID: 'current-session', CLAUDE_CODE_CHILD_SESSION: '' }, timeoutMs: 600_000 },
  });
  f.coordinate.id = 'next-session';
  f.coordinate.cwd = '/child directory';
  const childArgs = ['catch', '--idle', '30m'];
  await f.invoke('tool.call', { tool, args: childArgs, agentId: 'child' });
  assert.deepEqual(f.calls[1], {
    argv: ['square', ...childArgs],
    options: { cwd: '/child directory', stdin: undefined, env: { CLAUDE_CODE_SESSION_ID: 'next-session', CLAUDE_CODE_CHILD_SESSION: '1' }, timeoutMs: 600_000 },
  });
});

test('CLI output preserves stdout and stderr; nonzero status is a textual error with its exit code', async () => {
  const f = fixture();
  f.setOutput({ stdout: 'partial output', stderr: 'diagnostic\n', exitCode: 2 });
  assert.deepEqual(await f.invoke('tool.call', { tool, args: ['catch', '--now'] }), { deny: 'partial output\ndiagnostic\nExit code: 2' });
  f.setOutput({ stdout: 'success\n', stderr: 'warning\n', exitCode: 0 });
  assert.deepEqual(await f.invoke('tool.call', { tool, args: ['status'] }), { result: 'success\nwarning\n' });
});

test('unrelated tools pass through; process failures surface and an already cancelled call cannot launch the CLI', async () => {
  const f = fixture();
  const event = { tool: 'Read', file_path: 'probe' };
  const returned = { result: 'unrelated' };
  let passed = 0;
  assert.equal(await f.invoke('tool.call', event, async (e) => { assert.equal(e, event); passed++; return returned; }), returned);
  assert.equal(passed, 1);
  assert.equal(f.calls.length, 0);
  f.setOutput(new Error('process unavailable'));
  await assert.rejects(f.invoke('tool.call', { tool, args: ['status'] }), /process unavailable/);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(f.invoke('tool.call', { tool, args: ['catch', '--idle', '30m'] }, undefined, controller.signal), /cancelled/);
  assert.equal(f.calls.length, 1);
});
