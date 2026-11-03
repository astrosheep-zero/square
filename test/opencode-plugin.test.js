import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import plugin from '../dist/plugins/opencode/index.js';

function host(version, directory) {
  const hooks = new Map();
  let subscribed = 0, stopped = 0, sends = 0;
  const ctx = {
    app: { version }, location: { directory, project: { id: 'project' } },
    session: {
      async hook(name, callback) { hooks.set(name, callback); },
      async get({ sessionID }) { return { id: sessionID, projectID: 'project', location: { directory } }; },
      async prompt() { sends++; throw new Error('unexpected send'); },
    },
    event: { async *subscribe({ signal }) {
      subscribed++;
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      stopped++;
    } },
  };
  return { ctx, hooks, counts: () => ({ subscribed, stopped, sends }) };
}

test('compatible v2 hosts register hooks, process lifecycle and stop without sending', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'square-opencode-plugin-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const version of ['2.0.20', '2.8.3']) {
    const h = host(version, directory);
    const unload = await plugin.setup(h.ctx);
    assert.deepEqual([...h.hooks.keys()], ['prompt', 'context']);
    await h.hooks.get('prompt')({ sessionID: 'no-membership' });
    await h.hooks.get('context')({ sessionID: 'no-membership', messages: [] });
    assert.deepEqual(h.counts(), { subscribed: 1, stopped: 0, sends: 0 });
    await unload();
    assert.deepEqual(h.counts(), { subscribed: 1, stopped: 1, sends: 0 });
  }
});

test('incompatible hosts produce a bounded diagnostic before any registration or send', async t => {
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  const cases = [
    h => { h.ctx.app.version = '1.9.0'; },
    h => { h.ctx.app.version = 'nightly'; },
    h => { h.ctx.session.hook = undefined; },
    h => { h.ctx.session.get = undefined; },
    h => { h.ctx.session.prompt = undefined; },
    h => { h.ctx.event.subscribe = undefined; },
    h => { h.ctx.location.project = undefined; },
  ];
  for (const mutate of cases) {
    const h = host('2.0.20', os.tmpdir());
    mutate(h);
    const unload = await plugin.setup(h.ctx);
    await unload();
    assert.equal(h.hooks.size, 0);
    assert.deepEqual(h.counts(), { subscribed: 0, stopped: 0, sends: 0 });
  }
  assert.equal(warnings.length, cases.length);
  for (const warning of warnings) assert.match(warning, /^Square OpenCode plugin inactive: .{1,80}\.$/);
});
