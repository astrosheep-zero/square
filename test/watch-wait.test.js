import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { createSquareState, writeSquareFile, loadSquare } from '../dist/artifact.js';
import { createFileCell } from '../dist/square-storage.js';
import { CLI, ROOT, testEnv, withName } from './square-cli-helpers.js';

async function fixture(t, held = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-cli-wait-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'SQUARE.square');
  const state = await createSquareState({ force: true, hardCap: null }, 'deadline wait');
  state.acts = [{ kind: 'join', actor: 'Host', index: 0, at: 1 }, { kind: 'join', actor: 'Bob', index: 1, at: 2 }];
  if (held) state.acts.push({ kind: 'hold', actor: 'Host', index: 2, at: 3, body: 'pause' });
  state.runtime.nextActIndex = state.acts.length;
  await writeSquareFile(file, state);
  const child = spawn(process.execPath, [CLI, ...withName(file, 'Bob', ['catch', '--mention', '--idle', '120ms'])], {
    cwd: ROOT, env: testEnv({ SQUARE_WATCH_QUIET_MS: '120', SQUARE_WATCH_POLL_MS: '10000', SQUARE_WATCH_HEARTBEAT_MS: '100', SQUARE_WATCH_STALE_MS: '2000' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve({ code, output })); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await finished; });
  return { file, child, finished };
}

async function bounded(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 5_000); })]); }
  finally { clearTimeout(timer); }
}

test('CLI quiet deadline is independent of the obsolete ten-second poll interval', async (t) => {
  const item = await fixture(t);
  const result = await bounded(item.finished, 'quiet catch still depended on the old polling timer');
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /quiet|footsteps|dust/i);
});

test('CLI hold keeps its lease alive, pauses quiet expiry, then wakes on resume and activity', async (t) => {
  const item = await fixture(t, true);
  await bounded((async () => {
    let firstHeartbeat;
    for (;;) {
      const lease = (await loadSquare(item.file)).runtime.leases.Bob;
      if (lease) {
        firstHeartbeat ??= lease.heartbeatAt;
        if (lease.heartbeatAt - firstHeartbeat >= 200) return;
      }
      assert.equal(item.child.exitCode, null, 'held catch exited before resume');
      await sleep(20);
    }
  })(), 'held catch did not renew its lease');
  const cell = createFileCell(item.file);
  try {
    await cell.transact((state) => {
      state.acts.push({ kind: 'resume', actor: 'Host', at: Date.now(), index: state.runtime.nextActIndex++ });
      state.acts.push({ kind: 'say', actor: 'Host', at: Date.now(), index: state.runtime.nextActIndex++, mentions: ['Bob'], body: 'activity after resume' });
      return { state, result: undefined };
    });
  } finally { await cell.close(); }
  const result = await bounded(item.finished, 'catch did not wake for resumed activity');
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /activity after resume/);
  assert.equal((await loadSquare(item.file)).runtime.leases.Bob, undefined);
});
