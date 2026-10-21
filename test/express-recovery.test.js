import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { activityRetryCommand, executeExpression } from '../dist/cli/express-presentation.js';
import { renderActivityUncertain } from '../dist/presentation.js';
import { SquareError } from '../dist/model.js';
import { buildMemorySquare } from '../dist/open-square.js';
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
  try { return ((await square.history({ limit: 100 })).activities).filter((activity) => activity.kind === 'say'); }
  finally { await square.close(); }
}

test('a refused recipient is dropped from the printed retry instead of being suggested again', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    await square.join('Bob');
  });
  // Both are valid names that simply stand nowhere; an invalid name is a different refusal.
  for (const target of ['Bobb', 'Ghost']) {
    const body = `first line for ${target}\r\nsecond line with 'quotes'\r\n`;
    const result = run(withName(file, 'Alice', ['express', '--no-wait', '--mention', target, '--reply', 'act/0', '-']), { input: body });
    assert.equal(result.status, 2, result.stderr);
    const saved = recovery(result, body);
    assert.equal(saved.commands.length, 1);
    assert.doesNotMatch(saved.commands[0], /--no-mention/);
    assert.doesNotMatch(saved.commands[0], /--mention/);
    assert.doesNotMatch(saved.commands[0], /--force/);
    assert.match(saved.output, /participants/);
    // The refused name came from a flag, so the body carries no @name to edit.
    assert.match(saved.output, /retry without explicit recipients/);
    assert.doesNotMatch(saved.output, /must be removed or wrapped in backticks/);
    assert.doesNotMatch(saved.output, /keep your intended recipients/);
    assert.equal((await says(file)).length, 0);
  }
});

test('missing and malformed replies are dropped from runnable recovery while recipients and raw drafts survive', shellReplay, async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    await square.join('Bob');
  });
  for (const reply of ['act/999', 'not-an-id']) {
    const body = `reply body \r\nwith 'quotes'\r\n`;
    const before = (await says(file)).length;
    const result = run(withName(file, 'Alice', ['express', '--no-wait', '--no-mention', '--mention', 'Bob', '--reply', reply, '-']), { input: body });
    assert.equal(result.status, 2, result.stderr);
    const saved = recovery(result, body);
    assert.equal(saved.commands.length, 1);
    assert.match(saved.commands[0], /express --no-wait/);
    assert.ok(saved.commands[0].includes("--mention 'Bob' --no-mention"));
    assert.doesNotMatch(saved.commands[0], /--reply|--force/);
    assert.match(saved.output, /history --limit 10/);
    assert.match(saved.output, /choose a valid --reply from history, or send without a reply/);
    if (reply === 'act/999') {
      assert.match(saved.output, /Invalid --reply: act\/999 is not in this square's history/);
      assert.doesNotMatch(saved.output, /expected an activity id like act\/12/);
    } else {
      assert.match(saved.output, /Invalid --reply: expected an activity id like act\/12/);
    }
    assert.equal((await says(file)).length, before);
    const retry = executeRecovery(saved.commands[0]);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    const landed = await says(file);
    assert.equal(landed.length, before + 1);
    assert.equal(landed.at(-1).body, body.replace(/\r\n/g, '\n').trim());
    assert.deepEqual(landed.at(-1).mentions, ['Bob']);
    assert.equal(landed.at(-1).reply, undefined);
  }
});

test('invalid reply recovery retains body candidates without forcing a bare selector', shellReplay, async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    await square.join('Bob');
  }, { hardCap: null });
  const cases = [
    ['act/999', '@Bob\n'],
    ['not-an-id', '@Bob\n'],
    ['act/999', '@Eve\n'],
    ['act/999', 'reply only\n'],
    ['not-an-id', '`@Bob` user@Bob.com https://example.com/@Bob\n'],
  ];
  for (const [reply, body] of cases) {
    const saved = recovery(run(withName(file, 'Alice', ['express', '--reply', reply, '-']), { input: body }), body);
    assert.equal(saved.commands.length, 1);
    assert.doesNotMatch(saved.commands[0], /--reply/);
    assert.doesNotMatch(saved.commands[0], /--no-mention/);
    const retry = executeRecovery(saved.commands[0]);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.deepEqual((await says(file)).at(-1).mentions, body === '@Bob\n' ? ['Bob'] : []);
  }
});

test('explicit bell conflict repairs flags without asking for body edits', shellReplay, async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    await square.join('Bob');
  });
  const body = '@Bob @Eve\n';
  const saved = recovery(run(withName(file, 'Alice', ['express', '--bell', '--no-mention', '--mention', 'Bob', '--reply', 'act/1', '-']), { input: body }), body);
  assert.match(saved.output, /a bell cannot be combined with a mention/);
  assert.doesNotMatch(saved.output, /edit the draft|removed or wrapped/);
  assert.match(saved.commands[0], /--bell --no-mention --reply act\/1/);
  assert.doesNotMatch(saved.commands[0], /--mention /);
  const retry = executeRecovery(saved.commands[0]);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.doesNotMatch(retry.stdout, /isn't standing/);
  assert.equal((await says(file)).at(-1).reach, 'bell');
});

