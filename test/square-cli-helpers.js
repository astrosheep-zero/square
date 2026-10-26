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

test.after(() => fs.rmSync(TEST_STATE, { recursive: true, force: true }));

let envSeq = 0;

const harnessCoordinates = [
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_THREAD_ID',
  'OPENCODE_SESSION_ID',
  'PI_SESSION_ID',
  'PASEO_AGENT_ID',
];

function cliEnvOverrides(args, overrides = {}) {
  const squareIndex = args.findIndex((value) => value === '--location');
  const squarePath = squareIndex >= 0 ? args[squareIndex + 1] : undefined;
  const hasCoordinate = harnessCoordinates.some((variable) => Object.hasOwn(overrides, variable));
  return {
    ...(squarePath === undefined ? {} : hasCoordinate
      ? Object.hasOwn(overrides, 'CODEX_THREAD_ID') ? {} : { CODEX_THREAD_ID: '' }
      : { CODEX_THREAD_ID: path.resolve(squarePath) }),
    ...overrides,
  };
}

export function testEnv(overrides = {}, squarePath) {
  const id = `${process.pid}-${envSeq += 1}`;
  const square = squarePath === undefined ? undefined : path.resolve(squarePath);
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    CLAUDE_CODE_SESSION_ID: '',
    CLAUDE_CODE_CHILD_SESSION: '',
    CODEX_THREAD_ID: 'test-cli-session',
    OPENCODE_SESSION_ID: '',
    PI_SESSION_ID: '',
    PASEO_AGENT_ID: '',
    SQUARE_INDEX: square === undefined ? path.join(TEST_STATE, `index-${id}.ndjsonl`) : `${square}.index.ndjsonl`,
    SQUARE_CODEX_BOUNDARIES: path.join(TEST_STATE, `codex-boundaries-${id}.json`),
    SQUARE_WATCH_POLL_MS: '1',
    SQUARE_WATCH_QUIET_MS: '2',
    SQUARE_WATCH_HEARTBEAT_MS: '60000',
    SQUARE_WATCH_STALE_MS: '180000',
    SQUARE_NOTIFY_DELIVERY_WAIT_MS: '1',
    SQUARE_DISABLE_PASEO_WAKE: '1',
    ...overrides,
  };
  delete env.SQUARE_HOST_LEDGER_ROOT;
  delete env.FORCE_COLOR;
  env.NO_COLOR = '1';
  return env;
}

export function run(args, opts = {}) {
  const squareIndex = args.findIndex((value) => value === '--location');
  const squarePath = squareIndex >= 0 ? args[squareIndex + 1] : undefined;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? ROOT,
    input: opts.input,
    encoding: 'utf8',
    env: testEnv(cliEnvOverrides(args, opts.env), squarePath),
  });
}

export function runAsync(args, opts = {}) {
  return new Promise((resolve) => {
    const squareIndex = args.findIndex((value) => value === '--location');
    const squarePath = squareIndex >= 0 ? args[squareIndex + 1] : undefined;
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd ?? ROOT,
      env: testEnv(cliEnvOverrides(args, opts.env), squarePath),
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

const tempSquareDirs = new Set();
let tempSquareCleanupRegistered = false;

export function tempSquare() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-cli-v2-'));
  tempSquareDirs.add(dir);
  if (!tempSquareCleanupRegistered) {
    tempSquareCleanupRegistered = true;
    process.on('exit', () => {
      for (const leftover of tempSquareDirs) {
        try { fs.rmSync(leftover, { recursive: true, force: true }); } catch { /* a still-open handle may resist removal */ }
      }
    });
  }
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
    body: options.body ?? { channel: 'codex', session: path.resolve(file) },
    env: testEnv({ CODEX_THREAD_ID: path.resolve(file) }, file),
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
  assert.match(result.stdout + result.stderr, new RegExp(`square --location '${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' --as '${name}' ${command}`));
  assert.match(result.stdout + result.stderr, new RegExp(`< '${draftPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
}
