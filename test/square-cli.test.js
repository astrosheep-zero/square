import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { decodeArchive, loadArchive, loadSquare } from '../dist/artifact.js';
import { formatActivityId } from '../dist/square-core.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist', 'square.js');
const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'square-cli-state-'));
const TEST_REGISTRY = path.join(TEST_STATE, 'sessions.ndjsonl');
const TEST_PRESENTED = path.join(TEST_STATE, 'presented.ndjsonl');

test.after(() => fs.rmSync(TEST_STATE, { recursive: true, force: true }));

function testEnv(overrides = {}) {
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    CLAUDE_CODE_SESSION_ID: '',
    CLAUDE_CODE_CHILD_SESSION: '',
    CODEX_THREAD_ID: '',
    OPENCODE_SESSION_ID: '',
    SQUARE_PI_SESSION_ID: '',
    PASEO_AGENT_ID: '',
    SQUARE_REGISTRY: TEST_REGISTRY,
    SQUARE_PRESENTED: TEST_PRESENTED,
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

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? ROOT,
    input: opts.input,
    encoding: 'utf8',
    env: testEnv(opts.env),
  });
}

function tempSquare() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-cli-v2-'));
  return path.join(dir, 'SQUARE.square');
}

function withPath(file, args = []) {
  return ['--location', file, ...args];
}

function withName(file, name, args = []) {
  return withPath(file, ['--as', name, ...args]);
}

function build(file, extraArgs = []) {
  const result = run(['build', '--location', file, '--cap', '3', '--force', ...extraArgs], {
    input: '## Topic\n\nTesting v2\n',
  });
  return result;
}

