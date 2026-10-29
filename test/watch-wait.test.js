import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { Square } from '../dist/square-api.js';
import { CLI, ROOT, testEnv, withName } from './square-cli-helpers.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-cli-wait-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'SQUARE.square');
  // The catching CLI presents this body, so the seats are established with it.
  const session = `wait-${path.basename(root)}`;
  const body = `codex:${session}`;
  const square = await Square.build({ path: file, markdown: 'deadline wait', hardCap: null, env: testEnv({}, file) });
  try {
    await square.join('Host', { owner: body });
    await square.join('Bob', { owner: body });
  } finally { await square.close(); }
  const child = spawn(process.execPath, [CLI, ...withName(file, 'Bob', ['catch', '--mention', '--idle', '120ms'])], {
    cwd: ROOT, env: testEnv({ CODEX_THREAD_ID: session, SQUARE_WATCH_QUIET_MS: '120', SQUARE_WATCH_POLL_MS: '10000', SQUARE_WATCH_HEARTBEAT_MS: '100', SQUARE_WATCH_STALE_MS: '2000' }, file),
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
