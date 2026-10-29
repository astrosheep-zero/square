import assert from 'node:assert/strict';
import test from 'node:test';

import { createArtifactPort, readSquareSnapshot } from '../dist/artifact.js';
import { emptyRuntimeState } from '../dist/square-sqlite.js';
import { decideAct } from '../dist/decisions.js';
import { scanMentionCandidates } from '../dist/mention-parse.js';
import { activityRetryCommand } from '../dist/cli/express-presentation.js';
import { Square } from '../dist/square-api.js';
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

async function decide(state, input) {
  const cell = createArtifactPort(':memory:', state);
  try { return (await cell.read((facts) => decideAct(facts, input))).value; }
  finally { await cell.close(); }
}

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
    ['🦆@rei', ['rei']],
  ];
  for (const [body, expected] of cases) {
    assert.deepEqual(scanMentionCandidates(body), expected, JSON.stringify(body));
  }
});

test('decideAct lifts a roster-matching body @name into mentions at landing', async () => {
  const decision = await decide(standingState(), { name: 'Alice', body: 'hey @bob', force: true, now: 10 });
  assert.equal(decision.type, 'sent');
  assert.deepEqual(decision.act.mentions, ['Bob']);
});

test('a roster match may end at a CJK boundary but never at an ASCII one', async () => {
  const state = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'rei', at: 2 },
      { kind: 'join', actor: '小明', at: 3 },
    ],
  });
  const fluent = await decide(state, { name: 'Alice', body: '告诉@rei这个', force: true, now: 10 });
  assert.deepEqual(fluent.act.mentions, ['rei']);
  const cjkName = await decide(state, { name: 'Alice', body: '@小明早上好', force: true, now: 11 });
  assert.deepEqual(cjkName.act.mentions, ['小明']);
  const literal = await decide(state, { name: 'Alice', body: '@小明abc', force: true, now: 12 });
  assert.deepEqual(literal.act.mentions, []);
  assert.equal(literal.act.body, '@小明abc');
});

test('decideAct keeps unmatched text without backing off to a shorter roster prefix', async () => {
  const decision = await decide(standingState(), { name: 'Alice', body: 'hey @Bob2', force: true, now: 10 });
  assert.equal(decision.type, 'sent');
  assert.equal(decision.act.body, 'hey @Bob2');
  assert.deepEqual(decision.act.mentions, []);
});

test('body @names union with --mention and dedupe case-insensitively', async () => {
  const decision = await decide(standingState(), { name: 'Alice', body: '@Bob and @cara', force: true, now: 10, mentions: ['Cara'] });
  assert.equal(decision.type, 'sent');
  assert.deepEqual(decision.act.mentions, ['Cara', 'Bob']);
});

test('unknown and departed body @names stay literal while standing matches still receive', async () => {
  const state = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'Bob', at: 2 },
      { kind: 'done', actor: 'Bob', at: 3 },
      { kind: 'join', actor: 'Cara', at: 4 },
    ],
  });
  const body = '@Bob @Eve @Cara listen up';
  const decision = await decide(state, { name: 'Alice', body, force: true, now: 10 });
  assert.equal(decision.type, 'sent');
  assert.equal(decision.act.body, body);
  assert.deepEqual(decision.act.mentions, ['Cara']);
  assert.deepEqual(decision.unmatchedMentions, ['Bob', 'Eve']);
  const literal = await decide(state, { name: 'Alice', body: '@Bob @Eve', force: true, now: 11 });
  assert.equal(literal.type, 'sent');
  assert.equal(literal.act.body, '@Bob @Eve');
  assert.deepEqual(literal.act.mentions, []);
});

test('bare activity is valid without a recipient and remains available to listeners', async () => {
  const state = standingState();
  const decision = await decide(state, { name: 'Alice', body: 'ordinary thought', force: true, now: 10 });
  assert.equal(decision.type, 'sent');
  assert.deepEqual(decision.act.mentions, []);
});

test('noMention disables only body scanning, not explicit mentions or reply', async () => {
  const decision = await decide(standingState(), { name: 'Alice', body: 'hey @Bob @Eve', force: true, now: 10, noMention: true, mentions: ['cara'], reply: 1 });
  assert.equal(decision.type, 'sent');
  assert.deepEqual(decision.act.mentions, ['Cara']);
  assert.equal(decision.act.reply, 1);
  assert.equal(decision.unmatchedMentions, undefined);
});

test('a bell ignores all body candidates but rejects explicit mentions in core', async () => {
  await assert.rejects(
    () => decide(standingState(), { name: 'Alice', body: 'look @Bob', force: true, now: 10, reach: 'bell', mentions: ['Bob'] }),
    (error) => error.facts?.reason === 'bell_mention_conflict',
  );
  const decision = await decide(standingState(), { name: 'Alice', body: 'look @Bob @decorator', force: true, now: 10, reach: 'bell', noMention: true, reply: 1 });
  assert.equal(decision.type, 'sent');
  assert.deepEqual(decision.act.mentions, []);
  assert.equal(decision.act.reach, 'bell');
  assert.equal(decision.act.reply, 1);
  assert.equal(decision.unmatchedMentions, undefined);
  const scannedOff = await decide(standingState(), { name: 'Alice', body: '@Bob @Eve', force: true, now: 10, reach: 'bell' });
  assert.deepEqual(scannedOff.act.mentions, []);
  assert.equal(scannedOff.unmatchedMentions, undefined);
});