test('CLI test runner isolates host delivery identities', () => {
  const previous = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = 'outer-codex-task';
  const file = tempSquare();
  try {
    assert.equal(build(file).status, 0);
    const joined = run(withName(file, 'Alice', ['join']));
    assert.equal(joined.status, 0, joined.stderr);
    assert.match(joined.stdout, /no session delivery detected/);
    const registry = fs.existsSync(TEST_REGISTRY) ? fs.readFileSync(TEST_REGISTRY, 'utf8') : '';
    assert.doesNotMatch(registry, /outer-codex-task/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previous;
  }
});

function draftPathFrom(output) {
  const match = output.match(/draft kept: (.+)/);
  assert.ok(match, output);
  return match[1].trim();
}

function assertDraftRecovery(result, file, name, body, command) {
  assert.equal(result.status, 1, result.stderr);
  const draftPath = draftPathFrom(result.stdout + result.stderr);
  assert.equal(fs.readFileSync(draftPath, 'utf8'), body);
  assert.match(result.stdout + result.stderr, new RegExp(`» square --location '${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' --as '${name}' ${command}`));
  assert.match(result.stdout + result.stderr, new RegExp(`< '${draftPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
}

function runtimeState(file) {
  return loadSquare(file).runtime;
}

test('install and uninstall manage an explicit OpenCode target', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-opencode-install-'));
  const config = path.join(home, 'xdg');
  try {
    const result = run(['install', 'opencode'], {
      env: { HOME: home, XDG_CONFIG_HOME: config },
    });
    assert.equal(result.status, 0, result.stderr);
    const plugin = path.join(config, 'opencode', 'plugins', 'square.js');
    assert.equal(fs.realpathSync(plugin), path.join(ROOT, 'extensions', 'square-opencode.js'));

    const removed = run(['uninstall', 'opencode'], {
      env: { HOME: home, XDG_CONFIG_HOME: config },
    });
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.existsSync(plugin), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('standalone skills install target is removed; skills ship with plugins', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-removed-skills-'));
  try {
    const result = run(['install', 'skills'], { env: { HOME: home } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown install target: skills/);

    const uninstall = run(['uninstall', 'skills'], { env: { HOME: home } });
    assert.notEqual(uninstall.status, 0);
    assert.match(uninstall.stderr, /Unknown uninstall target: skills/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('delivery harness doctor skips a missing or unreadable square path', () => {
  const missing = path.join(os.tmpdir(), `square-missing-${process.pid}-${Date.now()}.square`);
  const result = run(withPath(missing, ['harness', 'doctor', 'delivery']));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /delivery health skipped/);
});

test('every public subcommand exposes scoped help without a square', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-help-'));
  const commands = [
    'help',
    'version',
    'build',
    'ls',
    'list',
    'join',
    'express',
    'catch',
    'done',
    'stream',
    'inbox',
    'claude-hook',
    'codex-hook',
    'history',
    'status',
    'participants',
    'hold',
    'resume',
    'install',
    'uninstall',
    'harness',
    'compact',
    'doctor',
  ];

  for (const command of commands) {
    const result = run([command, '--help'], { cwd });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.match(result.stdout, /^Usage: square /, command);
    assert.match(result.stdout, /-h, --help\s+Show this command help\./, command);
    assert.doesNotMatch(result.stdout, /The loop:/, command);
    assert.equal(result.stderr, '', command);
  }

  const index = run(['help'], { cwd });
  for (const internal of ['stream', 'inbox', 'claude-hook', 'codex-hook']) {
    assert.doesNotMatch(index.stdout, new RegExp(`^  ${internal}$`, 'm'));
  }
  assert.match(index.stdout, /^In the square:$/m);
  assert.match(index.stdout, /^Prepare and manage:$/m);
  assert.match(index.stdout, /^Setup:$/m);
  assert.match(index.stdout, /^  list$/m);
  assert.doesNotMatch(index.stdout, /^  ls,/m);

  const missingSquare = path.join(cwd, 'missing.square');
  const withGlobals = run(['--as', 'Alice', '--location', missingSquare, 'catch', '-h'], { cwd });
  assert.equal(withGlobals.status, 0, withGlobals.stderr);
  assert.match(withGlobals.stdout, /Usage: square \[--location <square>\] --as <name> catch/);

  const retiredLocationFlag = run(['--square-path', missingSquare, 'catch', '--help'], { cwd });
  assert.equal(retiredLocationFlag.status, 2);
  assert.match(retiredLocationFlag.stderr, /unknown command: --square-path/);
});

test('help command resolves aliases and rejects unknown commands', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-help-alias-'));
  const direct = run(['history', '--help'], { cwd });
  const named = run(['help', 'history'], { cwd });
  assert.equal(named.status, 0, named.stderr);
  assert.equal(named.stdout, direct.stdout);

  const alias = run(['help', 'list'], { cwd });
  assert.equal(alias.status, 0, alias.stderr);
  assert.match(alias.stdout, /^Usage: square list \[--depth N\]$/m);
  assert.match(alias.stdout, /^Aliases: ls$/m);

  const unknown = run(['help', 'missing-command'], { cwd });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command: missing-command/);
  assert.match(unknown.stderr, /square help/);

  for (const removed of ['act', 'echo']) {
    const legacy = run(['help', removed], { cwd });
    assert.equal(legacy.status, 2);
    assert.match(legacy.stderr, new RegExp(`unknown command: ${removed}`));
    assert.doesNotMatch(legacy.stderr, /did you mean/i);

    const invocation = run([removed], { cwd });
    assert.equal(invocation.status, 2);
    assert.match(invocation.stderr, new RegExp(`unknown command: ${removed}`));
    assert.doesNotMatch(invocation.stderr, /did you mean/i);
  }
});

test('build writes one SQUARE01 snapshot with no sidecar or Markdown markers', () => {
  const file = tempSquare();
  const result = build(file);
  assert.equal(result.status, 0, result.stderr);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(0, 8).toString('ascii'), 'SQUARE01');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name !== path.basename(file) && !name.endsWith('.lock')), []);
  const squareState = loadSquare(file);
  assert.equal(squareState.hardCap, 3);
  assert.deepEqual(squareState.preamble, ['## Topic', '', 'Testing v2']);
  assert.deepEqual(squareState.acts, []);
  const runtime = runtimeState(file);
  assert.equal('version' in runtime, false);
  assert.equal(runtime.nextActIndex, 0);
});

test('build rejects removed --participants flag', () => {
  const file = tempSquare();
  const result = build(file, ['--participants', 'Alice']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown build option: --participants/);
});

test('build defaults to unlimited, accepts its explicit spelling, and rejects the removed -1 sentinel', () => {
  const defaulted = tempSquare();
  const withoutCap = run(['--location', defaulted, 'build'], { input: 'default unlimited\n' });
  assert.equal(withoutCap.status, 0, withoutCap.stderr);
  assert.equal(loadSquare(defaulted).hardCap, null);

  const unlimited = tempSquare();
  const accepted = run(['--location', unlimited, 'build', '--cap', 'unlimited'], { input: 'unlimited\n' });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(loadSquare(unlimited).hardCap, null);

  const removed = run(['--location', tempSquare(), 'build', '--cap', '-1'], { input: 'removed\n' });
  assert.notEqual(removed.status, 0);
  assert.match(removed.stderr, /positive integer or unlimited/);
});

test('CLI flags override Square location and participant environment values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-env-precedence-'));
  const configured = path.join(root, 'configured.square');
  const explicit = path.join(root, 'explicit.square');
  const built = run(['--location', explicit, 'build'], {
    env: { SQUARE_LOCATION: configured },
    input: 'precedence\n',
  });
  assert.equal(built.status, 0, built.stderr);
  assert.equal(fs.existsSync(explicit), true);
  assert.equal(fs.existsSync(configured), false);

  const joined = run(['--location', explicit, '--as', 'Explicit', 'join'], {
    env: { SQUARE_LOCATION: configured, SQUARE_PARTICIPANT_NAME: 'Configured' },
  });
  assert.equal(joined.status, 0, joined.stderr);
  assert.deepEqual(loadSquare(explicit).acts.map((act) => act.actor), ['Explicit']);
});

test('unknown participant can join and roster derives from join acts', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  const joined = run(withName(file, 'Alice', ['join']));
  assert.equal(joined.status, 0, joined.stderr);
  const squareState = loadSquare(file);
  assert.deepEqual(squareState.acts.map((act) => act.kind), ['join']);
  assert.equal(squareState.acts[0].actor, 'Alice');
});

test('join and catch only show fallback catch hints without automatic session delivery', () => {
  const file = tempSquare();
  const registry = `${file}.sessions.ndjsonl`;
  const noDelivery = {
    SQUARE_REGISTRY: registry,
    CLAUDE_CODE_SESSION_ID: '',
    CODEX_THREAD_ID: '',
    OPENCODE_SESSION_ID: '',
    SQUARE_PI_SESSION_ID: '',
    PASEO_AGENT_ID: '',
  };
  const codexDelivery = { ...noDelivery, CODEX_THREAD_ID: 'codex-bob' };

  assert.equal(build(file).status, 0);

  const aliceJoin = run(withName(file, 'Alice', ['join']), { env: noDelivery });
  assert.equal(aliceJoin.status, 0, aliceJoin.stderr);
  assert.match(aliceJoin.stdout, /catch --idle 30m/);
  assert.match(aliceJoin.stdout, /no session delivery detected/);

  const bobJoin = run(withName(file, 'Bob', ['join']), { env: codexDelivery });
  assert.equal(bobJoin.status, 0, bobJoin.stderr);
  assert.doesNotMatch(bobJoin.stdout, /catch --/);

  assert.equal(run(withName(file, 'Bob', ['express', '--force', 'hello Alice @Alice']), { env: codexDelivery }).status, 0);
  const aliceCatch = run(withName(file, 'Alice', ['catch', '--now']), { env: noDelivery });
  assert.equal(aliceCatch.status, 0, aliceCatch.stderr);
  assert.match(aliceCatch.stdout, /hello Alice/);
  assert.match(aliceCatch.stdout, /catch --idle 30m/);
  assert.match(aliceCatch.stdout, /stay available for new activity/);
  const aliceQuiet = run(withName(file, 'Alice', ['catch', '--now']), { env: noDelivery });
  assert.match(aliceQuiet.stdout, /only footsteps/);
  assert.match(aliceQuiet.stdout, /catch --idle 30m/);

  assert.equal(run(withName(file, 'Alice', ['express', '--force', 'hello Bob @Bob']), { env: noDelivery }).status, 0);
  const bobCatch = run(withName(file, 'Bob', ['catch', '--now']), { env: codexDelivery });
  assert.equal(bobCatch.status, 0, bobCatch.stderr);
  assert.match(bobCatch.stdout, /hello Bob/);
  assert.doesNotMatch(bobCatch.stdout, /catch --/);
  const bobQuiet = run(withName(file, 'Bob', ['catch', '--now']), { env: codexDelivery });
  assert.match(bobQuiet.stdout, /only footsteps/);
  assert.doesNotMatch(bobQuiet.stdout, /catch --/);

  const rebound = run(withName(file, 'Bob', ['join']), { env: codexDelivery });
  assert.equal(rebound.status, 0, rebound.stderr);
  assert.match(rebound.stdout, /you are already in the square/);
  assert.doesNotMatch(rebound.stdout, /catch --/);

  const sameName = run(withName(file, 'Bob', ['join']), { env: { ...codexDelivery, CODEX_THREAD_ID: 'codex-other' } });
  assert.equal(sameName.status, 2, sameName.stderr);
  assert.match(sameName.stderr, /Bob shoos you out of the square/);
  assert.match(sameName.stderr, /join --kick/);
  assert.equal(loadSquare(file).acts.filter((act) => act.kind === 'join' && act.actor === 'Bob').length, 1);

  const takeover = run(withName(file, 'Bob', ['join', '--kick']), { env: { ...codexDelivery, CODEX_THREAD_ID: 'codex-other' } });
  assert.equal(takeover.status, 0, takeover.stderr);
  assert.match(takeover.stdout, /you banished the original Bob/);
  assert.doesNotMatch(takeover.stdout, /catch --/);
  assert.equal(loadSquare(file).acts.filter((act) => act.kind === 'join' && act.actor === 'Bob').length, 1);
});

test('hold and resume persist the real actor, never system', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Host', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Host', ['hold', 'pause']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  const held = run(withPath(file, ['status']), { env: { SQUARE_NOW_MS: '62000' } });
  assert.equal(held.status, 0, held.stderr);
  assert.match(held.stdout, /Host raised a hand — pause · 1m/);
  assert.doesNotMatch(held.stdout, /12m/);
  assert.equal(run(withName(file, 'Host', ['resume']), { env: { SQUARE_NOW_MS: '63000' } }).status, 0);
  const squareState = loadSquare(file);
  const hold = squareState.acts.find((act) => act.kind === 'hold');
  const resume = squareState.acts.find((act) => act.kind === 'resume');
  assert.equal(hold?.actor, 'Host');
  assert.equal(resume?.actor, 'Host');
  assert.ok(squareState.acts.every((act) => act.actor !== 'system'));
});

test('status stays compact and focuses on the current square', () => {
  const file = tempSquare();
  const built = run(['build', '--location', file, '--cap', '100', '--force'], { input: '## Topic\\n\\nTesting status\\n' });
  assert.equal(built.status, 0, built.stderr);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  for (let i = 0; i < 12; i++) {
    assert.equal(run(withName(file, 'Alice', ['express', '--force', `activity ${i} @Bob`]), { env: { SQUARE_NOW_MS: String(3000 + i) } }).status, 0);
  }
  assert.equal(run(withName(file, 'Bob', ['done', 'leaving']), { env: { SQUARE_NOW_MS: '20000' } }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--force', 'last activity @Alice']), { env: { SQUARE_NOW_MS: '21000' } }).status, 0);

  const status = run(withName(file, 'Alice', ['status']), { env: { SQUARE_NOW_MS: '22000' } });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /1 active · 1 done · cap 100 · throttle none/);
  assert.match(status.stdout, /Alice · 13 activities/);
  assert.doesNotMatch(status.stdout, /Bob/);
  assert.doesNotMatch(status.stdout, /─/);
});

test('actor cursor advances on any self activity', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join'])).status, 0);
  let squareState = loadSquare(file);
  assert.equal(squareState.runtime.cursors.Alice.consumedThroughIndex, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--force', 'hello @Alice'])).status, 0);
  squareState = loadSquare(file);
  assert.equal(squareState.runtime.cursors.Alice.consumedThroughIndex, 1);
  assert.equal(run(withName(file, 'Alice', ['done', 'bye'])).status, 0);
  squareState = loadSquare(file);
  assert.equal(squareState.runtime.cursors.Alice.consumedThroughIndex, 2);
});

test('express does not surface delivery-health diagnostics during normal use', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--force', 'hey @Bob']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);

  const acted = run(withName(file, 'Bob', ['express', '--force', 'still working @Bob']), {
    env: { SQUARE_NOW_MS: '70000' },
  });
  assert.equal(acted.status, 0, acted.stderr);
  assert.doesNotMatch(acted.stdout + acted.stderr, /delivery|receipt|harness doctor|pending/i);

  const diagnosed = run(withPath(file, ['harness', 'doctor', 'delivery']), {
    env: { SQUARE_NOW_MS: '70000' },
  });
  assert.equal(diagnosed.status, 0, diagnosed.stderr);
  assert.match(diagnosed.stdout, /unreachable: 1/);
});

test('doctor is a dry validator and rejects Markdown bytes', () => {
  const file = tempSquare();
  fs.writeFileSync(file, '---\nhard_cap: 3\n---\n\n## Warmup\nwarmup\n');
  const result = run(withPath(file, ['doctor']));
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout, /unreadable artifact/);
  assert.match(result.stdout, /Invalid square artifact/);
  assert.doesNotMatch(result.stdout + result.stderr, /repaired|quarantine|--fix/);

  const help = run(['doctor', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /--fix/);
});

test('doctor --fix is not a command', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  const result = run(withPath(file, ['doctor', '--fix']));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid arguments for doctor/);
});

test('catch --mention shows only matching say acts and suppresses room changes', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['express', '--force', 'hello @Alice']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  assert.equal(run(withName(file, 'Cara', ['join']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);

  const watched = run(withName(file, 'Alice', ['catch', '--now', '--mention']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(watched.status, 0, watched.stderr);
  assert.match(watched.stdout, /calls your name across the square — @Alice/);
  assert.match(watched.stdout, /Bob\s+#1/);
  assert.doesNotMatch(watched.stdout, /while your back was turned/);
  assert.doesNotMatch(watched.stdout, /Cara stepped into the square/);
});

test('catch --from filters public acts and matching room changes to named peers', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Cara', ['join']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['express', '--force', 'hello from bob @Alice']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);
  assert.equal(run(withName(file, 'Cara', ['express', '--force', 'hello from cara @Alice']), { env: { SQUARE_NOW_MS: '5000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['done', 'bye']), { env: { SQUARE_NOW_MS: '6000' } }).status, 0);

  const watched = run(withName(file, 'Alice', ['catch', '--now', '--from', 'Bob']), { env: { SQUARE_NOW_MS: '7000' } });
  assert.equal(watched.status, 0, watched.stderr);
  assert.match(watched.stdout, /Bob stepped into the square/);
  assert.match(watched.stdout, /Bob\s+#1/);
  assert.match(watched.stdout, /Bob stepped out of the square — done/);
  assert.doesNotMatch(watched.stdout, /Cara stepped into the square/);
  assert.doesNotMatch(watched.stdout, /hello from cara/);

  const removed = run(withName(file, 'Alice', ['catch', '--now', '--by', 'Bob']));
  assert.notEqual(removed.status, 0);
  assert.match(removed.stderr, /✕ catch does not know --by/);
  assert.match(removed.stderr, /» square catch --help\n$/);
});

test('catch catchup treats a rejoined participant as currently in the square', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['catch', '--now']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['done', 'bye']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '5000' } }).status, 0);

  const watched = run(withName(file, 'Alice', ['catch', '--now']), { env: { SQUARE_NOW_MS: '6000' } });
  assert.equal(watched.status, 0, watched.stderr);
  assert.match(watched.stdout, /Bob stepped out of the square/);
  assert.match(watched.stdout, /Bob stepped into the square/);
  assert.doesNotMatch(watched.stdout, /everyone else has left/);
});

test('catch --now around the square excludes the current actor', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Cara', ['join']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);

  // Alice establishes a lease/presence first, then checks quiet catch status.
  assert.equal(run(withName(file, 'Alice', ['catch', '--now']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['catch', '--now']), { env: { SQUARE_NOW_MS: '5000' } }).status, 0);

  const watched = run(withName(file, 'Alice', ['catch', '--now']), { env: { SQUARE_NOW_MS: '6000' } });
  assert.equal(watched.status, 0, watched.stderr);
  assert.match(watched.stdout, /around the square/);
  assert.match(watched.stdout, /Bob/);
  assert.doesNotMatch(watched.stdout, /^\s*[◎●○×]\s+Alice\b/m);
});

test('catch --now with no mention filter includes peer room changes', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Cara', ['join']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);

  const watched = run(withName(file, 'Alice', ['catch', '--now']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.equal(watched.status, 0, watched.stderr);
  assert.match(watched.stdout, /while your back was turned/);
  assert.match(watched.stdout, /Bob stepped into the square/);
  assert.match(watched.stdout, /Cara stepped into the square/);
});

test('catch --now delivers unreceipted mentions behind a self-advanced cursor', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--force', 'question @Bob']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);

  // Bob responds before catching, so Bob's own activity moves the public cursor past Alice's mention.
  assert.equal(run(withName(file, 'Bob', ['express', '--force', 'answer @Alice']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);
  const caught = run(withName(file, 'Bob', ['catch', '--now']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(caught.status, 0, caught.stderr);
  assert.match(caught.stdout, /question @Bob/);

  const again = run(withName(file, 'Bob', ['catch', '--now']), { env: { SQUARE_NOW_MS: '6000' } });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /only footsteps/);
});

test('catch requires one explicit mode and rejects removed modes', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join'])).status, 0);
  for (const args of [
    ['catch'],
    ['catch', '--now', '--idle', '1s'],
    ['catch', '--follow'],
    ['catch', '--count', '2'],
    ['catch', '--force', '--now'],
    ['catch', '--now', '--replace'],
  ]) {
    const result = run(withName(file, 'Alice', args));
    assert.notEqual(result.status, 0, args.join(' '));
  }
  assert.equal(run(withName(file, 'Alice', ['catch', '--now'])).status, 0);
});

test('history --all --full reads the complete archive', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['express', '--force', 'hello @Alice']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['done', 'bye']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);

  const activities = run(withPath(file, ['history', '--all', '--full']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(activities.status, 0, activities.stderr);
  assert.match(activities.stdout, /Bob\s+#1/);
  assert.match(activities.stdout, /hello @Alice/);
  assert.match(activities.stdout, /Bob stepped out of the square — done/);
  assert.doesNotMatch(activities.stdout, /\(No public activity in this view\.\)/);
});

test('history --since excludes older public activity', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['express', '--force', 'hello @Alice']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['done', 'bye']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);

  const activities = run(withName(file, 'Alice', ['history', '--since', '1970-01-01T00:00:03.500Z']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(activities.status, 0, activities.stderr);
  assert.doesNotMatch(activities.stdout, /Bob\s+#1/);
  assert.match(activities.stdout, /Bob stepped out of the square — done/);
});

test('history --from filters to named participants', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Cara', ['join']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['express', '--force', 'hello from bob @Alice']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);
  assert.equal(run(withName(file, 'Cara', ['express', '--force', 'hello from cara @Alice']), { env: { SQUARE_NOW_MS: '5000' } }).status, 0);
  assert.equal(run(withName(file, 'Cara', ['done', 'later']), { env: { SQUARE_NOW_MS: '6000' } }).status, 0);

  const activities = run(withName(file, 'Alice', ['history', '--from', 'Cara']), { env: { SQUARE_NOW_MS: '7000' } });
  assert.equal(activities.status, 0, activities.stderr);
  assert.match(activities.stdout, /Cara\s+#1/);
  assert.match(activities.stdout, /Cara stepped out of the square — done/);
  assert.doesNotMatch(activities.stdout, /hello from bob/);
});

test('history rejects removed filter aliases', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  for (const args of [
    ['history', '--by', 'Alice'],
    ['history', '--last', '1'],
    ['history', '--mentions', 'me'],
    ['history', '--before', '1h'],
  ]) {
    const result = run(withPath(file, args));
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, new RegExp(`history does not know ${args[1]}`));
    assert.match(result.stderr, /» square history --help\n$/);
  }
});

test('history reports unknown options and invalid limits with a next command', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);

  const unknown = run(withPath(file, ['history', '--wat']));
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /✕ history does not know --wat/);
  assert.match(unknown.stderr, /» square history --help\n$/);

  for (const value of ['0', '-1', 'nope']) {
    const invalid = run(withPath(file, ['history', '--limit', value]));
    assert.notEqual(invalid.status, 0, value);
    assert.match(invalid.stderr, /✕ --limit needs a positive number/);
    assert.match(invalid.stderr, /history --limit 30\n$/);
  }
});

test('ambient catch and history show full body to a mention target and presence to others', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Cara', ['join']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--force', 'secret reach phrase @Bob']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);

  const bobWatch = run(withName(file, 'Bob', ['catch', '--now']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(bobWatch.status, 0, bobWatch.stderr);
  assert.match(bobWatch.stdout, /secret reach phrase/);
  assert.match(bobWatch.stdout, /Alice\s+#1/);

  const caraWatch = run(withName(file, 'Cara', ['catch', '--now']), { env: { SQUARE_NOW_MS: '6000' } });
  assert.equal(caraWatch.status, 0, caraWatch.stderr);
  assert.match(caraWatch.stdout, /● Alice #1 · act\/3 · .*\n  talked to @Bob/);
  assert.doesNotMatch(caraWatch.stdout, /secret reach phrase/);

  const ambient = run(withPath(file, ['history', '--all']), { env: { SQUARE_NOW_MS: '7000' } });
  assert.equal(ambient.status, 0, ambient.stderr);
  assert.match(ambient.stdout, /● Alice #1 · act\/3 · .*\n  secret reach phrase @Bob/);
  assert.match(ambient.stdout, /secret reach phrase @Bob/);
  assert.match(ambient.stdout, /→ Alice was here/);

  const archive = run(withPath(file, ['history', '--all', '--full']), { env: { SQUARE_NOW_MS: '8000' } });
  assert.equal(archive.status, 0, archive.stderr);
  assert.match(archive.stdout, /secret reach phrase @Bob/);

  const exact = run(withPath(file, ['history', '--at', formatActivityId(3), '-C', '0']), { env: { SQUARE_NOW_MS: '9000' } });
  assert.equal(exact.status, 0, exact.stderr);
  assert.match(exact.stdout, /secret reach phrase @Bob/);

  const json = run(withPath(file, ['history', '--at', formatActivityId(3), '-C', '0', '--json']), { env: { SQUARE_NOW_MS: '10000' } });
  assert.equal(json.status, 0, json.stderr);
  assert.match(JSON.parse(json.stdout).body, /secret reach phrase/);

  assert.equal(run(withName(file, 'Alice', ['express', '--force', 'two targets @Cara then @bob']), { env: { SQUARE_NOW_MS: '10500' } }).status, 0);
  const laterJoin = run(withName(file, 'Dan', ['join', '--all']), { env: { SQUARE_NOW_MS: '11000' } });
  assert.equal(laterJoin.status, 0, laterJoin.stderr);
  assert.match(laterJoin.stdout, /● Alice #1 · act\/3 · .*\n  talked to @Bob/);
  assert.match(laterJoin.stdout, /● Alice #2 · act\/4 · .*\n  talked to @Cara and @bob/);
  assert.doesNotMatch(laterJoin.stdout, /secret reach phrase/);
  assert.doesNotMatch(laterJoin.stdout, /two targets/);
});

test('history without --as expands the newest ten activities in chronological order', () => {
  const file = tempSquare();
  assert.equal(build(file, ['--cap', 'unlimited']).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  for (let index = 1; index <= 11; index++) {
    const body = `history body ${index} ${'x'.repeat(index === 11 ? 230 : 4)} @Alice`;
    assert.equal(run(withName(file, 'Alice', ['express', '--force', body]), { env: { SQUARE_NOW_MS: String(1000 + index) } }).status, 0);
  }

  const history = run(withPath(file, ['history']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(history.status, 0, history.stderr);
  assert.doesNotMatch(history.stdout, /history body 1 /);
  assert.match(history.stdout, /history body 2 /);
  assert.match(history.stdout, /history body 11 /);
  assert.match(history.stdout, /history body 11 [^\n]*x{20}/);
  assert.ok(history.stdout.indexOf('history body 2 ') < history.stdout.indexOf('history body 11 '));
});

test('blocked unread summary shows directed presence without the body', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Cara', ['join']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--force', 'secret pending phrase @Bob']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);

  const blocked = run(withName(file, 'Cara', ['express', 'cara tries after unread @Alice']), { env: { SQUARE_NOW_MS: '100000' } });
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.doesNotMatch(blocked.stdout, /secret pending phrase/);
  assert.doesNotMatch(blocked.stdout, /secret pending phrase/);
});

test('bell pierces mention filter and second bell within hour is refused with next timestamp', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Cara', ['join']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--force', '--bell', 'bell one']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);

  const mentionWatch = run(withName(file, 'Cara', ['catch', '--now', '--mention']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(mentionWatch.status, 0, mentionWatch.stderr);
  assert.match(mentionWatch.stdout, /bell one/);
  assert.match(mentionWatch.stdout, /Alice\s+#1/);

  const fromWatch = run(withName(file, 'Bob', ['catch', '--now', '--from', 'Cara']), { env: { SQUARE_NOW_MS: '6000' } });
  assert.equal(fromWatch.status, 0, fromWatch.stderr);
  assert.match(fromWatch.stdout, /bell one/);

  const fromHistory = run(withPath(file, ['history', '--from', 'Cara', '--all']));
  assert.equal(fromHistory.status, 0, fromHistory.stderr);
  assert.doesNotMatch(fromHistory.stdout, /bell one/);

  const secondBell = run(withName(file, 'Alice', ['express', '--bell', 'bell two']), { env: { SQUARE_NOW_MS: '7000' } });
  assert.equal(secondBell.status, 1, secondBell.stderr);
  assert.match(secondBell.stdout, /the bell stays quiet for now/);
  assert.match(secondBell.stdout, /you can ring it again at 1970-01-01 09:00:04 \+08:00/);
});

test('mention omits persisted reach while bell persists explicitly', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--force', 'mention @Bob']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['express', '--force', '--bell', 'bell line']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);

  const persisted = loadSquare(file);
  assert.equal(persisted.acts[2].reach, undefined);
  assert.equal(persisted.acts[3].reach, 'bell');
  assert.doesNotMatch(JSON.stringify(persisted), /beside/);

  const removed = run(withName(file, 'Alice', ['express', '--force', '--beside', 'Bob', 'gone @Bob']));
  assert.notEqual(removed.status, 0);
  assert.match(removed.stderr, /express does not know --beside/);
  assert.match(removed.stderr, /» square express --help\n$/);

  const help = run(['express', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /beside/);
  assert.match(help.stdout, /--bell/);
  assert.match(help.stdout, /--reply <activity-id>/);
  assert.match(help.stdout, /act\/12/);
  assert.doesNotMatch(help.stdout, /act\/N/);
});

test('express --reply preserves one causal activity reference', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--force', 'question @Bob']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);

  const replied = run(withName(file, 'Bob', ['express', '--force', '--reply', formatActivityId(2), 'answer @Alice']), {
    env: { SQUARE_NOW_MS: '4000' },
  });
  assert.equal(replied.status, 0, replied.stderr);
  assert.equal(loadSquare(file).acts.at(-1).reply, 2);

  const history = run(withPath(file, ['history', '--at', formatActivityId(3), '-C', '0', '--full']));
  assert.equal(history.status, 0, history.stderr);
  assert.match(history.stdout, /act\/3.*replies to act\/2/);

  const json = run(withPath(file, ['history', '--at', formatActivityId(3), '-C', '0', '--json']));
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).reply, formatActivityId(2));

  const missing = run(withName(file, 'Bob', ['express', '--force', '--reply', formatActivityId(99), 'orphan @Alice']));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Unknown reply activity: act\/99/);
});

test('CLI activity selectors accept only canonical textual ids', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--force', '--bell', 'anchor']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);

  const underscore = ['act', '1'].join('_');
  for (const [flag, args] of [
    ['--reply', withName(file, 'Alice', ['express', '--force', '--reply', underscore, 'later @Alice'])],
    ['--at', withPath(file, ['history', '--at', underscore])],
    ['--after', withPath(file, ['history', '--after', underscore])],
    ['--reply', withName(file, 'Alice', ['express', '--force', '--reply', '1', 'later @Alice'])],
    ['--at', withPath(file, ['history', '--at', '1'])],
    ['--reply', withName(file, 'Alice', ['express', '--force', '--reply', ` ${formatActivityId(1)} `, 'later @Alice'])],
    ['--at', withPath(file, ['history', '--at', ` ${formatActivityId(1)} `])],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, new RegExp(`Invalid ${flag}: expected an activity id like act/12`));
  }
});

test('history --at accepts multiple coordinates and unions their context windows', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--force', 'first @Bob']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['express', '--force', 'second @Alice']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);

  const comma = run(withPath(file, ['history', '--at', 'act/2,act/3', '-C', '0', '--json']));
  assert.equal(comma.status, 0, comma.stderr);
  assert.deepEqual(comma.stdout.trim().split('\n').map((line) => JSON.parse(line).id), ['act/2', 'act/3']);

  const repeated = run(withPath(file, ['history', '--at', 'act/2', '--at', 'act/3', '-C', '0', '--json']));
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(repeated.stdout.trim().split('\n').map((line) => JSON.parse(line).id), ['act/2', 'act/3']);
});

test('compact archives older activities into a SQARCH01 file and preserves stable indexes', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['express', '--force', 'hello @Alice']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['catch', '--now']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);

  const compacted = run(withPath(file, ['compact', '--keep', '1']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(compacted.status, 0, compacted.stderr);
  assert.match(compacted.stdout, /archived 2 activities/);
  assert.match(compacted.stdout, /kept\s+1 activities/);

  const squareState = loadSquare(file);
  assert.deepEqual(squareState.acts.map((act) => [act.kind, act.actor]), [['say', 'Bob']]);
  assert.equal(squareState.acts[0].index, 2);

  const archivePath = file.replace(/\.square$/, '.archive.square');
  const archiveBytes = fs.readFileSync(archivePath);
  assert.equal(archiveBytes.subarray(0, 8).toString('ascii'), 'SQARCH01');
  const archived = loadArchive(archivePath);
  assert.deepEqual(archived.map((act) => [act.index, act.kind, act.actor]), [
    [0, 'join', 'Alice'],
    [1, 'join', 'Bob'],
  ]);
  assert.equal(archived[0].at, 1000);
  assert.equal(archived[1].at, 2000);
  assert.doesNotMatch(JSON.stringify(decodeArchive(archiveBytes)), /evt_/);
});

test('inbox stays read-only while codex admits pending attention once at a boundary', () => {
  const file = tempSquare();
  const root = path.dirname(file);
  const registry = path.join(root, 'sessions.ndjsonl');
  const presented = path.join(root, 'presented.ndjsonl');
  const env = { SQUARE_REGISTRY: registry, SQUARE_PRESENTED: presented };
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--force', 'hey @Bob']), { env }).status, 0);

  const register = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { recordJoin } from ${JSON.stringify(path.join(ROOT, 'dist/registry.js'))};
    recordJoin('sid-cli', 'Bob', ${JSON.stringify(file)}, { channel: 'codex' });
  `], { encoding: 'utf8', env: testEnv(env) });
  assert.equal(register.status, 0, register.stderr);

  const inspected1 = run(['inbox', '--for-session', 'sid-cli', '--json'], { env });
  assert.equal(inspected1.status, 0, inspected1.stderr);
  const pendingInbox = JSON.parse(inspected1.stdout);
  assert.equal(pendingInbox.length, 1);
  assert.equal(pendingInbox[0].notifications.length, 1);

  const inspected2 = run(['inbox', '--for-session', 'sid-cli', '--json'], { env });
  assert.equal(inspected2.status, 0, inspected2.stderr);
  assert.deepEqual(JSON.parse(inspected2.stdout), pendingInbox);

  const inject = spawnSync(process.execPath, [CLI, 'codex-hook'], {
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'sid-cli', hook_event_name: 'PostToolUse' }),
    env: testEnv(env),
  });
  assert.equal(inject.status, 0, inject.stderr);
  assert.match(inject.stdout, /"hookEventName":"PostToolUse"/);

  const duplicate = spawnSync(process.execPath, [CLI, 'codex-hook'], {
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'sid-cli', hook_event_name: 'PostToolUse' }),
    env: testEnv(env),
  });
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.equal(duplicate.stdout, '');

});

