import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { CLI, ROOT, persistSquare, run, tempSquare, testEnv, withName } from './square-cli-helpers.js';

const shellReplay = { skip: process.platform === 'win32' ? 'Printed command replay requires a POSIX shell.' : false };

/** Execute exactly the printed shell syntax, substituting only the local binary. */
function executePrinted(command, env = {}) {
  assert.ok(command.startsWith('square '), command);
  return spawnSync('/bin/sh', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ${command.slice(7)}`], {
    cwd: ROOT, encoding: 'utf8', env: testEnv(env), timeout: 10000,
  });
}

function printedCommands(output) {
  return output.split('\n').filter((line) => /^square .* express /.test(line));
}

test('a held refusal without a reason names the holder and never prints an empty sensory line', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    const bob = await square.join('Bob');
    await bob.hold();
  });

  const held = run(withName(file, 'Alice', ['express', '--no-wait', '--no-mention', 'a thought']));
  assert.equal(held.status, 1, held.stdout + held.stderr);
  assert.match(held.stdout, /✕ @Bob has a hand raised — voices drop, yours too/);
  assert.doesNotMatch(held.stdout, /^\s*·\s*$/m);
  assert.doesNotMatch(held.stdout, /holds its breath/);
});

test('a bell+@name conflict refuses with ✕ and a retry that keeps the bell for the speaker to edit', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    await square.join('Bob');
  });

  const result = run(withName(file, 'Alice', ['express', '--no-wait', '--bell', '-']), { input: 'ringing for @Bob\n' });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const output = result.stdout + result.stderr;
  assert.match(output, /✕ a bell cannot be combined with a mention/);
  assert.match(output, /participants/);
  assert.match(output, /must be removed or wrapped in backticks/);
  const retries = printedCommands(output);
  assert.equal(retries.length, 1);
  assert.match(retries[0], /--bell/);
  assert.doesNotMatch(retries[0], /--mention/);
  assert.doesNotMatch(output, /keep your intended recipients/);
});

test('an unmatched @name refuses with ✕ and a retry that lands as printed', shellReplay, async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    await square.join('Bob');
  });

  const result = run(withName(file, 'Alice', ['express', '--no-wait', '-']), { input: 'hello @Nobody\n' });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const output = result.stdout + result.stderr;
  assert.match(output, /✕ @Nobody does not match anyone in this square/);
  assert.match(output, /participants/);
  assert.match(output, /must be removed or wrapped in backticks/);
  const retries = printedCommands(output);
  assert.equal(retries.length, 1);
  assert.match(retries[0], /--no-mention/);
  assert.doesNotMatch(retries[0], /--mention/);
  assert.doesNotMatch(output, /keep your intended recipients/);

  const replayed = executePrinted(retries[0]);
  assert.equal(replayed.status, 0, replayed.stdout + replayed.stderr);

  // The same refusal from a --mention flag has no @name in the body to edit.
  const flag = run(withName(file, 'Alice', ['express', '--no-wait', '--mention', 'Ghost', 'hello there']));
  assert.equal(flag.status, 2, flag.stdout + flag.stderr);
  const flagOutput = flag.stdout + flag.stderr;
  assert.match(flagOutput, /✕ @Ghost is not standing in this square/);
  assert.match(flagOutput, /pick someone standing here, or land it bare/);
  assert.doesNotMatch(flagOutput, /must be removed or wrapped in backticks/);
  const flagRetries = printedCommands(flagOutput);
  assert.equal(flagRetries.length, 1);
  assert.match(flagRetries[0], /--no-mention/);
  assert.equal(executePrinted(flagRetries[0]).status, 0);
});

test('catch --id refuses an activity that is not addressed to the caller with ✕ and a runnable read', shellReplay, async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    await square.join('Bob');
    await alice.express('for nobody in particular', { force: true, noMention: true });
  });

  const undirected = run(withName(file, 'Bob', ['catch', '--id', 'act/2']));
  assert.equal(undirected.status, 2, undirected.stdout + undirected.stderr);
  assert.match(undirected.stderr, /✕ act\/2 isn't addressed to you/);
  const anchored = undirected.stderr.split('\n').find((line) => /history/.test(line));
  assert.ok(anchored !== undefined, undirected.stderr);
  assert.match(anchored, /history --at act\/2 -C 2/);
  assert.equal(executePrinted(anchored).status, 0);

  const unknown = run(withName(file, 'Bob', ['catch', '--id', 'act/99']));
  assert.equal(unknown.status, 2, unknown.stdout + unknown.stderr);
  assert.match(unknown.stderr, /✕ act\/99 isn't addressed to you/);
  const page = unknown.stderr.split('\n').find((line) => /history/.test(line));
  assert.ok(page !== undefined, unknown.stderr);
  assert.match(page, /history --limit 10/);
  assert.equal(executePrinted(page).status, 0);
});

test('express receipts name the act: words, gesture, walk-over, and the bell', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    await square.join('Bob');
  });

  const words = run(withName(file, 'Alice', ['express', '--no-mention', 'a plain thought']));
  assert.equal(words.status, 0, words.stderr);
  assert.match(words.stdout, /● your words land — act\/\d+/);

  const gesture = run(withName(file, 'Alice', ['express', '--no-mention', '*shrugs slowly*']));
  assert.equal(gesture.status, 0, gesture.stderr);
  assert.match(gesture.stdout, /● your gesture lands — act\/\d+/);

  const walked = run(withName(file, 'Alice', ['express', '--mention', 'Bob', 'hey Bob']));
  assert.equal(walked.status, 0, walked.stderr);
  assert.match(walked.stdout, /● you walk over to @Bob — act\/\d+/);
  assert.doesNotMatch(walked.stdout, /#\d+ · act/);

  const bell = run(withName(file, 'Bob', ['express', '--bell', 'everyone should hear this']));
  assert.equal(bell.status, 0, bell.stderr);
  assert.match(bell.stdout, /● you ring the bell — everyone turns · act\/\d+/);
});

test('a reply to an author who stepped out says the reply did not reach them', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    const bob = await square.join('Bob');
    await bob.express('question', { force: true, noMention: true });
    await bob.done();
  });

  const result = run(withName(file, 'Alice', ['express', '--force', '--reply', 'act/2', 'answer']));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /● your words land — act\/4/);
  assert.match(result.stdout, /○ @Bob isn't in the square right now — the reply landed without reaching them/);
});

test('unread activity appended to a receipt is led by the ▲ line', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    const bob = await square.join('Bob');
    await bob.express('question for you @Alice', { force: true, mentions: ['Alice'] });
  });

  const result = run(withName(file, 'Alice', ['express', '--force', '--mention', 'Bob', 'answer @Bob']));
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout;
  assert.match(output, /▲ while you spoke, @Bob said something behind you/);
  const lead = output.indexOf('▲ while you spoke, @Bob said something behind you');
  const receipt = output.indexOf('● you walk over to @Bob');
  const behind = output.indexOf('question for you @Alice');
  assert.ok(receipt > 0 && lead > receipt && behind > lead, output);
});

test('the throttle refusal names the lull and keeps a retry that runs later', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    await alice.express('first', { force: true });
  }, { throttlePerMinute: 1 });

  const throttled = run(withName(file, 'Alice', ['express', '--no-wait', '--no-mention', 'waiting']), {
    env: { SQUARE_NOW_MS: '3000' },
  });
  assert.equal(throttled.status, 1, throttled.stdout + throttled.stderr);
  assert.match(throttled.stdout, /✕ the square is packed — shoulder to shoulder/);
  assert.match(throttled.stdout, /· a lull opens in (?:\d+s|1m)/);
  assert.doesNotMatch(throttled.stdout, /next opening/);
});

test('a capped express counts what was spoken and keeps the draft and the done command', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    await alice.express('the one activity', { force: true });
  }, { hardCap: 1 });

  const capped = run(withName(file, 'Alice', ['express', '--mention', 'Alice', '-']), { input: 'one more @Alice\n' });
  assert.equal(capped.status, 1, capped.stdout + capped.stderr);
  assert.match(capped.stdout, /✕ nothing left in you — 1\/1 spoken/);
  assert.match(capped.stdout, /draft kept/);
  assert.match(capped.stdout, /· your draft stays unsent; done only steps out/);
  assert.match(capped.stdout, /done\n$/);
});

test('done speaks in first person and keeps its own act id', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    await square.join('Bob');
  });

  const result = run(withName(file, 'Alice', ['done']));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /○ you stepped out — your footsteps fade · act\/\d+/);
  const history = run(withName(file, 'Bob', ['history', '--limit', '10']));
  assert.match(history.stdout, /○ @Alice stepped out of the square — done/);
});

test('build stands ready, and the long scene belongs to a first join only', async () => {
  const file = tempSquare();
  const built = run(['build', '--location', file, '--cap', '3', '--force'], { input: '## Topic\n\nScene\n' });
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /· the square stands ready/);
  assert.doesNotMatch(built.stdout, /the square is open|first join steps in/);

  const first = run(withName(file, 'Alice', ['join']));
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /\*Light\.\*/);
  assert.doesNotMatch(first.stdout, /flagstones are where you left them/);

  assert.equal(run(withName(file, 'Alice', ['done'])).status, 0);
  const returned = run(withName(file, 'Alice', ['join']));
  assert.equal(returned.status, 0, returned.stderr);
  assert.match(returned.stdout, /\*the flagstones are where you left them\. so is your shadow\.\*/);
  assert.doesNotMatch(returned.stdout, /\*Light\.\*/);
});

test('history closes the page with one presence anchor line', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    await square.join('Bob');
    await alice.express('shared coordinate @Bob', { force: true, mentions: ['Bob'] });
  });

  assert.equal(run(withName(file, 'Bob', ['catch', '--now'])).status, 0);
  const history = run(['--location', file, 'history', '--limit', '100']);
  assert.equal(history.status, 0, history.stderr);
  const lines = history.stdout.trimEnd().split('\n');
  const anchors = lines.filter((line) => /→ .* (?:was|were) here/.test(line));
  assert.equal(anchors.length, 1, history.stdout);
  assert.match(anchors[0], /→ @Alice, @Bob were here/);
  assert.equal(lines.at(-1), anchors[0]);
});

test('the retired receipt wording is gone from production sources', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const retired = /holds its breath|glance:|#\$\{ownActCount\}|first join steps in/;
  const files = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name);
  const offenders = files.filter((file) => retired.test(fs.readFileSync(path.join(root, file), 'utf8')));
  assert.deepEqual(offenders, []);
});