test('bell quota preserves a retryable draft, bell reach, reply and no-wait', shellReplay, async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = (await square.join('Alice')).participant;
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
      const bob = (await square.join('Bob')).participant;
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
    const alice = (await square.join('Alice')).participant;
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
    const bob = (await square.join('Bob')).participant;
    await bob.express('question', { mentions: ['Alice'] });
  });
  const body = 'answer\n';
  const saved = recovery(run(withName(file, 'Alice', ['express', '--no-wait', '--mention', 'Bob', '--reply', 'act/2', '-']), { input: body }), body);
  assert.equal(saved.commands.length, 2);
  assert.doesNotMatch(saved.commands[0], /--force/);
  assert.match(saved.commands[0], /--no-wait --mention 'Bob' --reply act\/2 -/);
  assert.match(saved.output, /optional: express over unread activity with --force/);
  assert.match(saved.commands[1], /express --force --no-wait --mention 'Bob' --reply act\/2 -/);
  assert.match(saved.output, /catch\n  · take it in, then retry:/);
  assert.doesNotMatch(saved.output, /catch --now/);
  assert.ok(saved.output.indexOf('catch') < saved.output.indexOf(saved.commands[0]));
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
  assert.equal((await square.artifact.read((facts) => facts.activity(facts.header().lastActIndex))).value.body, 'actually committed');
  for (const landedId of [undefined, 'act/1']) {
    const rendered = renderActivityUncertain({ squarePath: '/tmp/test.square', name: 'Alice', draftPath: '/tmp/draft.md', landedId });
    assert.match(rendered, /sending it again could repeat your activity/);
    assert.match(rendered, /history .*--no-truncate/);
    assert.doesNotMatch(rendered, / express |--force|< '\/tmp\/draft.md'/);
  }
  await square.artifact.close();
});

test('a failed observation clock cannot prevent raw draft saving or landed reconciliation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-draft-clock-'));
  const file = path.join(root, 'SQUARE.square');
  const raw = "  exact raw body\r\nwith 'quotes'\r\n";
  const clockFailure = new Error('projection clock unavailable');
  const error = Object.assign(new Error(clockFailure.message), {
    operation: { operation: 'express', participant: 'Alice', expressEffect: 'landed', landedId: 'act/2' },
  });
  let output = '';
  const stderr = t.mock.method(process.stderr, 'write', (text) => { output += text; return true; });
  const previousExit = process.exitCode;
  let draftAtRecovery;
  try {
    await executeExpression(async () => ({
      async participant() { return { name: 'Alice', async express() { throw error; } }; },
      async close() {},
      async recovery() {
        const drafts = fs.readdirSync(path.join(root, 'drafts'));
        draftAtRecovery = fs.readFileSync(path.join(root, 'drafts', drafts[0]), 'utf8');
        throw clockFailure;
      },
    }), file, 'Alice', raw, { noMention: true });
    assert.equal(process.exitCode, 1);
    assert.equal(draftAtRecovery, raw);
    assert.equal(fs.readFileSync(draftPathFrom(output), 'utf8'), raw);
    assert.match(output, /act\/2/);
    assert.match(output, /history .*--no-truncate/);
    assert.doesNotMatch(output, / express |--force|< /);
  } finally {
    stderr.mock.restore();
    process.exitCode = previousExit;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Ctrl-C cancels the initial express open while SQLite is locked and keeps the raw draft', shellReplay, async () => {
  const file = await persistSquare(async ({ square }) => { await square.join('Alice'); });
  const database = new DatabaseSync(file);
  database.exec('BEGIN EXCLUSIVE');
  const body = 'raw locked body\r\n';
  const child = spawn(process.execPath, [CLI, ...withName(file, 'Alice', ['express', '--no-mention', '-'])], {
    cwd: ROOT, env: testEnv(), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'exit');
  child.stdin.end(body);
  // Let module loading complete and the open reach its cancellable SQLite retry.
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.kill('SIGINT');
  // Recovery is deliberately uncancelled: it may reopen only after the lock releases.
  const draftDirectory = path.join(path.dirname(file), 'drafts');
  const deadline = Date.now() + 1500;
  while (!fs.existsSync(draftDirectory) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  const savedWhileLocked = fs.existsSync(draftDirectory);
  database.exec('ROLLBACK');
  database.close();
  let timeout;
  try {
    const [code] = await Promise.race([exited, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('express open ignored Ctrl-C')), 3000);
    })]);
    assert.equal(savedWhileLocked, true, 'cancelling the initial open must save the draft before recovery can acquire the lock');
    assert.equal(code, 130, stdout + stderr);
    assert.equal(fs.readFileSync(draftPathFrom(stdout + stderr), 'utf8'), body);
    assert.equal((await says(file)).length, 0);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('selected artifact corruption never advertises a safely unsent activity', async () => {
  const file = await persistSquare(async ({ square }) => {
    const writer = (await square.join('Writer')).participant;
    await writer.express('original', { force: true });
  });
  const database = new DatabaseSync(file);
  const before = database.prepare('SELECT revision, next_act_index FROM square_meta').get();
  database.prepare('UPDATE activities SET payload_json=? WHERE act_index=1').run('{"body":42}');
  database.close();
  const square = await Square.at({ path: file });
  try {
    const writer = (await square.join('Writer')).participant;
    await assert.rejects(writer.express('reply', { force: true, reply: 'act/1' }),
      (error) => error.code === 'invalid_args' && error.facts?.activityUnsent !== true);
  } finally { await square.close(); }
  const after = new DatabaseSync(file);
  try { assert.deepEqual(after.prepare('SELECT revision, next_act_index FROM square_meta').get(), before); }
  finally { after.close(); }
});
