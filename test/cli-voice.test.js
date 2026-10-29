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
  const args = command.slice(7).match(/(?:'[^']*'|\S+)/g) ?? [];
  const locationIndex = args.findIndex((value) => value === '--location');
  const squarePath = locationIndex >= 0 ? args[locationIndex + 1]?.replace(/^'|'$/g, '') : undefined;
  return spawnSync('/bin/sh', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ${command.slice(7)}`], {
    cwd: ROOT, encoding: 'utf8', env: testEnv({ ...(squarePath === undefined ? {} : { CODEX_THREAD_ID: path.resolve(squarePath) }), ...env }, squarePath), timeout: 10000,
  });
}

function printedCommands(output) {
  return output.split('\n').filter((line) => /^square .* express /.test(line));
}

test('a bell ignores body @names, including unmatched names, with redundant no-mention allowed', async () => {
  const file = await persistSquare(async ({ square, body }) => {
    await square.join('Alice', { owner: body });
    await square.join('Bob', { owner: body });
  });

  const result = run(withName(file, 'Alice', ['express', '--no-wait', '--bell', '--no-mention', '-']), { input: 'ringing for @Bob @Eve\n' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /● you ring the bell/);
  assert.doesNotMatch(result.stdout + result.stderr, /isn't standing|conflict|draft kept/);
});

test('unmatched body @names land; explicit --mention still offers a runnable repair', shellReplay, async () => {
  const file = await persistSquare(async ({ square, body }) => {
    await square.join('Alice', { owner: body });
    await square.join('Bob', { owner: body });
  });

  const result = run(withName(file, 'Alice', ['express', '--no-wait', '-']), { input: 'hello @Nobody\n' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /does not match|not standing|draft kept/);

  // Explicit routing metadata still requires a standing recipient.
  const flag = run(withName(file, 'Alice', ['express', '--no-wait', '--mention', 'Ghost', 'hello there']));
  assert.equal(flag.status, 2, flag.stdout + flag.stderr);
  const flagOutput = flag.stdout + flag.stderr;
  assert.match(flagOutput, /✕ @Ghost is not standing in this square/);
  assert.match(flagOutput, /retry without explicit recipients/);
  assert.doesNotMatch(flagOutput, /must be removed or wrapped in backticks/);
  const flagRetries = printedCommands(flagOutput);
  assert.equal(flagRetries.length, 1);
  assert.doesNotMatch(flagRetries[0], /--no-mention/);
  assert.equal(executePrinted(flagRetries[0]).status, 0);
});

test('catch --id refuses an activity that is not addressed to the caller with ✕ and a runnable read', shellReplay, async () => {
  const file = await persistSquare(async ({ square, body }) => {
    const alice = (await square.join('Alice', { owner: body })).participant;
    await square.join('Bob', { owner: body });
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
  const file = await persistSquare(async ({ square, body }) => {
    await square.join('Alice', { owner: body });
    await square.join('Bob', { owner: body });
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
  const file = await persistSquare(async ({ square, body }) => {
    await square.join('Alice', { owner: body });
    const bob = (await square.join('Bob', { owner: body })).participant;
    await bob.express('question', { force: true, noMention: true });
    await bob.done();
  });

  const result = run(withName(file, 'Alice', ['express', '--force', '--reply', 'act/2', 'answer']));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /● your words land — act\/4/);
  assert.match(result.stdout, /○ @Bob isn't in the square right now — the reply landed without reaching them/);
});

test('unread activity appended to a receipt is explicitly a nonconsuming preview', async () => {
  const file = await persistSquare(async ({ square, body }) => {
    await square.join('Alice', { owner: body });
    const bob = (await square.join('Bob', { owner: body })).participant;
    await bob.express('question for you @Alice', { force: true, mentions: ['Alice'] });
  });

  const result = run(withName(file, 'Alice', ['express', '--force', '--mention', 'Bob', 'answer @Bob']));
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout;
  assert.match(output, /Unread context · preview only, not consumed/);
  const lead = output.indexOf('Unread context · preview only, not consumed');
  const receipt = output.indexOf('● you walk over to @Bob');
  const behind = output.indexOf('question for you @Alice');
  assert.ok(receipt > 0 && lead > receipt && behind > lead, output);
});

test('the throttle refusal names the lull and keeps a retry that runs later', async () => {
  const file = await persistSquare(async ({ square, body }) => {
    const alice = (await square.join('Alice', { owner: body })).participant;
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
  const file = await persistSquare(async ({ square, body }) => {
    const alice = (await square.join('Alice', { owner: body })).participant;
    await alice.express('the one activity', { force: true });
  }, { hardCap: 1 });

  const capped = run(withName(file, 'Alice', ['express', '--mention', 'Alice', '-']), { input: 'one more @Alice\n' });
  assert.equal(capped.status, 1, capped.stdout + capped.stderr);
  assert.match(capped.stdout, /✕ you’ve reached your speaking cap — 1\/1 spoken/);
  assert.match(capped.stdout, /draft kept/);
  assert.match(capped.stdout, /· your draft stays unsent; done only steps out/);
  assert.match(capped.stdout, /done\n$/);
});

test('done speaks in first person and keeps its own act id', async () => {
  const file = await persistSquare(async ({ square, body }) => {
    await square.join('Alice', { owner: body });
    await square.join('Bob', { owner: body });
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
  const file = await persistSquare(async ({ square, body }) => {
    const alice = (await square.join('Alice', { owner: body })).participant;
    await square.join('Bob', { owner: body });
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
