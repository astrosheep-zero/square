import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { runClaudeHook, runClaudeWatch } from '../dist/claude-hook.js';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { harnessOwner } from '../dist/owner.js';
import { withFileLock } from '../dist/file-lock.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-claude-watch-'));
  const env = { SQUARE_DELIVERY: path.join(root, 'delivery.sqlite') };
  const session = 'native-watcher-session';
  const owner = harnessOwner({ channel: 'claude-code', session });
  const event = (name, fields = {}) => JSON.stringify({ session_id: session, hook_event_name: name, ...fields });
  await runClaudeHook(event('SessionStart'), env);
  await runClaudeHook(event('UserPromptSubmit', { prompt_id: 'first' }), env, () => {});
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  const controller = new AbortController();
  const lock = path.join(root, 'claude-hooks', `${createHash('sha256').update(session).digest('hex')}.watch.lock`);
  t.after(async () => { controller.abort(); process.exitCode = 0; await ledger.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function armed() {
    for (let i = 0; i < 100; i++) {
      if (await fs.stat(lock).catch(() => undefined)) {
        const result = await withFileLock(lock, { retryMs: 10, skipIfBusy: true }, () => true);
        if (!result) return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('native watcher did not acquire its OS lock');
  }
  return { env, owner, event, ledger, controller, armed };
}

test('duplicate Stop callbacks hold no waiting claims and emit only once before next native prompt', async t => {
  const f = await fixture(t);
  const frames = [];
  const watcher = () => runClaudeWatch(f.event('Stop', { prompt_id: 'first', stop_hook_active: true }), f.env,
    f.controller.signal, async frame => { frames.push(frame); });
  const generation = (await f.ledger.session(f.owner)).generation;
  await f.ledger.post({ owner: f.owner, key: 'old-unknown', text: 'never replay uncertain custody' });
  await f.ledger.dispatchHandoff(f.owner, 'old-unknown', { kind: 'claude-async-hook', async send() { return 'unknown'; } },
    { generation, timeoutMs: 1000 });
  const first = watcher();
  await f.armed();
  const second = watcher();
  assert.equal((await f.ledger.handoffs(f.owner, { generation })).length, 1);
  await f.ledger.post({ owner: f.owner, key: 'one', text: 'first full native card' });
  await f.ledger.post({ owner: f.owner, key: 'two', text: 'second full native card' });
  await Promise.all([first, second]);
  assert.equal(frames.length, 1);
  assert.match(frames[0], /first full native card/);
  assert.deepEqual(await f.ledger.receipts(f.owner), []);
  await runClaudeHook(f.event('UserPromptSubmit', { prompt_id: 'second', prompt: frames[0] }), f.env, async () => {});
  assert.deepEqual((await f.ledger.receipts(f.owner)).map(row => row.key).sort(), ['one', 'two']);
});

test('new normal Stop waits through old observer shutdown and exact frame observation can race unknown settlement', async t => {
  const f = await fixture(t);
  const frames = [];
  const old = runClaudeWatch(f.event('Stop', { prompt_id: 'first' }), f.env, f.controller.signal, async frame => { frames.push(frame); });
  await f.armed();
  await runClaudeHook(f.event('UserPromptSubmit', { prompt_id: 'new-native-prompt' }), f.env, async () => {});
  const current = runClaudeWatch(f.event('Stop', { prompt_id: 'new-native-prompt' }), f.env, f.controller.signal, async frame => {
    frames.push(frame);
    // Actual output is being handed to the host while its prompt observation
    // runs before dispatchHandoff's post-effect unknown settlement.
    await runClaudeHook(f.event('UserPromptSubmit', { prompt_id: 'hook-generated-prompt', prompt: frame }), f.env, async () => {});
  });
  await f.ledger.post({ owner: f.owner, key: 'next', text: 'new Stop card' });
  await Promise.all([old, current]);
  assert.equal(frames.length, 1);
  assert.deepEqual((await f.ledger.receipts(f.owner)).map(row => row.key), ['next']);
});
