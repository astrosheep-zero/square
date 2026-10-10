import assert from 'node:assert/strict';
import test from 'node:test';

import { loadSquare, emptyRuntimeState } from '../dist/artifact.js';
import { decideAct } from '../dist/decisions.js';
import { scanMentionCandidates } from '../dist/mention-parse.js';
import { activityRetryCommand } from '../dist/activity.js';
import { Square } from '../dist/index.js';
import { persistSquare, run, withName } from './square-cli-helpers.js';

function makeState(overrides = {}) {
  const acts = (overrides.acts ?? []).map((act, index) => ({ ...act, index }));
  return {
    hardCap: 'hardCap' in overrides ? overrides.hardCap : null,
    throttlePerMinute: overrides.throttlePerMinute,
    preamble: [],
    warmup: ['warmup'],
    acts,
    runtime: overrides.runtime ?? { ...emptyRuntimeState(acts.length), nextActIndex: acts.length },
  };
}

const standingState = () => makeState({
  acts: [
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'join', actor: 'Cara', at: 3 },
  ],
});

test('scanMentionCandidates honors boundaries, code spans, and the name grammar', () => {
  const cases = [
    ['hello @rei', ['rei']],
    ['hello @rei, and @aoi!', ['rei', 'aoi']],
    ['@rei at the start', ['rei']],
    ['告诉@rei这个', ['rei这个']],
    ['，@rei。', ['rei']],
    ['(@rei)', ['rei']],
    ['mail user@host.com now', []],
    ['see https://x.com/@user', []],
    ['abc@rei', []],
    ['x_@rei', []],
    ['-@rei', []],
    ['@@rei', []],
    ['use `@rei` here', []],
    ['`` [see @rei] ``', []],
    ['```\n@rei\n```', []],
    ['```js\nconst x = `@decorator`\n```', []],
    ['`unmatched backtick @rei', ['rei']],
    ['@aku/riko-2 hi', ['aku/riko-2']],
    ['@🦆 hi', ['🦆']],
    ['@Rei and @rei', ['Rei']],
  ];
  for (const [body, expected] of cases) {
    assert.deepEqual(scanMentionCandidates(body).map((candidate) => candidate.token), expected, JSON.stringify(body));
  }
});

test('decideAct lifts a roster-matching body @name into mentions at landing', () => {
  const decision = decideAct(standingState(), { name: 'Alice', body: 'hey @bob', force: true, now: 10 });
  assert.equal(decision.type, 'sent');
  assert.deepEqual(decision.act.mentions, ['Bob']);
});

test('a roster match may end at a CJK boundary but never at an ASCII one', () => {
  const state = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'rei', at: 2 },
      { kind: 'join', actor: '小明', at: 3 },
    ],
  });
  const fluent = decideAct(state, { name: 'Alice', body: '告诉@rei这个', force: true, now: 10 });
  assert.deepEqual(fluent.act.mentions, ['rei']);
  const cjkName = decideAct(state, { name: 'Alice', body: '@小明早上好', force: true, now: 11 });
  assert.deepEqual(cjkName.act.mentions, ['小明']);
  assert.throws(
    () => decideAct(state, { name: 'Alice', body: '@小明abc', force: true, now: 12 }),
    (error) => /does not match anyone in this square/.test(error.message),
  );
});

test('decideAct never backs off to a shorter roster prefix', () => {
  assert.throws(
    () => decideAct(standingState(), { name: 'Alice', body: 'hey @Bob2', force: true, now: 10 }),
    (error) => /@Bob2 does not match anyone in this square/.test(error.message),
  );
});

test('body @names union with --mention and dedupe case-insensitively', () => {
  const decision = decideAct(standingState(), { name: 'Alice', body: '@Bob and @cara', force: true, now: 10, mentions: ['Cara'] });
  assert.equal(decision.type, 'sent');
  assert.deepEqual(decision.act.mentions, ['Cara', 'Bob']);
});

test('an unmatched body @name is rejected with a two-tier message and an escape hint', () => {
  const state = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'Bob', at: 2 },
      { kind: 'done', actor: 'Bob', at: 3 },
    ],
  });
  assert.throws(
    () => decideAct(state, { name: 'Alice', body: '@Bob @Eve listen up', force: true, now: 10 }),
    (error) => /@Eve does not match anyone in this square/.test(error.message)
      && /@Bob is not standing in this square/.test(error.message)
      && /--no-mention/.test(error.message)
      && /backticks/.test(error.message),
  );
});

