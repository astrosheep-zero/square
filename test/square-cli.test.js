import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { formatActivityId } from '../dist/square-core.js';
import { Square } from '../dist/index.js';
import {
  ROOT,
  TEST_REGISTRY,
  TEST_PRESENTED,
  run,
  runAsync,
  tempSquare,
  withPath,
  withName,
  persistSquare,
  build,
} from './square-cli-helpers.js';

test('CLI test runner isolates host delivery identities', () => {
  const previous = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = 'outer-codex-task';
  const file = tempSquare();
  try {
    assert.equal(build(file).status, 0);
    const joined = run(withName(file, 'Alice', ['join']), {
      env: { SQUARE_REGISTRY: TEST_REGISTRY, SQUARE_PRESENTED: TEST_PRESENTED },
    });
    assert.equal(joined.status, 0, joined.stderr);
    assert.match(joined.stdout, /no session delivery detected/);
    const registry = fs.existsSync(TEST_REGISTRY) ? fs.readFileSync(TEST_REGISTRY, 'utf8') : '';
    assert.doesNotMatch(registry, /outer-codex-task/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previous;
  }
});

test('participants renders roster names without mention syntax', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  const joined = run(withName(file, 'Alice', ['join']), {
    env: { SQUARE_REGISTRY: TEST_REGISTRY, SQUARE_PRESENTED: TEST_PRESENTED },
  });
  assert.equal(joined.status, 0, joined.stderr);
  const roster = run(withPath(file, ['participants']));
  assert.equal(roster.status, 0, roster.stderr);
  assert.match(roster.stdout, /  ○ Alice · active/);
  assert.doesNotMatch(roster.stdout, /@Alice/);
});

test('listen and ignore commands control future bare delivery without gating express', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    await square.join('Bob');
  });
  const missingReach = run(withName(file, 'Alice', ['express', 'bare thought']));
  assert.equal(missingReach.status, 2);
  assert.match(missingReach.stderr, /express needs --mention <name>, --no-mention, or --bell/);

  const bareWithoutListener = run(withName(file, 'Alice', ['express', '--no-mention', 'bare thought']));
  assert.equal(bareWithoutListener.status, 0, bareWithoutListener.stderr);

  const ignoredBeforeListening = run(withName(file, 'Bob', ['ignore', 'Alice']));
  assert.equal(ignoredBeforeListening.status, 0, ignoredBeforeListening.stderr);
  assert.match(ignoredBeforeListening.stdout, /@Bob turns away from @Alice/);

  const listened = run(withName(file, 'Bob', ['listen', 'Alice']));
  assert.equal(listened.status, 0, listened.stderr);
  assert.match(listened.stdout, /@Bob turns an ear toward @Alice/);
  const repeated = run(withName(file, 'Bob', ['listen', 'Alice']));
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /already turns an ear toward @Alice/);
  assert.equal(run(withName(file, 'Alice', ['catch', '--now'])).status, 0);
  assert.equal(run(withName(file, 'Alice', ['express', '--no-mention', 'bare thought'])).status, 0);
  const listening = run(withName(file, 'Bob', ['listening']));
  assert.equal(listening.status, 0, listening.stderr);
  assert.match(listening.stdout, /@Alice/);
  const ignored = run(withName(file, 'Bob', ['ignore', 'Alice']));
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.match(ignored.stdout, /@Bob turns away from @Alice/);
  const absent = run(withName(file, 'Bob', ['ignore', 'Alice']));
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /is not turned toward @Alice/);
});

