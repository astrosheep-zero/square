import assert from 'node:assert/strict';
import test from 'node:test';

import { createArtifactPort } from '../dist/artifact/artifact.js';
import { emptyRuntimeState } from '../dist/artifact/square-store.js';
import { decideAct } from '../dist/core/decisions.js';
import { scanMentionCandidates } from '../dist/core/mention-parse.js';
import { activityRetryCommand } from '../dist/cli/express-presentation.js';
import { Square } from '../dist/api/square-api.js';

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

test('unknown and departed targets share soft resolution for explicit mentions and body @names', async () => {
  const state = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'Bob', at: 2 },
      { kind: 'done', actor: 'Bob', at: 3 },
      { kind: 'join', actor: 'Cara', at: 4 },
    ],
  });
  const body = '@Bob @Eve @Cara listen up';
  for (const mentions of [undefined, ['Bob', 'Eve', 'Cara', 'bob', 'eve']]) {
    const decision = await decide(state, { name: 'Alice', body, force: true, now: 10, mentions });
    assert.equal(decision.type, 'sent');
    assert.equal(decision.act.body, body);
    assert.deepEqual(decision.act.mentions, ['Cara']);
    assert.deepEqual(decision.unmatchedMentions, ['Bob', 'Eve']);
  }
});

test('bare activity is valid without a recipient and remains available to listeners', async () => {
  const state = standingState();
  const decision = await decide(state, { name: 'Alice', body: 'ordinary thought', force: true, now: 10 });
  assert.equal(decision.type, 'sent');
  assert.deepEqual(decision.act.mentions, []);
});

test('explicit mentions replace the body scan and still combine with a reply', async () => {
  const decision = await decide(standingState(), { name: 'Alice', body: 'hey @Bob @Eve', force: true, now: 10, mentions: ['cara'], reply: 1 });
  assert.equal(decision.type, 'sent');
  assert.deepEqual(decision.act.mentions, ['Cara']);
  assert.equal(decision.act.reply, 1);
  assert.equal(decision.unmatchedMentions, undefined);
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
    assert.equal(((await square.history()).activities).at(-1).unmatchedMentions, undefined);
    assert.equal(directed.activity.body, 'hey @Bob and @Unknown');
    const literal = await alice.express('hey @Unknown', { force: true });
    assert.deepEqual(literal.activity.mentions, []);
    const bare = await alice.express('hey @Bob', { force: true, mentions: [] });
    assert.deepEqual(bare.activity.mentions, []);
    const perceived = await bob.perceive();
    assert.deepEqual(perceived.activities.map((activity) => activity.id), [directed.activity.id]);
  } finally {
    await square.close();
  }
});

test('departed mentions and replies land, reach standing targets, and never backfill on rejoin', async t => {
  const square = Square.inMemory({ markdown: '' });
  t.after(() => square.close());
  const owner = 'test:departed-mentions';
  const alice = (await square.join('Alice', { owner })).participant;
  const bob = (await square.join('Bob', { owner })).participant;
  const cara = (await square.join('Cara', { owner })).participant;
  const question = await bob.express('question', { force: true });
  await bob.done();

  const sent = await alice.express('answer @Bob @Eve @Cara', {
    mentions: ['Bob', 'Eve', 'Cara'], reply: question.activity.id, force: true,
  });
  assert.deepEqual(sent.activity.mentions, ['Cara']);
  assert.deepEqual(sent.unmatchedMentions, ['Bob', 'Eve']);
  assert.equal(sent.replyAuthorNotHere, 'Bob');
  assert.equal(sent.activity.reply, question.activity.id);
  assert.deepEqual((await cara.perceive()).activities.map(activity => activity.id), [sent.activity.id]);

  const bare = await alice.express('all targets absent', { mentions: ['Bob', 'Eve'], force: true });
  assert.deepEqual(bare.activity.mentions, []);
  assert.deepEqual(bare.unmatchedMentions, ['Bob', 'Eve']);
  assert.equal((await square.history()).activities.at(-1).id, bare.activity.id);

  const returned = (await square.join('Bob', { owner })).participant;
  const newcomer = (await square.join('Eve', { owner })).participant;
  assert.deepEqual((await returned.perceive()).activities, []);
  assert.deepEqual((await newcomer.perceive()).activities, []);
});

test('express repair preserves an explicitly empty mention list', () => {
  assert.match(activityRetryCommand('/tmp/x.square', 'Alice', { mentions: [] }), / --mention '' /);
});