test('history power filters and jsonl stay read-only', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['express', '--force', 'deploy failed on schema v3 @Alice']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--force', 'hello @Bob please check']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);

  const grepped = run(withPath(file, ['history', '--grep', 'schema v3', '--json']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(grepped.status, 0, grepped.stderr);
  const row = JSON.parse(grepped.stdout.trim().split('\n').at(-1));
  assert.match(row.id, /^act\//);
  assert.match(row.body, /schema v3/);

  const centerOnly = run(withPath(file, ['history', '--at', formatActivityId(3), '-C', '0', '--full']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(centerOnly.status, 0, centerOnly.stderr);
  assert.match(centerOnly.stdout, /hello @Bob please check/);
  assert.doesNotMatch(centerOnly.stdout, /deploy failed on schema v3/);

  const pending = run(withName(file, 'Bob', ['history', '--pending', '--json']), { env: { SQUARE_NOW_MS: '6000' } });
  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(pending.stdout.trim().split('\n').filter(Boolean).length, 1);

  // Pending history reads must not mark activity as presented.
  const still = run(withName(file, 'Bob', ['history', '--pending', '--json']), { env: { SQUARE_NOW_MS: '7000' } });
  assert.equal(still.stdout.trim().split('\n').filter(Boolean).length, 1);

  const caught = run(withName(file, 'Bob', ['catch', '--now']), { env: { SQUARE_NOW_MS: '8000' } });
  assert.equal(caught.status, 0, caught.stderr);
  assert.match(caught.stdout, /hello @Bob/);

  const after = run(withName(file, 'Bob', ['history', '--pending', '--json']), { env: { SQUARE_NOW_MS: '9000' } });
  assert.equal(after.stdout, '');
});

test('history grep searches ids, participant names, and bodies', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--force', 'first inventory @Bob']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['express', '--force', 'facts only @Alice']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);

  const byId = run(withPath(file, ['history', '--grep', `^${formatActivityId(2)}$`, '--json']));
  assert.equal(byId.status, 0, byId.stderr);
  assert.equal(JSON.parse(byId.stdout).body, 'first inventory @Bob');

  const byParticipant = run(withPath(file, ['history', '--grep', '^Bob$', '--json']));
  assert.equal(byParticipant.status, 0, byParticipant.stderr);
  assert.equal(JSON.parse(byParticipant.stdout).body, 'facts only @Alice');

  const acrossFields = run(withPath(file, ['history', '--grep', `${formatActivityId(2)}|facts only`, '--limit', '2', '--json']));
  assert.equal(acrossFields.status, 0, acrossFields.stderr);
  assert.deepEqual(acrossFields.stdout.trim().split('\n').map((line) => JSON.parse(line).id), [formatActivityId(2), formatActivityId(3)]);

  const compactId = run(withPath(file, ['history', '--grep', `^${formatActivityId(2)}$`]));
  assert.equal(compactId.status, 0, compactId.stderr);
  assert.match(compactId.stdout, /act\/2 · Alice/);
  assert.match(compactId.stdout, /first inventory/);
});

test('history grep defaults to a compact character-bounded search view', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  const body = `needle ${'🙂'.repeat(250)}TAIL @Alice`;
  assert.equal(run(withName(file, 'Alice', ['express', '--force', body]), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);

  const compact = run(withPath(file, ['history', '--grep', 'needle']), { env: { SQUARE_NOW_MS: '3000' } });
  assert.equal(compact.status, 0, compact.stderr);
  assert.match(compact.stdout, /\b1 match\b/);
  assert.match(compact.stdout, /act\/\d+ · Alice ·/);
  assert.match(compact.stdout, /needle/);
  assert.match(compact.stdout, /· 0 chars before · \d+ chars after/);
  assert.doesNotMatch(compact.stdout, /TAIL/);
  assert.doesNotMatch(compact.stdout, /�/);
  assert.doesNotMatch(compact.stdout, /footprints/);
  assert.match(compact.stdout, /history --at act\/\d+ -C 2 --full/);

  const full = run(withPath(file, ['history', '--grep', 'needle', '--full']), { env: { SQUARE_NOW_MS: '3000' } });
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /TAIL/);
  assert.doesNotMatch(full.stdout, /chars after/);
});

test('history grep centers snippets on late, multiline, and fixed matches', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  const late = `START-${'x'.repeat(260)}-schema\nv3-${'y'.repeat(260)}-END @Alice`;
  assert.equal(run(withName(file, 'Alice', ['express', '--force', late]), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--force', 'literal [ bracket @Alice']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);

  const centered = run(withPath(file, ['history', '--grep', 'schema\\s+v3']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.equal(centered.status, 0, centered.stderr);
  assert.match(centered.stdout, /schema v3/);
  assert.match(centered.stdout, /· \d+ chars before · \d+ chars after/);
  assert.doesNotMatch(centered.stdout, /START-/);
  assert.doesNotMatch(centered.stdout, /-END/);

  const invalid = run(withPath(file, ['history', '--grep', '[']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid --grep regex/);

  const literal = run(withPath(file, ['history', '--fixed', '[']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.equal(literal.status, 0, literal.stderr);
  assert.match(literal.stdout, /literal \[ bracket/);
});

test('history search reports shown and total matches consistently', () => {
  const file = tempSquare();
  assert.equal(build(file, ['--cap', 'unlimited']).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  for (let i = 0; i < 12; i++) {
    assert.equal(run(withName(file, 'Alice', ['express', '--force', `needle ${i} @Alice`]), { env: { SQUARE_NOW_MS: String(2000 + i) } }).status, 0);
  }
  const human = run(withPath(file, ['history', '--grep', 'needle']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /10 of 12 matches/);
  assert.equal(run(withPath(file, ['history', '--grep', 'needle', '--json'])).stdout.trim().split('\n').length, 10);

  const limited = run(withPath(file, ['history', '--grep', 'needle', '--limit', '3', '--json']));
  assert.equal(limited.status, 0, limited.stderr);
  const limitedRows = limited.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(limitedRows.map((row) => row.body), ['needle 9 @Alice', 'needle 10 @Alice', 'needle 11 @Alice']);

  const descending = run(withPath(file, ['history', '--grep', 'needle', '--limit', '3', '--order', 'desc', '--json']));
  assert.equal(descending.status, 0, descending.stderr);
  assert.deepEqual(descending.stdout.trim().split('\n').map((line) => JSON.parse(line).body), ['needle 11 @Alice', 'needle 10 @Alice', 'needle 9 @Alice']);
});

test('manual participant writes require an explicit location', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-ambiguous-'));
  const first = path.join(cwd, '.square', 'first.square');
  const second = path.join(cwd, '.square', 'second.square');
  fs.mkdirSync(path.dirname(first), { recursive: true });
  assert.equal(run(['--location', first, 'build', '--cap', 'unlimited', '--force'], { cwd, input: 'first' }).status, 0);
  assert.equal(run(['--location', second, 'build', '--cap', 'unlimited', '--force'], { cwd, input: 'second' }).status, 0);
  const refused = run(['--as', 'Alice', 'express', '--force', 'ambiguous'], { cwd });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /needs a square location/);
  assert.match(refused.stderr, /» square ls\n$/);
  const readOnly = run(['status'], { cwd });
  assert.notEqual(readOnly.status, 0);
  const doctor = run(['doctor'], { cwd });
  assert.notEqual(doctor.status, 0);
  const doctorFix = run(['doctor', '--fix'], { cwd });
  assert.notEqual(doctorFix.status, 0);
  assert.match(doctorFix.stderr, /invalid arguments for doctor/);
});

test('history grep describes an empty result precisely', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  const result = run(withPath(file, ['history', '--grep', 'missing.*term']));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /○ no activity matched 'missing\.\*term'/);
  assert.doesNotMatch(result.stdout, /no public activity in this view/);
});

test('status shows attention state and stable activity ids', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--force', 'please check @Bob']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);

  const waiting = run(withPath(file, ['status']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.match(waiting.stdout, /Alice.*caught up/);
  assert.match(waiting.stdout, /Bob.*1 mention waiting/);
  assert.match(waiting.stdout, /● Alice #1 · act\/2 · .*\n    talked to @Bob/);
  assert.doesNotMatch(waiting.stdout, /please check @Bob/);

  const personal = run(withName(file, 'Bob', ['status']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.match(personal.stdout, /Bob.*1 mention waiting/);
  assert.match(personal.stdout, /please check @Bob/);
  assert.match(personal.stdout, /act\/\d+/);
  assert.doesNotMatch(personal.stdout, /Alice.*caught up/);

  assert.equal(run(withName(file, 'Bob', ['catch', '--now']), { env: { SQUARE_NOW_MS: '5000' } }).status, 0);
  const caughtUp = run(withPath(file, ['status']), { env: { SQUARE_NOW_MS: '6000' } });
  assert.match(caughtUp.stdout, /Bob.*caught up/);
});

test('status header counts only participants still in the square', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['done', 'finished']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  const status = run(withPath(file, ['status']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /— 1 in the square/);
});

test('headers shorten absolute square paths inside the working directory', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-short-path-'));
  const file = path.join(cwd, '.square', 'review.square');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const built = run(['--location', file, 'build', '--cap', 'unlimited', '--force'], {
    cwd,
    input: '## Topic\n\nShort paths\n',
  });
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /the square at \.square\/review\.square/);
  assert.doesNotMatch(built.stdout, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('room changes and final notes remain visible without duplicate done events', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['hold', 'pause']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['resume']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);
  const caught = run(withName(file, 'Alice', ['catch', '--now']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(caught.status, 0, caught.stderr);
  assert.match(caught.stdout, /Bob stepped into the square/);
  assert.match(caught.stdout, /Bob raised a hand — pause/);
  assert.match(caught.stdout, /Bob lowered the hand/);

  assert.equal(run(withName(file, 'Bob', ['done', '-']), { env: { SQUARE_NOW_MS: '6000' }, input: 'final note\n' }).status, 0);
  const afterDone = run(withName(file, 'Alice', ['catch', '--now']), { env: { SQUARE_NOW_MS: '7000' } });
  assert.equal(afterDone.status, 0, afterDone.stderr);
  assert.match(afterDone.stdout, /final note/);
  assert.equal((afterDone.stdout.match(/final note/g) ?? []).length, 1);
  assert.match(run(withPath(file, ['history', '--full'])).stdout, /final note/);
  assert.match(run(withName(file, 'Alice', ['status'])).stdout, /final note/);
});

test('status attention and express blocker agree on unread square changes', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['hold', 'pause']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  const status = run(withName(file, 'Alice', ['status']), { env: { SQUARE_NOW_MS: '200000' } });
  assert.match(status.stdout, /Alice.*changes waiting/);
  const noWaitAct = run(withName(file, 'Alice', ['express', '--no-wait', 'late body @Bob']), { env: { SQUARE_NOW_MS: '200000' } });
  assert.match(noWaitAct.stdout, /a hand is raised/);
  assert.match(noWaitAct.stdout, /draft kept/);
  assert.equal(run(withName(file, 'Bob', ['resume']), { env: { SQUARE_NOW_MS: '210000' } }).status, 0);
  const unheld = run(withName(file, 'Alice', ['express', '--no-wait', 'after resume @Bob']), { env: { SQUARE_NOW_MS: '220000' } });
  assert.match(unheld.stdout, /square moved behind your back/);
  assert.match(unheld.stdout, /catch --now/);
});

test('an unread join alone does not block express', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);

  const expressed = run(withName(file, 'Alice', ['express', 'welcome @Bob']), {
    env: { SQUARE_NOW_MS: '200000' },
  });
  assert.equal(expressed.status, 0, expressed.stderr);
  assert.match(expressed.stdout, /heads turn your way/);
  assert.match(expressed.stdout, /Bob stepped into the square/);
  assert.doesNotMatch(expressed.stdout, /catch --now/);
});

test('held, throttled, blocked, and capped activities preserve executable drafts', () => {
  const heldFile = tempSquare();
  assert.equal(build(heldFile, ['--cap', '10']).status, 0);
  assert.equal(run(withName(heldFile, 'Alice', ['join'])).status, 0);
  assert.equal(run(withName(heldFile, 'Host', ['join'])).status, 0);
  assert.equal(run(withName(heldFile, 'Host', ['hold', 'pause'])).status, 0);
  assertDraftRecovery(run(withName(heldFile, 'Alice', ['express', '--no-wait', '-']), { input: 'held body @Host\n' }), heldFile, 'Alice', 'held body @Host\n', 'express -');

  const throttleFile = tempSquare();
  assert.equal(build(throttleFile, ['--cap', '10', '--throttle', '1']).status, 0);
  assert.equal(run(withName(throttleFile, 'Alice', ['join'])).status, 0);
  assert.equal(run(withName(throttleFile, 'Alice', ['express', 'first @Alice'])).status, 0);
  const throttled = run(withName(throttleFile, 'Alice', ['express', '--no-wait', '-']), { input: 'throttled body @Alice\n' });
  assertDraftRecovery(throttled, throttleFile, 'Alice', 'throttled body @Alice\n', 'express -');
  assert.match(throttled.stdout, /next opening in (?:\d+s|1m)/);
  assert.doesNotMatch(throttled.stdout, /\d{4,}ms/);

  const capFile = tempSquare();
  assert.equal(build(capFile, ['--cap', '1']).status, 0);
  assert.equal(run(withName(capFile, 'Alice', ['join'])).status, 0);
  assert.equal(run(withName(capFile, 'Alice', ['express', 'first @Alice'])).status, 0);
  assertDraftRecovery(run(withName(capFile, 'Alice', ['express', '-']), { input: 'final body @Alice\n' }), capFile, 'Alice', 'final body @Alice\n', 'done -');

  const blockedFile = tempSquare();
  assert.equal(build(blockedFile, ['--cap', '10']).status, 0);
  assert.equal(run(withName(blockedFile, 'Alice', ['join']), { env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(blockedFile, 'Bob', ['join']), { env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(blockedFile, 'Bob', ['express', 'peer @Alice']), { env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  assertDraftRecovery(run(withName(blockedFile, 'Alice', ['express', '-']), { input: 'blocked body @Bob\n' }), blockedFile, 'Alice', 'blocked body @Bob\n', 'express -');
});

test('join is bounded and prints the scene inline', () => {
  const file = tempSquare();
  assert.equal(run(['build', '--location', file, '--cap', '3', '--template', 'brainstorm', '--force'], { input: '## Topic\n\nBounded join\n' }).status, 0);
  const joined = run(withName(file, 'Alice', ['join']));
  assert.equal(joined.status, 0, joined.stderr);
  assert.ok(joined.stdout.length < 12000, `${joined.stdout.length} bytes`);
  assert.match(joined.stdout, /context/);
  assert.match(joined.stdout, /stepped into the square/);
  assert.doesNotMatch(joined.stdout, /warmup/);
});

test('list bounds recursive discovery by default and accepts an explicit depth', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-list-depth-'));
  const visible = path.join(cwd, 'one', 'two', 'three', 'four', 'visible-square.square');
  const deeper = path.join(cwd, 'one', 'two', 'three', 'four', 'five', 'deeper.square');
  fs.mkdirSync(path.dirname(visible), { recursive: true });
  fs.mkdirSync(path.dirname(deeper), { recursive: true });

  assert.equal(run(['build', '--location', visible, '--cap', '3', '--force'], { cwd, input: 'visible\n' }).status, 0);
  assert.equal(run(['build', '--location', deeper, '--cap', '3', '--force'], { cwd, input: 'deeper\n' }).status, 0);

  const bounded = run(['list'], { cwd });
  assert.equal(bounded.status, 0, bounded.stderr);
  assert.match(bounded.stdout, /visible-square/);
  assert.doesNotMatch(bounded.stdout, /deeper\.square/);

  const expanded = run(['list', '--depth', '5'], { cwd });
  assert.equal(expanded.status, 0, expanded.stderr);
  assert.match(expanded.stdout, /visible-square/);
  assert.match(expanded.stdout, /deeper\.square/);

  const invalid = run(['list', '--depth', '-1'], { cwd });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /square list --help/);
});

test('list previews bounded context and the three most recently active participants', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-list-preview-'));
  const file = path.join(cwd, '.square', 'preview.square');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assert.equal(run(['build', '--location', file, '--cap', '10', '--force'], {
    cwd,
    input: '## Topic\n\nFirst context line\nSecond context line\n',
  }).status, 0);

  assert.equal(run(withName(file, 'alice', ['join']), { cwd, env: { SQUARE_NOW_MS: '1000' } }).status, 0);
  assert.equal(run(withName(file, 'bob', ['join']), { cwd, env: { SQUARE_NOW_MS: '2000' } }).status, 0);
  assert.equal(run(withName(file, 'carol', ['join']), { cwd, env: { SQUARE_NOW_MS: '3000' } }).status, 0);
  assert.equal(run(withName(file, 'dave', ['join']), { cwd, env: { SQUARE_NOW_MS: '4000' } }).status, 0);
  assert.equal(run(withName(file, 'alice', ['express', '--force', '@bob latest']), { cwd, env: { SQUARE_NOW_MS: '5000' } }).status, 0);

  const listed = run(['list'], { cwd });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /context · ## Topic\n\s+· First context line\n\s+· … 1 more line/);
  assert.match(listed.stdout, /participants · alice · dave · carol · … 1 more/);
  assert.doesNotMatch(listed.stdout, /participants[^\n]*bob/);
});

test('list, participants, and clipped status use current state and executable hints', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-current-state-'));
  const file = path.join(cwd, '.square', 'state.square');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assert.equal(run(['build', '--location', file, '--cap', '10', '--throttle', '2', '--force'], { cwd, input: '## Topic\n\nCurrent state\n' }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { cwd }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['join']), { cwd }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['done', 'finished']), { cwd }).status, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--force', `${'x'.repeat(260)} @Alice`]), { cwd }).status, 0);

  const listed = run(['list'], { cwd });
  assert.match(listed.stdout, /1 in square/);
  assert.doesNotMatch(listed.stdout, /2 in square/);
  assert.match(listed.stdout, /context · ## Topic\n\s+· Current state/);
  assert.match(listed.stdout, /participants · Alice/);
  assert.doesNotMatch(listed.stdout, /participants[^\n]*Bob/);

  const participants = run(withPath(file, ['participants']), { cwd });
  assert.match(participants.stdout, /Alice · active/);
  assert.match(participants.stdout, /Bob · done/);
  assert.doesNotMatch(participants.stdout, /^presence$/m);

  const status = run(withName(file, 'Alice', ['status']), { cwd });
  assert.match(status.stdout, /more chars/);
  assert.match(status.stdout, /» square --location '.*' --as 'Alice' history --at act\/\d+ -C 2 --full/);
  assert.match(status.stdout, /throttle 2\/min/);
});

test('ordinary argument errors stay scoped and stream pipes stay ANSI-free', () => {
  const error = run(['status', '--wat']);
  assert.equal(error.status, 2);
  assert.ok(error.stderr.length < 200, error.stderr);
  assert.match(error.stderr, /square status --help/);

  const file = tempSquare();
  assert.equal(build(file).status, 0);
  const streamed = run(withPath(file, ['stream']));
  assert.equal(streamed.status, 2);
  assert.doesNotMatch(streamed.stderr, /\\x1b|\u001b/);
  assert.match(streamed.stderr, /stream --ndjson/);
});