test('listener and catch help teach future-only directed attention', () => {
  for (const command of ['listen', 'ignore', 'listening', 'catch']) {
    const result = run([command, '--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /future|directed|listening/i);
  }
  const catchHelp = run(['catch', '--help']);
  assert.doesNotMatch(catchHelp.stdout, /what others have said or done/);
  assert.match(catchHelp.stdout, /fixed when each say lands/);
});

test('listener commands do not rejoin a participant who already left', async () => {
  const file = await persistSquare(async ({ square }) => {
    const bob = await square.join('Bob');
    await bob.done();
  });
  const before = run(withPath(file, ['history', '--no-truncate']));
  const refused = run(withName(file, 'Bob', ['listen', 'Alice']));
  assert.equal(refused.status, 2);
  const after = run(withPath(file, ['history', '--no-truncate']));
  assert.equal(after.stdout, before.stdout);
});

test('install and uninstall manage an explicit OpenCode target', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-opencode-install-'));
  const config = path.join(home, 'xdg');
  try {
    const result = run(['install', 'opencode'], {
      env: { HOME: home, XDG_CONFIG_HOME: config },
    });
    assert.equal(result.status, 0, result.stderr);
    const plugin = path.join(config, 'opencode', 'opencode.jsonc');
    assert.deepEqual(JSON.parse(fs.readFileSync(plugin, 'utf8')).plugin, ['@astrosheep/square']);

    const removed = run(['uninstall', 'opencode'], {
      env: { HOME: home, XDG_CONFIG_HOME: config },
    });
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(plugin, 'utf8')).plugin, []);
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

test('every public subcommand exposes scoped help without a square', async () => {
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
    'doctor',
  ];

  const results = await Promise.all(commands.map((command) => runAsync([command, '--help'], { cwd })));
  for (const [index, result] of results.entries()) {
    const command = commands[index];
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

test('help command resolves aliases and rejects unknown commands', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-help-alias-'));
  const [direct, named, alias, unknown, ...removedResults] = await Promise.all([
    runAsync(['history', '--help'], { cwd }),
    runAsync(['help', 'history'], { cwd }),
    runAsync(['help', 'list'], { cwd }),
    runAsync(['help', 'missing-command'], { cwd }),
    ...['act', 'echo', 'compact'].flatMap((removed) => [
      runAsync(['help', removed], { cwd }),
      runAsync([removed], { cwd }),
    ]),
  ]);
  assert.equal(named.status, 0, named.stderr);
  assert.equal(named.stdout, direct.stdout);
  assert.equal(alias.status, 0, alias.stderr);
  assert.match(alias.stdout, /^Usage: square list \[--depth N\]$/m);
  assert.match(alias.stdout, /^Aliases: ls$/m);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command: missing-command/);
  assert.match(unknown.stderr, /square help/);
  for (const [index, result] of removedResults.entries()) {
    const removed = ['act', 'echo', 'compact'][Math.floor(index / 2)];
    assert.equal(result.status, 2, removed);
    assert.match(result.stderr, new RegExp(`unknown command: ${removed}`));
    assert.doesNotMatch(result.stderr, /did you mean/i);
  }
});

test('build rejects removed --participants flag', () => {
  const file = tempSquare();
  const result = build(file, ['--participants', 'Alice']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown build option: --participants/);
});

test('build defaults to unlimited, accepts its explicit spelling, and rejects the removed -1 sentinel', async () => {
  const defaulted = tempSquare();
  const withoutCap = run(['--location', defaulted, 'build'], { input: 'default unlimited\n' });
  assert.equal(withoutCap.status, 0, withoutCap.stderr);
  const defaultSquare = await Square.at({ path: defaulted });
  assert.equal((await defaultSquare.snapshot()).hardCap, null);
  await defaultSquare.close();

  const unlimited = tempSquare();
  const accepted = run(['--location', unlimited, 'build', '--cap', 'unlimited'], { input: 'unlimited\n' });
  assert.equal(accepted.status, 0, accepted.stderr);
  const unlimitedSquare = await Square.at({ path: unlimited });
  assert.equal((await unlimitedSquare.snapshot()).hardCap, null);
  await unlimitedSquare.close();

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
  assert.match(joined.stdout, /Explicit/);
});

test('square-accessing commands refuse to invent a default location', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-no-default-location-'));
  try {
    for (const command of ['build', 'stream', 'join', 'catch', 'express', 'done', 'hold', 'resume', 'history', 'status', 'participants', 'doctor']) {
      const result = run([command], { cwd, input: command === 'build' ? 'body\n' : undefined });
      assert.equal(result.status, 2, `${command}: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`${command} needs a square location`));
      assert.doesNotMatch(result.stderr, /\.square\/SQUARE\.square/);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
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

  assert.equal(run(withName(file, 'Bob', ['express', '--force', '--mention', 'Alice', 'hello Alice @Alice']), { env: codexDelivery }).status, 0);
  const aliceCatch = run(withName(file, 'Alice', ['catch', '--now']), { env: noDelivery });
  assert.equal(aliceCatch.status, 0, aliceCatch.stderr);
  assert.match(aliceCatch.stdout, /hello Alice/);
  assert.match(aliceCatch.stdout, /catch --idle 30m/);
  assert.match(aliceCatch.stdout, /stay available for new activity/);
  const aliceQuiet = run(withName(file, 'Alice', ['catch', '--now']), { env: noDelivery });
  assert.match(aliceQuiet.stdout, /only footsteps/);
  assert.match(aliceQuiet.stdout, /catch --idle 30m/);

  assert.equal(run(withName(file, 'Alice', ['express', '--force', '--mention', 'Bob', 'hello Bob @Bob']), { env: noDelivery }).status, 0);
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
  assert.match(sameName.stderr, /@Bob shoos you out of the square/);
  assert.match(sameName.stderr, /join --kick/);

  const takeover = run(withName(file, 'Bob', ['join', '--kick']), { env: { ...codexDelivery, CODEX_THREAD_ID: 'codex-other' } });
  assert.equal(takeover.status, 0, takeover.stderr);
  assert.match(takeover.stdout, /you banished the original @Bob/);
  assert.doesNotMatch(takeover.stdout, /catch --/);
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

test('doctor --fix is not a command', async () => {
  const file = await persistSquare(async () => {});
  const result = run(withPath(file, ['doctor', '--fix']));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid arguments for doctor/);
});

test('catch requires one explicit mode and rejects removed modes', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
  });
  const rejected = [
    ['catch'],
    ['catch', '--now', '--idle', '1s'],
    ['catch', '--follow'],
    ['catch', '--count', '2'],
    ['catch', '--force', '--now'],
    ['catch', '--now', '--replace'],
  ];
  const results = await Promise.all(rejected.map((args) => runAsync(withName(file, 'Alice', args))));
  for (const [index, result] of results.entries()) {
    assert.notEqual(result.status, 0, rejected[index].join(' '));
  }
  assert.equal(run(withName(file, 'Alice', ['catch', '--now'])).status, 0);
});

test('history rejects removed filter aliases', async () => {
  const file = await persistSquare(async () => {});
  const rejected = [
    ['history', '--by', 'Alice'],
    ['history', '--last', '1'],
    ['history', '--mentions', 'me'],
    ['history', '--until', '1h'],
    ['history', '--before', '1h'],
  ];
  const results = await Promise.all(rejected.map((args) => runAsync(withPath(file, args))));
  for (const [index, result] of results.entries()) {
    const args = rejected[index];
    assert.notEqual(result.status, 0, args.join(' '));
    if (args[1] === '--until') assert.match(result.stderr, /history does not know --until/);
    else if (args[1] === '--before') assert.match(result.stderr, /Invalid --before: expected an activity id/);
    else assert.match(result.stderr, new RegExp(`history does not know ${args[1]}`));
    if (args[1] !== '--before') assert.match(result.stderr, /» square history --help\n$/);
  }
});

test('history reports unknown options and bounded limits with a next command', async () => {
  const file = await persistSquare(async () => {});

  const unknown = run(withPath(file, ['history', '--wat']));
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /✕ history does not know --wat/);
  assert.match(unknown.stderr, /» square history --help\n$/);

  const limits = ['0', '-1', 'nope'];
  const invalids = await Promise.all(limits.map((value) => runAsync(withPath(file, ['history', '--limit', value]))));
  for (const [index, invalid] of invalids.entries()) {
    assert.notEqual(invalid.status, 0, limits[index]);
    assert.match(invalid.stderr, /✕ --limit needs a positive integer/);
    assert.match(invalid.stderr, /history --limit 100\n$/);
  }

  const overLimit = run(withPath(file, ['history', '--limit', '101']));
  assert.equal(overLimit.status, 2);
  assert.match(overLimit.stderr, /--limit is capped at 100/);
  assert.match(overLimit.stderr, /history --limit 100\n$/);
});

test('join rejects removed exhaustive history and bounds --last', async () => {
  const file = await persistSquare(async () => {});

  const exhaustive = run(withName(file, 'Alice', ['join', '--all']));
  assert.equal(exhaustive.status, 2);
  assert.match(exhaustive.stderr, /invalid arguments for join/);

  const overLimit = run(withName(file, 'Alice', ['join', '--last', '101']));
  assert.equal(overLimit.status, 2);
  assert.match(overLimit.stderr, /--last is capped at 100/);
  assert.match(overLimit.stderr, /--as 'Alice' join --last 100\n$/);

  const zero = run(withName(file, 'Alice', ['join', '--last', '0']));
  assert.equal(zero.status, 2);
  assert.match(zero.stderr, /--last needs a positive integer/);
});

test('CLI activity selectors accept only canonical textual ids', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    await alice.express('anchor', { force: true, reach: 'bell' });
  });

  const underscore = ['act', '1'].join('_');
  const cases = [
    ['--reply', withName(file, 'Alice', ['express', '--force', '--no-mention', '--reply', underscore, 'later @Alice'])],
    ['--at', withPath(file, ['history', '--at', underscore])],
    ['--after', withPath(file, ['history', '--after', underscore])],
    ['--reply', withName(file, 'Alice', ['express', '--force', '--no-mention', '--reply', '1', 'later @Alice'])],
    ['--at', withPath(file, ['history', '--at', '1'])],
    ['--reply', withName(file, 'Alice', ['express', '--force', '--no-mention', '--reply', ` ${formatActivityId(1)} `, 'later @Alice'])],
    ['--at', withPath(file, ['history', '--at', ` ${formatActivityId(1)} `])],
  ];
  const results = await Promise.all(cases.map(([, args]) => runAsync(args)));
  for (const [index, result] of results.entries()) {
    const [flag] = cases[index];
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, new RegExp(`Invalid ${flag}: expected an activity id like act/12`));
  }
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

test('ordinary argument errors stay scoped and stream pipes stay ANSI-free', async () => {
  const error = run(['--location', tempSquare(), 'status', '--wat']);
  assert.equal(error.status, 2);
  assert.ok(error.stderr.length < 200, error.stderr);
  assert.match(error.stderr, /square status --help/);

  const file = await persistSquare(async () => {});
  const streamed = run(withPath(file, ['stream']));
  assert.equal(streamed.status, 2);
  assert.doesNotMatch(streamed.stderr, /\\x1b|\u001b/);
  assert.match(streamed.stderr, /stream --ndjson/);
});
