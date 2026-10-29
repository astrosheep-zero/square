import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createArtifactPort } from '../dist/artifact.js';
import { formatActivityId } from '../dist/square-core.js';
import { squareInput, commandIdentity } from '../dist/cli/context.js';
import { Square, localUserOwner, harnessOwner } from '../dist/square-api.js';
import { streamCommand } from '../dist/cli/observation-commands.js';
import {
  ROOT,
  run,
  runAsync,
  tempSquare,
  withPath,
  withName,
  persistSquare,
  build,
} from './square-cli-helpers.js';
import { nodeCommandFixture } from './node-command-fixture.js';

test('CLI passes harness identity to operations rather than the resource', () => {
  const coordinates = [
    ['CLAUDE_CODE_SESSION_ID', 'claude-code', 'claude-session'],
    ['CODEX_THREAD_ID', 'codex', 'codex-session'],
    ['OPENCODE_SESSION_ID', 'opencode', 'opencode-session'],
    ['PI_SESSION_ID', 'pi', 'pi-session'],
    ['PASEO_AGENT_ID', 'paseo', 'paseo-agent'],
  ];
  const inputFor = commandIdentity;

  for (const [variable, channel, session] of coordinates) {
    const input = inputFor({ [variable]: ` ${session} ` });
    assert.deepEqual(input.owner, `${channel}:${session}`, variable);
    if (channel === 'paseo') assert.deepEqual(input.wakeAddress, { kind: 'paseo', address: { agentId: session } }, variable);
    if (channel === 'codex') assert.deepEqual(input.wakeAddress, { kind: 'codex-queue', address: { threadId: session, codexHome: path.join(os.homedir(), '.codex') } }, variable);
  }
  const nativeWithPaseo = inputFor({ CODEX_THREAD_ID: 'codex-session', PASEO_AGENT_ID: 'paseo-agent',
    CODEX_HOME: '/recipient/codex', SQUARE_CODEX_ENDPOINT: ' unix:///recipient/control.sock ' });
  assert.deepEqual(nativeWithPaseo.owner, 'codex:codex-session');
  assert.deepEqual(nativeWithPaseo.wakeAddress, { kind: 'codex-queue', address: {
    threadId: 'codex-session', codexHome: '/recipient/codex', endpoint: 'unix:///recipient/control.sock',
  } });
  assert.equal(inputFor({ CODEX_THREAD_ID: 'home-default', HOME: '/recipient' }).wakeAddress.address.codexHome, '/recipient/.codex');
  const withoutCoordinate = inputFor({ SQUARE_PARTICIPANT_NAME: 'Alice' });
  assert.equal(withoutCoordinate.owner, localUserOwner());
  assert.equal(Object.hasOwn(withoutCoordinate, 'wakeAddress'), false);
  assert.throws(() => inputFor({ CLAUDE_CODE_SESSION_ID: 'claude', CODEX_THREAD_ID: 'codex' }), /Multiple harness execution coordinates/);
  assert.throws(() => inputFor({ CLAUDE_CODE_SESSION_ID: 'claude', CLAUDE_CODE_CHILD_SESSION: '1', PASEO_AGENT_ID: 'top-level-paseo' }), /incomplete/);
});

test('CLI read-only opens need no identity; participant writes do', async () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  const square = await Square.at(squareInput({
    command: 'status', cwd: ROOT, env: {}, squarePath: file, name: 'Alice', homeDir: os.homedir(),
  }));
  try {
    assert.equal((await square.snapshot()).participants.length, 0);
    await assert.rejects(square.join('Alice', {}), /explicit owner/);
  } finally { await square.close(); }
});

