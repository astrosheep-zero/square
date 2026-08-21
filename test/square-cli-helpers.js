import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

import { Square } from '../dist/index.js';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const CLI = path.join(ROOT, 'dist', 'square.js');
export const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'square-cli-state-'));
export const TEST_REGISTRY = path.join(TEST_STATE, 'sessions.ndjsonl');
export const TEST_PRESENTED = path.join(TEST_STATE, 'presented.ndjsonl');

test.after(() => fs.rmSync(TEST_STATE, { recursive: true, force: true }));

let envSeq = 0;

export function testEnv(overrides = {}) {
  const id = `${process.pid}-${envSeq += 1}`;
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    CLAUDE_CODE_SESSION_ID: '',
    CLAUDE_CODE_CHILD_SESSION: '',
    CODEX_THREAD_ID: '',
    OPENCODE_SESSION_ID: '',
    SQUARE_PI_SESSION_ID: '',
    PASEO_AGENT_ID: '',
    SQUARE_REGISTRY: path.join(TEST_STATE, `sessions-${id}.ndjsonl`),
    SQUARE_PRESENTED: path.join(TEST_STATE, `presented-${id}.ndjsonl`),
    SQUARE_SLEEP_MS: '1',
    SQUARE_STALE_MS: '2',
    SQUARE_WATCH_HEARTBEAT_MS: '60000',
    SQUARE_WATCH_STALE_MS: '180000',
    SQUARE_NOTIFY_DELIVERY_WAIT_MS: '1',
    SQUARE_DISABLE_PASEO_WAKE: '1',
    ...overrides,
  };
  delete env.FORCE_COLOR;
  env.NO_COLOR = '1';
  return env;
}

export function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? ROOT,
    input: opts.input,
    encoding: 'utf8',
    env: testEnv(opts.env),
  });
}

export function runAsync(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd ?? ROOT,
      env: testEnv(opts.env),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export function tempSquare() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-cli-v2-'));
  return path.join(dir, 'SQUARE.square');
}

export function withPath(file, args = []) {
  return ['--location', file, ...args];
}

export function withName(file, name, args = []) {
  return withPath(file, ['--as', name, ...args]);
}

export function tickingClock(start = 0, step = 1000) {
  let at = start;
  return {
    now: () => at,
    tick() {
      at += step;
      return at;
    },
    set(value) {
      at = value;
      return at;
    },
  };
}

export async function persistSquare(fill, options = {}) {
  const file = tempSquare();
  const time = tickingClock(options.start ?? 0);
  const square = await Square.build({
    path: file,
    markdown: options.markdown ?? '## Topic\n\nTesting v2',
    hardCap: 'hardCap' in options ? options.hardCap : 3,
    ...(options.throttlePerMinute === undefined ? {} : { throttlePerMinute: options.throttlePerMinute }),
    clock: options.manualClock ? time.now : time.tick,
  });
  try {
    await fill({ square, time, file });
  } finally {
    await square.close();
  }
  return file;
}

export function build(file, extraArgs = []) {
  return run(['build', '--location', file, '--cap', '3', '--force', ...extraArgs], {
    input: '## Topic\n\nTesting v2\n',
  });
}

export function draftPathFrom(output) {
  const match = output.match(/draft kept: (.+)/);
  assert.ok(match, output);
  return match[1].trim();
}

export function assertDraftRecovery(result, file, name, body, command) {
  assert.equal(result.status, 1, result.stderr);
  const draftPath = draftPathFrom(result.stdout + result.stderr);
  assert.equal(fs.readFileSync(draftPath, 'utf8'), body);
  assert.match(result.stdout + result.stderr, new RegExp(`» square --location '${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' --as '${name}' ${command}`));
  assert.match(result.stdout + result.stderr, new RegExp(`< '${draftPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
}
