import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { activityRetryCommand } from '../dist/activity.js';
import { renderActivityUncertain } from '../dist/presentation.js';
import { SquareError } from '../dist/model.js';
import { buildMemorySquare } from '../dist/square-file-adapter.js';
import { express, join } from '../dist/square-actions.js';
import { Square } from '../dist/index.js';
import { CLI, ROOT, run, withName, persistSquare, draftPathFrom, testEnv } from './square-cli-helpers.js';

const shellReplay = { skip: process.platform === 'win32' ? 'Printed command replay requires a POSIX shell.' : false };

function recovery(result, body) {
  assert.notEqual(result.status, 0);
  const output = result.stdout + result.stderr;
  const draft = draftPathFrom(output);
  assert.equal(fs.readFileSync(draft, 'utf8'), body);
  return { output, draft, commands: output.split('\n').filter((line) => /^square .* express /.test(line)) };
}

function executeRecovery(command, env = {}) {
  // Execute exactly the printed shell syntax, substituting only the local binary.
  assert.ok(command.startsWith('square '));
  return spawnSync('/bin/sh', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ${command.slice(7)}`], {
    cwd: ROOT, encoding: 'utf8', env: testEnv(env), timeout: 10000,
  });
}

async function says(file) {
  const square = await Square.at({ path: file });
  try { return (await square.history({ limit: 100 })).filter((activity) => activity.kind === 'say'); }
  finally { await square.close(); }
}

test('recipient and reply rejections keep exact stdin and intended metadata without choosing a different target', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    await square.join('Bob');
  });
  for (const [target, reply] of [['Bobb', 'act/0'], ['Bob!', 'act/0'], ['Bob', 'act/999'], ['Bob', 'not-an-id']]) {
    const body = `first line for ${target}\r\nsecond line with 'quotes'\r\n`;
    const result = run(withName(file, 'Alice', ['express', '--no-wait', '--mention', target, '--reply', reply, '-']), { input: body });
    assert.equal(result.status, 2, result.stderr);
    const saved = recovery(result, body);
    assert.equal(saved.commands.length, 1);
    assert.match(saved.commands[0], /express --no-wait/);
    assert.ok(saved.commands[0].includes(`--mention '${target}'`));
    assert.ok(saved.commands[0].includes(`--reply ${reply === 'not-an-id' ? "'not-an-id'" : reply}`));
    assert.doesNotMatch(saved.commands[0], /--force/);
    assert.match(saved.output, /participants/);
    assert.match(saved.output, /history --limit 10/);
    assert.match(saved.output, /correct the problem above before retrying/);
    assert.equal((await says(file)).length, 0);
  }
});

test('bell quota preserves a retryable draft, bell reach, reply and no-wait', shellReplay, async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    await square.join('Bob');
    await alice.express('first bell', { reach: 'bell' });
  });
  const body = 'second bell\n';
  const saved = recovery(run(withName(file, 'Alice', ['express', '--no-wait', '--bell', '--reply', 'act/0', '-']), {
    input: body, env: { SQUARE_NOW_MS: '7000' },
  }), body);
  assert.match(saved.output, /the bell stays quiet for now/);
  assert.match(saved.commands[0], /express --no-wait --bell --reply act\/0 -/);
  assert.doesNotMatch(saved.commands[0], /--force/);
  const retry = executeRecovery(saved.commands[0], { SQUARE_NOW_MS: String((await says(file))[0].at + 3600001) });
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  const last = (await says(file)).at(-1);
  assert.equal(last.body, body.trim());
  assert.equal(last.reach, 'bell');
  assert.equal(last.reply, 'act/0');
});

test('held recovery preserves the original force choice and no-wait without widening reach', shellReplay, async () => {
  for (const force of [false, true]) {
    const file = await persistSquare(async ({ square }) => {
      await square.join('Alice');
      const bob = await square.join('Bob');
      await bob.hold('pause');
    });
    const body = `held ${force}\n`;
    const saved = recovery(run(withName(file, 'Alice', ['express', ...(force ? ['--force'] : []), '--no-wait', '--mention', 'Bob', '--reply', 'act/0', '-']), { input: body }), body);
    assert.equal(saved.commands.length, 1);
    assert.equal(saved.commands[0].includes('--force'), force);
    assert.match(saved.commands[0], /--no-wait --mention 'Bob' --reply act\/0 -/);
    const stillHeld = executeRecovery(saved.commands[0]);
    assert.equal(stillHeld.status, 1, stillHeld.stderr);
    assert.equal(stillHeld.signal, null);
    assert.equal((await says(file)).length, 0);
    assert.equal(run(withName(file, 'Bob', ['resume'])).status, 0);
    const retry = executeRecovery(saved.commands[0]);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    const last = (await says(file)).at(-1);
    assert.equal(last.body, body.trim());
    assert.deepEqual(last.mentions, ['Bob']);
    assert.equal(last.reply, 'act/0');
  }
});

test('throttle recovery remains no-wait and does not add force', shellReplay, async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    await alice.express('first');
  }, { throttlePerMinute: 1 });
  const body = 'waiting for a lull\n';
  const saved = recovery(run(withName(file, 'Alice', ['express', '--no-wait', '--no-mention', '-']), { input: body, env: { SQUARE_NOW_MS: '3000' } }), body);
  assert.match(saved.commands[0], /express --no-wait --no-mention -/);
  const stillThrottled = executeRecovery(saved.commands[0], { SQUARE_NOW_MS: '3000' });
  assert.equal(stillThrottled.status, 1, stillThrottled.stderr);
  assert.equal(stillThrottled.signal, null);
  const retry = executeRecovery(saved.commands[0], { SQUARE_NOW_MS: String((await says(file))[0].at + 60001) });
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal((await says(file)).at(-1).body, body.trim());
});

test('behind recovery offers catch then an ordinary retry and labels force as optional', shellReplay, async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    const bob = await square.join('Bob');
    await bob.express('question', { mentions: ['Alice'] });
  });
  const body = 'answer\n';
  const saved = recovery(run(withName(file, 'Alice', ['express', '--no-wait', '--mention', 'Bob', '--reply', 'act/2', '-']), { input: body }), body);
  assert.equal(saved.commands.length, 2);
  assert.doesNotMatch(saved.commands[0], /--force/);
  assert.match(saved.commands[0], /--no-wait --mention 'Bob' --reply act\/2 -/);
  assert.match(saved.output, /optional: express over unread activity with --force/);
  assert.match(saved.commands[1], /express --force --no-wait --mention 'Bob' --reply act\/2 -/);
  assert.ok(saved.output.indexOf('catch --now') < saved.output.indexOf(saved.commands[0]));
  assert.equal(executeRecovery(saved.commands[0]).status, 1);
  assert.equal(run(withName(file, 'Alice', ['catch', '--now'])).status, 0);
  assert.equal(executeRecovery(saved.commands[0]).status, 0);
  assert.equal((await says(file)).at(-1).reply, 'act/2');
});

test('retry commands quote shell data and keep every original recipient', () => {
  const command = activityRetryCommand("/tmp/a 'square'.square", 'Alice', {
    mentions: ['team/Bob', 'Cara'], reply: 'act/12', noWait: true, force: true,
  });
  assert.match(command, /express --force --no-wait --mention 'team\/Bob' --mention 'Cara' --reply act\/12 -$/);
  assert.ok(command.includes("'\\''"));
});

test('only admission rejection proves a failed express unsent; post-commit failure never suggests sending again', async () => {
  const square = buildMemorySquare({ markdown: 'test' });
  await join(square, 'Alice');
  await assert.rejects(express(square, 'Alice', 'bad target', { mentions: ['Nobody'] }), (error) => error.facts?.activityUnsent === true);
  const transact = square.artifact.transact.bind(square.artifact);
  square.artifact.transact = async (...args) => {
    await transact(...args);
    throw new SquareError('invalid_args', 'injected failure after the commit');
  };
  await assert.rejects(express(square, 'Alice', 'actually committed'), (error) => error.code === 'invalid_args' && error.facts?.activityUnsent !== true);
  assert.equal((await square.artifact.read()).state.acts.at(-1).body, 'actually committed');
  for (const landedId of [undefined, 'act/1']) {
    const rendered = renderActivityUncertain({ squarePath: '/tmp/test.square', name: 'Alice', draftPath: '/tmp/draft.md', landedId });
    assert.match(rendered, /sending it again could repeat your activity/);
    assert.match(rendered, /history .*--no-truncate/);
    assert.doesNotMatch(rendered, / express |--force|< '\/tmp\/draft.md'/);
  }
  await square.artifact.close();
});