test('CLI test runner does not inherit the parent execution identity', async () => {
  const previous = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = 'outer-codex-task';
  const file = tempSquare();
  try {
    assert.equal(build(file).status, 0);
    const joined = run(withName(file, 'Alice', ['join']));
    assert.equal(joined.status, 0, joined.stderr);
    assert.match(joined.stdout, /when someone calls you/);
    const artifact = createArtifactPort(file);
    try {
      const seat = (await artifact.read((facts) => facts.seat('Alice'))).value;
      assert.deepEqual(seat?.owner, harnessOwner({ channel: 'codex', session: path.resolve(file) }));
    } finally { await artifact.close(); }
  } finally {
    if (previous === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previous;
  }
});

test('participants renders roster names without mention syntax', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  const joined = run(withName(file, 'Alice', ['join']));
  assert.equal(joined.status, 0, joined.stderr);
  const roster = run(withPath(file, ['participants']));
  assert.equal(roster.status, 0, roster.stderr);
  assert.match(roster.stdout, /  ○ Alice · active/);
  assert.doesNotMatch(roster.stdout, /@Alice/);
});

test('bare activities land without an audience and listeners receive later bare activity', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    await square.join('Alice', { owner: body, wakeAddress });
    await square.join('Bob', { owner: body, wakeAddress });
  });
  const bareWithoutListener = run(withName(file, 'Alice', ['express', 'bare thought']));
  assert.equal(bareWithoutListener.status, 0, bareWithoutListener.stderr);
  assert.match(bareWithoutListener.stdout, /your words land/);

  const ignoredBeforeListening = run(withName(file, 'Bob', ['ignore', 'Alice']));
  assert.equal(ignoredBeforeListening.status, 0, ignoredBeforeListening.stderr);
  assert.match(ignoredBeforeListening.stdout, /@Bob turns away from @Alice/);

  const listened = run(withName(file, 'Bob', ['listen', 'Alice']));
  assert.equal(listened.status, 0, listened.stderr);
  assert.match(listened.stdout, /@Bob turns an ear toward @Alice/);
  const repeated = run(withName(file, 'Bob', ['listen', 'Alice']));
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /already turns an ear toward @Alice/);
  const heard = run(withName(file, 'Alice', ['express', 'listener thought']));
  assert.equal(heard.status, 0, heard.stderr);
  const caught = run(withName(file, 'Bob', ['catch', '--now']));
  assert.equal(caught.status, 0, caught.stderr);
  assert.match(caught.stdout, /listener thought/);
  assert.doesNotMatch(caught.stdout, /bare thought/);

  const listening = run(withName(file, 'Bob', ['listening']));
  assert.equal(listening.status, 0, listening.stderr);
  assert.match(listening.stdout, /@Alice/);
  const ignored = run(withName(file, 'Bob', ['ignore', 'Alice']));
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.match(ignored.stdout, /@Bob turns away from @Alice/);
  const absent = run(withName(file, 'Bob', ['ignore', 'Alice']));
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /already ignores @Alice/);
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

test('catch limit is bounded and mention is boolean', () => {
  const limit = run(['catch', '--help']);
  assert.match(limit.stdout, /--limit <count>/);
  assert.match(limit.stdout, /maximum 100/);
});