test('body @names share the mention limit with --mention', async () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 0 },
    ...Array.from({ length: 10 }, (_, index) => ({ kind: 'join', actor: `P${index + 1}`, at: index + 1 })),
    { kind: 'join', actor: 'Bob', at: 12 },
  ];
  await assert.rejects(
    () => decide(makeState({ acts }), {
      name: 'Alice', body: 'and @Bob', force: true, now: 20,
      mentions: Array.from({ length: 10 }, (_, index) => `P${index + 1}`),
    }),
    (error) => /at most 10 participants/.test(error.message),
  );
});

test('express through the library stores derived mention metadata', async () => {
  const body = "test" + ":" + ('body-mentions');
  const square = Square.inMemory({ markdown: 'context' });
  try {
    const alice = (await square.join('Alice', { owner: body })).participant;
    const bob = (await square.join('Bob', { owner: body })).participant;
    const directed = await alice.express('hey @Bob and @Unknown', { force: true });
    assert.deepEqual(directed.activity.mentions, ['Bob']);
    assert.deepEqual(directed.unmatchedMentions, ['Unknown']);
    assert.equal(directed.activity.unmatchedMentions, undefined);
    assert.equal(((await square.history({ limit: null })).activities).at(-1).unmatchedMentions, undefined);
    assert.equal(directed.activity.body, 'hey @Bob and @Unknown');
    const literal = await alice.express('hey @Unknown', { force: true });
    assert.deepEqual(literal.activity.mentions, []);
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
  assert.match(activityRetryCommand('/tmp/x.square', 'Alice', { mentions: ['Cara'], noMention: true }), / --mention 'Cara' --no-mention /);
  assert.match(activityRetryCommand('/tmp/x.square', 'Alice', { reach: 'bell', noMention: true }), / --bell --no-mention /);
  const derived = activityRetryCommand('/tmp/x.square', 'Alice', {});
  assert.doesNotMatch(derived, /--no-mention|--mention|--bell/);
  assert.match(activityRetryCommand('/tmp/x.square', 'Alice', { mentions: ['Bob'] }), / --mention 'Bob'/);
  assert.match(activityRetryCommand('/tmp/x.square', 'Alice', { reach: 'bell' }), / --bell/);
});

test('the CLI lands matched and unmatched body @names without rewriting the body', async () => {
  const file = await persistSquare(async ({ square, body }) => {
    await square.join('Alice', { owner: body });
    await square.join('Bob', { owner: body });
  }, { hardCap: null });

  const directed = run(withName(file, 'Alice', ['express', 'hey @Bob']));
  assert.equal(directed.status, 0, directed.stderr);
  assert.match(directed.stdout, /● you walk over to @Bob — act\/\d+/);
  let acts = (await readSquareSnapshot(file)).state.acts;
  assert.deepEqual(acts.at(-1).mentions, ['Bob']);

  const bare = run(withName(file, 'Alice', ['express', '--no-mention', 'hey @Bob']));
  assert.equal(bare.status, 0, bare.stderr);
  acts = (await readSquareSnapshot(file)).state.acts;
  assert.deepEqual(acts.at(-1).mentions, []);

  const unknown = run(withName(file, 'Alice', ['express', 'hey @Eve']));
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.match(unknown.stdout, /@Eve isn't standing here — activity landed bare/);
  acts = (await readSquareSnapshot(file)).state.acts;
  assert.equal(acts.at(-1).body, 'hey @Eve');
  assert.deepEqual(acts.at(-1).mentions, []);

  const mixed = run(withName(file, 'Alice', ['express', '-']), { input: 'hello @Eve and @Bob' });
  assert.equal(mixed.status, 0, mixed.stderr);
  assert.match(mixed.stdout, /@Eve isn't standing here — left as literal text/);
  assert.doesNotMatch(mixed.stdout, /landed bare/);
  acts = (await readSquareSnapshot(file)).state.acts;
  assert.equal(acts.at(-1).body, 'hello @Eve and @Bob');
  assert.deepEqual(acts.at(-1).mentions, ['Bob']);

  const pipedUnknown = run(withName(file, 'Alice', ['express', '-']), { input: 'hello @Ghost\nstill here' });
  assert.equal(pipedUnknown.status, 0, pipedUnknown.stderr);
  acts = (await readSquareSnapshot(file)).state.acts;
  assert.equal(acts.at(-1).body, 'hello @Ghost\nstill here');
  assert.deepEqual(acts.at(-1).mentions, []);

  const piped = run(withName(file, 'Alice', ['express', '-']), { input: 'piped @Bob' });
  assert.equal(piped.status, 0, piped.stderr);
  assert.match(piped.stdout, /● you walk over to @Bob — act\/\d+/);

  const replyUnknown = run(withName(file, 'Alice', ['express', '--reply', 'act/1', '@Eve']));
  assert.equal(replyUnknown.status, 0, replyUnknown.stderr);
  assert.match(replyUnknown.stdout, /@Eve isn't standing here — left as literal text/);
  assert.doesNotMatch(replyUnknown.stdout, /landed bare/);

  const explicit = run(withName(file, 'Alice', ['express', '--no-mention', '--mention', 'Bob', '@Eve']));
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /you walk over to @Bob/);
  assert.doesNotMatch(explicit.stdout, /isn't standing/);

  const pipedBare = run(withName(file, 'Alice', ['express', '-']), { input: 'no audience here' });
  assert.equal(pipedBare.status, 0, pipedBare.stderr);
  assert.match(pipedBare.stdout, /your words land/);
});