test('explicit noMention switches body scanning off entirely', () => {
  const decision = decideAct(standingState(), { name: 'Alice', body: 'hey @Bob', force: true, now: 10, noMention: true });
  assert.equal(decision.type, 'sent');
  assert.deepEqual(decision.act.mentions, []);
});

test('a bell rejects a body @name but tolerates unmatched at-sign text', () => {
  assert.throws(
    () => decideAct(standingState(), { name: 'Alice', body: 'look @Bob', force: true, now: 10, reach: 'bell' }),
    (error) => /bell cannot be combined with a mention/.test(error.message),
  );
  const decision = decideAct(standingState(), { name: 'Alice', body: 'look @decorator fans', force: true, now: 10, reach: 'bell' });
  assert.equal(decision.type, 'sent');
  assert.deepEqual(decision.act.mentions, []);
  assert.equal(decision.act.reach, 'bell');
});

test('body @names share the mention limit with --mention', () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 0 },
    ...Array.from({ length: 10 }, (_, index) => ({ kind: 'join', actor: `P${index + 1}`, at: index + 1 })),
    { kind: 'join', actor: 'Bob', at: 12 },
  ];
  assert.throws(
    () => decideAct(makeState({ acts }), {
      name: 'Alice', body: 'and @Bob', force: true, now: 20,
      mentions: Array.from({ length: 10 }, (_, index) => `P${index + 1}`),
    }),
    (error) => /at most 10 participants/.test(error.message),
  );
});

test('express through the library stores derived mention metadata', async () => {
  const square = Square.inMemory({ markdown: 'context' });
  try {
    const alice = await square.join('Alice');
    const bob = await square.join('Bob');
    const directed = await alice.express('hey @Bob', { force: true });
    assert.deepEqual(directed.activity.mentions, ['Bob']);
    const bare = await alice.express('hey @Bob', { force: true, noMention: true });
    assert.deepEqual(bare.activity.mentions, []);
    const caught = await bob.catch();
    assert.deepEqual(caught.activities.map((activity) => activity.id), [directed.activity.id]);
  } finally {
    await square.close();
  }
});

test('activityRetryCommand preserves the caller reach instead of forcing --no-mention', () => {
  assert.match(activityRetryCommand('/tmp/x.square', 'Alice', { noMention: true }), / --no-mention /);
  const derived = activityRetryCommand('/tmp/x.square', 'Alice', {});
  assert.doesNotMatch(derived, /--no-mention|--mention|--bell/);
  assert.match(activityRetryCommand('/tmp/x.square', 'Alice', { mentions: ['Bob'] }), / --mention 'Bob'/);
  assert.match(activityRetryCommand('/tmp/x.square', 'Alice', { reach: 'bell' }), / --bell/);
});

test('the CLI lands a body @name with a reach echo and rejects unknown names', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    await square.join('Bob');
  });

  const directed = run(withName(file, 'Alice', ['express', 'hey @Bob']));
  assert.equal(directed.status, 0, directed.stderr);
  assert.match(directed.stdout, /● you walk over to @Bob — act\/\d+/);
  let acts = (await loadSquare(file)).acts;
  assert.deepEqual(acts.at(-1).mentions, ['Bob']);

  const bare = run(withName(file, 'Alice', ['express', '--no-mention', 'hey @Bob']));
  assert.equal(bare.status, 0, bare.stderr);
  acts = (await loadSquare(file)).acts;
  assert.deepEqual(acts.at(-1).mentions, []);

  const unknown = run(withName(file, 'Alice', ['express', 'hey @Eve']));
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /@Eve does not match anyone in this square/);

  const piped = run(withName(file, 'Alice', ['express', '-']), { input: 'piped @Bob' });
  assert.equal(piped.status, 0, piped.stderr);
  assert.match(piped.stdout, /● you walk over to @Bob — act\/\d+/);

  const pipedBare = run(withName(file, 'Alice', ['express', '-']), { input: 'no audience here' });
  assert.equal(pipedBare.status, 2);
  assert.match(pipedBare.stderr, /express needs --mention <name>, --no-mention, --bell, or an @name in the body/);
});