test('listener commands do not rejoin a participant who already left', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const bob = (await square.join('Bob', { owner: body, wakeAddress })).participant;
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
  const fake = nodeCommandFixture('square-opencode-install', `
    const fs = require('node:fs');
    const path = require('node:path');
    const target = path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json');
    const [command, action] = process.argv.slice(2);
    if (command === 'plugin' && ['add', 'update'].includes(action)) {
      if (!JSON.parse(fs.readFileSync(target, 'utf8')).plugins.includes('@astrosheep/square')) process.exit(1);
    } else {
      process.exit(1);
    }
  `);
  try {
    const result = run(['install', 'opencode'], {
      env: { HOME: home, XDG_CONFIG_HOME: config, SQUARE_OPENCODE_BIN: fake.bin, SQUARE_OPENCODE_BIN_ARGS: JSON.stringify(fake.args) },
    });
    assert.equal(result.status, 0, result.stderr);
    const plugin = path.join(config, 'opencode', 'opencode.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(plugin, 'utf8')).plugins, ['@astrosheep/square']);

    const removed = run(['uninstall', 'opencode'], {
      env: { HOME: home, XDG_CONFIG_HOME: config, SQUARE_OPENCODE_BIN: fake.bin, SQUARE_OPENCODE_BIN_ARGS: JSON.stringify(fake.args) },
    });
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(plugin, 'utf8')).plugins, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fake.root, { recursive: true, force: true });
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
    'claude-mod',
    'codex-hook',
    'history',
    'status',
    'participants',
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
  for (const internal of ['stream', 'inbox', 'claude-mod', 'codex-hook']) {
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
  assert.match(alias.stdout, /^Usage: square list \[--depth N\] \[--limit N\] \[--after path\]$/m);
  assert.match(alias.stdout, /^Aliases: ls$/m);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command: missing-command/);
  assert.match(unknown.stderr, /square --help/);
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

test('CLI flags override Square location and participant environment values', async () => {
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
  const artifact = createArtifactPort(explicit);
  try {
    const seat = (await artifact.read((facts) => facts.seat('Explicit'))).value;
    assert.deepEqual(seat?.owner, harnessOwner({ channel: 'codex', session: path.resolve(explicit) }));
  } finally { await artifact.close(); }
});

test('square-accessing commands refuse to invent a default location', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-no-default-location-'));
  try {
    for (const command of ['build', 'stream', 'join', 'catch', 'express', 'done', 'history', 'status', 'participants', 'doctor']) {
      const result = run([command], { cwd, input: command === 'build' ? 'body\n' : undefined });
      assert.equal(result.status, 2, `${command}: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`${command} needs a square location`));
      assert.doesNotMatch(result.stderr, /\.square\/SQUARE\.square/);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('join and catch preserve CLI behavior while seat ownership follows the active body', async () => {
  const file = tempSquare();
  const aliceBody = { CODEX_THREAD_ID: 'codex-alice' };
  const bobBody = { CODEX_THREAD_ID: 'codex-bob' };

  assert.equal(build(file).status, 0);

  const aliceJoin = run(withName(file, 'Alice', ['join']), { env: aliceBody });
  assert.equal(aliceJoin.status, 0, aliceJoin.stderr);
  assert.match(aliceJoin.stdout, /when someone calls you/);
  assert.doesNotMatch(aliceJoin.stdout, /catch --idle 30m/);

  const bobJoin = run(withName(file, 'Bob', ['join']), { env: bobBody });
  assert.equal(bobJoin.status, 0, bobJoin.stderr);
  assert.match(bobJoin.stdout, /when someone calls you/);
  assert.doesNotMatch(bobJoin.stdout, /catch --idle 30m/);

  assert.equal(run(withName(file, 'Bob', ['express', '--force', '--mention', 'Alice', 'hello Alice @Alice']), { env: bobBody }).status, 0);
  const aliceCatch = run(withName(file, 'Alice', ['catch', '--now']), { env: aliceBody });
  assert.equal(aliceCatch.status, 0, aliceCatch.stderr);
  assert.match(aliceCatch.stdout, /hello Alice/);
  assert.doesNotMatch(aliceCatch.stdout, /catch --idle 30m/);
  const aliceQuiet = run(withName(file, 'Alice', ['catch', '--now']), { env: aliceBody });
  assert.match(aliceQuiet.stdout, /only footsteps/);
  assert.doesNotMatch(aliceQuiet.stdout, /catch --idle 30m/);

  assert.equal(run(withName(file, 'Alice', ['express', '--force', '--mention', 'Bob', 'hello Bob @Bob']), { env: aliceBody }).status, 0);
  const bobCatch = run(withName(file, 'Bob', ['catch', '--now']), { env: bobBody });
  assert.equal(bobCatch.status, 0, bobCatch.stderr);
  assert.match(bobCatch.stdout, /hello Bob/);
  assert.doesNotMatch(bobCatch.stdout, /catch --idle 30m/);
  const bobQuiet = run(withName(file, 'Bob', ['catch', '--now']), { env: bobBody });
  assert.match(bobQuiet.stdout, /only footsteps/);
  assert.doesNotMatch(bobQuiet.stdout, /catch --idle 30m/);

  const rebound = run(withName(file, 'Bob', ['join']), { env: bobBody });
  assert.equal(rebound.status, 0, rebound.stderr);
  assert.match(rebound.stdout, /you are already in the square/);
  assert.doesNotMatch(rebound.stdout, /catch --idle 30m/);

  const takeoverBody = { CODEX_THREAD_ID: 'codex-other' };
  const sameName = run(withName(file, 'Bob', ['join']), { env: takeoverBody });
  assert.equal(sameName.status, 2, sameName.stderr);
  assert.match(sameName.stderr, /@Bob shoos you out of the square/);
  assert.match(sameName.stderr, /If this is your name to reclaim/);
  assert.match(sameName.stderr, /join --kick/);

  const takeover = run(withName(file, 'Bob', ['join', '--kick']), { env: takeoverBody });
  assert.equal(takeover.status, 0, takeover.stderr);
  assert.match(takeover.stdout, /you banished the original @Bob/);
  assert.doesNotMatch(takeover.stdout, /catch --idle 30m/);

  const historySquare = await Square.at({ path: file });
  const lifecycle = ((await historySquare.history({ limit: 100 })).activities).filter((activity) => activity.actor === 'Bob' && (activity.kind === 'join' || activity.kind === 'done')).map((activity) => activity.kind);
  await historySquare.close();
  assert.deepEqual(lifecycle, ['join', 'done', 'join']);
  const artifact = createArtifactPort(file);
  try {
    const seats = (await artifact.read((facts) => ({
      current: facts.seat('Bob'),
      oldBody: facts.seatsForOwner("codex" + ":" + ('codex-bob')),
      newBody: facts.seatsForOwner("codex" + ":" + ('codex-other')),
    }))).value;
    assert.equal(seats.oldBody.length, 0);
    assert.deepEqual(seats.current?.owner, "codex" + ":" + ('codex-other'));
    assert.equal(seats.newBody.length, 1);
    assert.equal(seats.newBody[0].participant, 'Bob');
  } finally { await artifact.close(); }
});

test('a foreign catch cannot take ownership of a standing participant', async () => {
  const file = tempSquare();
  const env = { CODEX_THREAD_ID: 'coordinator' };
  const worker = { ...env, CODEX_THREAD_ID: 'worker' };
  assert.equal(build(file).status, 0);
  assert.equal(run(withName(file, 'Alice', ['join']), { env }).status, 0);
  const before = fs.readFileSync(file);
  const archive = run(withName(file, 'Alice', ['history', '--limit', '5']), { env: worker });
  assert.equal(archive.status, 0, archive.stderr);
  assert.deepEqual(fs.readFileSync(file), before, 'archive reading must not claim or consume');
  const caught = run(withName(file, 'Alice', ['catch', '--now']), { env: worker });
  assert.equal(caught.status, 2, caught.stdout);
  assert.match(caught.stderr, /not held by this owner/);
  assert.doesNotMatch(caught.stderr, /error/i);
  assert.ok(caught.stderr.trimEnd().endsWith(`square --location '${file}' --as 'Alice' join`));
  assert.deepEqual(fs.readFileSync(file), before, 'suggesting takeover must not execute it');
  const artifact = createArtifactPort(file);
  try {
    const seats = (await artifact.read((facts) => ({
      current: facts.seat('Alice'),
      worker: facts.seatsForOwner("codex" + ":" + ('worker')),
    }))).value;
    assert.deepEqual(seats.current?.owner, "codex" + ":" + ('coordinator'));
    assert.equal(seats.worker.length, 0);
  } finally { await artifact.close(); }
  const foreign = run(withName(file, 'Alice', ['express', '--force', '--no-mention', 'wrong speaker']), { env: worker });
  assert.equal(foreign.status, 2, foreign.stdout);
  const original = run(withName(file, 'Alice', ['express', '--force', '--no-mention', 'still mine']), { env });
  assert.equal(original.status, 0, original.stderr);
});

test('join --kick replaces a participant seat after a different body is refused', async () => {
  const file = tempSquare();
  const standing = { PI_SESSION_ID: 'standing-pi' };
  const caller = { CODEX_THREAD_ID: 'new-codex' };
  assert.equal(build(file).status, 0);
  const joined = run(withName(file, 'Alice', ['join']), { env: standing });
  assert.equal(joined.status, 0, joined.stderr);
  const artifact = createArtifactPort(file);
  let originalSeat;
  try { originalSeat = (await artifact.read((facts) => facts.seat('Alice'))).value; }
  finally { await artifact.close(); }

  const rejected = run(withName(file, 'Alice', ['express', '--force', '--no-mention', 'before']), { env: caller });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /not held by this owner/);
  const reconnect = run(withName(file, 'Alice', ['join']), { env: caller });
  assert.equal(reconnect.status, 2);
  assert.match(reconnect.stderr, /join --kick/);
  const takeover = run(withName(file, 'Alice', ['join', '--kick', '--last', '1']), { env: caller });
  assert.equal(takeover.status, 0, takeover.stderr);
  const expressed = run(withName(file, 'Alice', ['express', '--force', '--no-mention', 'after']), { env: caller });
  assert.equal(expressed.status, 0, expressed.stderr);

  const currentArtifact = createArtifactPort(file);
  let takeoverSeat;
  try {
    const seats = (await currentArtifact.read((facts) => ({
      current: facts.seat('Alice'),
      oldBody: facts.seatsForOwner("pi" + ":" + ('standing-pi')),
      newBody: facts.seatsForOwner("codex" + ":" + ('new-codex')),
    }))).value;
    takeoverSeat = seats.current;
    assert.equal(seats.oldBody.length, 0);
    assert.deepEqual(takeoverSeat?.owner, "codex" + ":" + ('new-codex'));
    assert.notEqual(takeoverSeat?.generation, originalSeat?.generation);
    assert.equal(seats.newBody.length, 1);
  } finally { await currentArtifact.close(); }

  const selfKick = run(withName(file, 'Alice', ['join', '--kick']), { env: caller });
  assert.equal(selfKick.status, 0, selfKick.stderr);
  const square = await Square.at({ path: file });
  try {
    const lifecycle = ((await square.history({ limit: 100 })).activities)
      .filter((activity) => activity.kind === 'join' || activity.kind === 'done')
      .map((activity) => activity.kind);
    assert.deepEqual(lifecycle, ['join', 'done', 'join', 'done', 'join']);
  } finally {
    await square.close();
  }
  const finalArtifact = createArtifactPort(file);
  try {
    const seat = (await finalArtifact.read((facts) => facts.seat('Alice'))).value;
    assert.deepEqual(seat?.owner, 'codex:new-codex');
    assert.notEqual(seat?.generation, takeoverSeat?.generation);
  } finally { await finalArtifact.close(); }
});

test('unknown participant errors end with the join recovery command', () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  const caught = run(withName(file, 'Stranger', ['catch', '--now']));
  assert.equal(caught.status, 2);
  assert.match(caught.stderr, /has never stepped into this square/);
  assert.match(caught.stderr, /join/);
  assert.match(caught.stderr, /--as 'Stranger' join/);

  const expressed = run(withName(file, 'Stranger', ['express', '--no-mention', 'hello']));
  assert.equal(expressed.status, 2);
  assert.match(expressed.stderr, /✕ @Stranger has never stepped into this square/);
  assert.match(expressed.stderr, /· draft kept:/);
  assert.match(expressed.stderr, /--as 'Stranger' join/);
});

test('an unknown recipient errors with the roster command instead of a join', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    await square.join('Alice', { owner: body, wakeAddress });
  });

  const expressed = run(withName(file, 'Alice', ['express', '--mention', 'Eve', 'hello']));
  assert.equal(expressed.status, 2);
  assert.match(expressed.stderr, /✕ @Eve is not standing in this square/);
  assert.match(expressed.stderr, new RegExp(`square --location '${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' participants`));
  assert.doesNotMatch(expressed.stderr, /--as 'Eve' join/);
});

test('status offers the full history read only when the latest body is clipped', async () => {
  const short = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    await alice.express('short words', { force: true });
  }, { hardCap: 10 });
  const unclipped = run(withName(short, 'Alice', ['status']));
  assert.equal(unclipped.status, 0, unclipped.stderr);
  assert.doesNotMatch(unclipped.stdout, /more chars/);
  assert.doesNotMatch(unclipped.stdout, /history --at act\/\d+ -C 2 --no-truncate/);

  // A short body that merely says "more chars" must not look clipped.
  const literal = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    await alice.express('the phrase more chars fits without clipping', { force: true });
  }, { hardCap: 10 });
  const literalStatus = run(withName(literal, 'Alice', ['status']));
  assert.equal(literalStatus.status, 0, literalStatus.stderr);
  assert.match(literalStatus.stdout, /more chars fits without clipping/);
  assert.doesNotMatch(literalStatus.stdout, /history --at act\/\d+ -C 2 --no-truncate/);

  const clipped = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    await alice.express('x'.repeat(260), { force: true });
  }, { hardCap: 10 });
  const clippedStatus = run(withName(clipped, 'Alice', ['status']));
  assert.equal(clippedStatus.status, 0, clippedStatus.stderr);
  assert.match(clippedStatus.stdout, /… \d+ more chars/);
  assert.match(clippedStatus.stdout, /history --at act\/\d+ -C 2 --no-truncate/);
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

test('catch conflicts and removed modes are refused while bare catch is the default now', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    await square.join('Alice', { owner: body, wakeAddress });
  });
  const rejected = [
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
  assert.match(results[0].stderr, /catch accepts --now or --idle, not both/);
  assert.match(results[4].stderr, /--replace can only be used with --idle/);
  assert.equal(run(withName(file, 'Alice', ['catch'])).status, 0);
  assert.equal(run(withName(file, 'Alice', ['catch', '--now'])).status, 0);
});

test('bare catch takes pending activity now and consumes it', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    await square.join('Alice', { owner: body, wakeAddress });
    const bob = (await square.join('Bob', { owner: body, wakeAddress })).participant;
    await bob.express('hello Alice', { mentions: ['Alice'] });
  });
  const caught = run(withName(file, 'Alice', ['catch']));
  assert.equal(caught.status, 0, caught.stderr);
  assert.match(caught.stdout, /hello Alice/);
  const quiet = run(withName(file, 'Alice', ['catch']));
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stdout, /hello Alice/);
  assert.match(quiet.stdout, /only footsteps|nothing new for you/);
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
    if (args[1] !== '--before') assert.match(result.stderr, /square history --help\n$/);
  }
});

test('history reports unknown options and bounded limits with a next command', async () => {
  const file = await persistSquare(async () => {});

  const unknown = run(withPath(file, ['history', '--wat']));
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /✕ history does not know --wat/);
  assert.match(unknown.stderr, /square history --help\n$/);

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
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
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
  assert.match(built.stdout, /· \.square\/review\.square/);
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

test('stream CLI defaults its tail, accepts zero through one hundred, and rejects incompatible cursors', () => {
  const context = { command: 'stream', squarePath: tempSquare(), homeDir: os.homedir() };
  assert.deepEqual(streamCommand.parse(['--ndjson'], context), { ndjson: true, forName: undefined, start: { kind: 'tail', last: 10 } });
  assert.deepEqual(streamCommand.parse(['--ndjson', '--last', '0'], context), { ndjson: true, forName: undefined, start: { kind: 'tail', last: 0 } });
  assert.deepEqual(streamCommand.parse(['--ndjson', '--last', '100'], context), { ndjson: true, forName: undefined, start: { kind: 'tail', last: 100 } });
  assert.deepEqual(streamCommand.parse(['--ndjson', '--after', 'act/12'], context), { ndjson: true, forName: undefined, start: { kind: 'after', after: 'act/12' } });

  const overLimit = run(withPath(context.squarePath, ['stream', '--ndjson', '--last', '101']));
  assert.equal(overLimit.status, 2);
  assert.match(overLimit.stderr, /Invalid --last: maximum is 100/);

  const incompatible = run(withPath(context.squarePath, ['stream', '--ndjson', '--last', '0', '--after', 'act/12']));
  assert.equal(incompatible.status, 2);
  assert.match(incompatible.stderr, /--last and --after cannot be combined/);
});
