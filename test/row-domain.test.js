import assert from 'node:assert/strict';
import test from 'node:test';

import { decideCatch } from '../dist/catch-decisions.js';
import { readCursor, presenceAnchor } from '../dist/runtime.js';
import { createTestArtifactPort as createArtifactPort } from './fixtures/test-artifact-port.js';

const T0 = 1_700_000_000_000;

function fixtureState(acts, options = {}) {
  const lastIndex = acts.reduce((max, act) => Math.max(max, act.index), -1);
  return {
    hardCap: options.hardCap === undefined ? null : options.hardCap,
    preamble: ['preamble line'],
    warmup: ['warmup line'],
    acts,
    runtime: {
      nextActIndex: options.nextActIndex === undefined ? lastIndex + 1 : options.nextActIndex,
      observations: options.observations ?? {},
      leases: {},
    },
  };
}

/** Dense sequence for the land() path: index equals position, at equals T0 + index. */
function stored(acts) {
  return acts.map((act, index) => ({ ...act, index, at: T0 + index }));
}

// Covers mention, reply, listen, ignore, bell, done, rejoin, case-variant
// spellings, unknown/self mentions, a departed reply author, an ignored
// mention target, a read activity used as a reply author, and a
// case-variant actor that must fold onto the first spelling.
const SEQUENTIAL_SOURCE = [
  { kind: 'join', actor: 'Alice' },
  { kind: 'join', actor: 'Bob' },
  { kind: 'join', actor: 'Carol' },
  { kind: 'say', actor: 'Alice', body: 'a3', mentions: ['Bob', 'carol'] },
  { kind: 'say', actor: 'Alice', body: 'a4', mentions: ['Nobody', 'Alice'] },
  { kind: 'say', actor: 'Bob', body: 'a5', reply: 3 },
  { kind: 'listen', actor: 'Carol', target: 'alice' },
  { kind: 'say', actor: 'Alice', body: 'a7' },
  { kind: 'ignore', actor: 'Bob', target: 'Alice' },
  { kind: 'say', actor: 'Alice', body: 'a9', mentions: ['bob', 'Carol'] },
  { kind: 'say', actor: 'Alice', body: 'bell10', reach: 'bell' },
  { kind: 'done', actor: 'Bob', body: 'bye' },
  { kind: 'say', actor: 'Alice', body: 'bell12', reach: 'bell' },
  { kind: 'join', actor: 'Bob' },
  { kind: 'say', actor: 'Carol', body: 'a14', reply: 4 },
  { kind: 'done', actor: 'Carol' },
  { kind: 'say', actor: 'Alice', body: 'a16', mentions: ['bob', 'CAROL'] },
  { kind: 'say', actor: 'Alice', body: 'a17', reply: 15 },
  { kind: 'read', actor: 'Alice', through: 17 },
  { kind: 'read', actor: 'Alice', through: 18 },
  { kind: 'read', actor: 'Alice', through: 19 },
  { kind: 'say', actor: 'Alice', body: 'a21' },
  { kind: 'read', actor: 'Bob', through: 21 },
  { kind: 'say', actor: 'Alice', body: 'a23', reply: 22 },
  { kind: 'read', actor: 'CAROL', through: 23 },
  { kind: 'join', actor: 'Dave' },
  { kind: 'listen', actor: 'Dave', target: 'bob' },
  { kind: 'listen', actor: 'Dave', target: 'Carol' },
  { kind: 'ignore', actor: 'Dave', target: 'bob' },
  { kind: 'listen', actor: 'Dave', target: 'Bob' },
  { kind: 'listen', actor: 'Dave', target: 'Bob' },
  { kind: 'listen', actor: 'Dave', target: 'carol' },
  { kind: 'read', actor: 'Dave', through: 31 },
  { kind: 'say', actor: 'Alice', body: 'a33', reply: 32 },
];

// Imported with deliberate coordinate gaps, an orphan receipt coordinate, and
// a reply pointing at an assigned-but-missing activity.
const GAPPED_ACTS = [
  { index: 0, at: T0 + 0, kind: 'join', actor: 'Alice' },
  { index: 3, at: T0 + 3, kind: 'join', actor: 'Bob' },
  { index: 5, at: T0 + 5, kind: 'say', actor: 'Alice', body: 'g5', mentions: ['Bob'] },
  { index: 8, at: T0 + 8, kind: 'listen', actor: 'Bob', target: 'Alice' },
  { index: 11, at: T0 + 11, kind: 'say', actor: 'Alice', body: 'g11', reach: 'bell' },
  { index: 14, at: T0 + 14, kind: 'say', actor: 'Bob', body: 'g14', reply: 5 },
  { index: 20, at: T0 + 20, kind: 'say', actor: 'Alice', body: 'g20', reply: 18 },
  { index: 23, at: T0 + 23, kind: 'done', actor: 'Bob' },
  { index: 25, at: T0 + 25, kind: 'say', actor: 'Alice', body: 'g25', reach: 'bell' },
];

// Cursor fixture: non-read 5/7/8, reads 6/9/10/11, and two
// unseen addressed says (12, 13) after Alice's second join at 4.
const CURSOR_SOURCE = [
  { kind: 'join', actor: 'Alice' },
  { kind: 'join', actor: 'Bob' },
  { kind: 'say', actor: 'Bob', body: 'c2' },
  { kind: 'join', actor: 'Carol' },
  { kind: 'join', actor: 'Alice' },
  { kind: 'say', actor: 'Bob', body: 'c5' },
  { kind: 'read', actor: 'Alice', through: 5 },
  { kind: 'say', actor: 'Bob', body: 'c7' },
  { kind: 'say', actor: 'Bob', body: 'c8' },
  { kind: 'read', actor: 'Bob', through: 8 },
  { kind: 'read', actor: 'Bob', through: 9 },
  { kind: 'read', actor: 'Bob', through: 10 },
  { kind: 'say', actor: 'Bob', body: 'c12', mentions: ['alice', 'carol'] },
  { kind: 'say', actor: 'Bob', body: 'c13', mentions: ['alice', 'carol'] },
];

// Pre-rejoin edges: 2 and 3 land while Alice is standing, then she leaves and
// rejoins at 6, which is where the notification cutoff moves.
const REJOIN_ACTS = [
  { index: 0, at: T0 + 0, kind: 'join', actor: 'Bob' },
  { index: 1, at: T0 + 1, kind: 'join', actor: 'Alice' },
  { index: 2, at: T0 + 2, kind: 'say', actor: 'Bob', body: 'd2', mentions: ['alice'] },
  { index: 3, at: T0 + 3, kind: 'say', actor: 'Bob', body: 'd3', mentions: ['alice'] },
  { index: 4, at: T0 + 4, kind: 'done', actor: 'Alice' },
  { index: 5, at: T0 + 5, kind: 'say', actor: 'Bob', body: 'd5', mentions: ['alice'] },
  { index: 6, at: T0 + 6, kind: 'join', actor: 'Alice' },
  { index: 7, at: T0 + 7, kind: 'say', actor: 'Bob', body: 'd7', mentions: ['alice'] },
  { index: 8, at: T0 + 8, kind: 'say', actor: 'Bob', body: 'd8', mentions: ['alice'] },
];

async function land(port, acts) {
  await port.transact((facts) => {
    for (const act of acts) facts.land(act);
  });
}

test('audience priority is bell > mention > reply > attention, with self and ignore rules', async () => {
  const acts = stored(SEQUENTIAL_SOURCE);
  const port = createArtifactPort(':memory:', fixtureState([]));
  try {
    await land(port, acts);
    const audience = async (index) => (await port.read((facts) => facts.audience(index))).value;
    assert.deepEqual(await audience(3), [{ recipient: 'Bob', route: 'mention' }, { recipient: 'Carol', route: 'mention' }], 'case-variant mentions resolve to roster spelling');
    assert.deepEqual(await audience(4), [], 'unknown and self mentions reach nobody');
    assert.deepEqual(await audience(5), [{ recipient: 'Alice', route: 'reply' }]);
    assert.deepEqual(await audience(7), [{ recipient: 'Carol', route: 'attention' }], 'listener-only edge');
    assert.deepEqual(await audience(9), [{ recipient: 'Carol', route: 'mention' }], 'mention beats listening, ignoring sender is skipped');
    assert.deepEqual(await audience(10), [{ recipient: 'Bob', route: 'bell' }, { recipient: 'Carol', route: 'bell' }], 'bell bypasses ignore');
    assert.deepEqual(await audience(12), [{ recipient: 'Carol', route: 'bell' }], 'departed peers are not reached');
    assert.deepEqual(await audience(14), [{ recipient: 'Alice', route: 'reply' }]);
    assert.deepEqual(await audience(16), [], 'done mention target drops; ignoring target stays skipped after rejoin');
    assert.deepEqual(await audience(17), [], 'reply author who is no longer standing reaches nobody');
    assert.deepEqual(await audience(23), [], 'ignore blocks a reply as well as a mention');
    assert.deepEqual(await audience(33), [{ recipient: 'Dave', route: 'reply' }], 'a read activity can be a reply author');
  } finally {
    await port.close();
  }
});

test('sparse receipts keep exact orphan coordinates and exact owner spelling', async () => {
  const port = createArtifactPort(':memory:', fixtureState(GAPPED_ACTS));
  try {
    const version = (await port.read((facts) => facts.header().revision)).value;
    const written = await port.transact((facts) => facts.markSeen('alice', [1, 2, 17, 19], T0 + 100));
    assert.equal(written.value, 4);
    assert.equal(written.changed, true);
    assert.equal(written.version, version + 1);

    const view = (await port.read((facts) => ({
      aliceOrphan: facts.receipt('Alice', 1),
      aliasOrphan: facts.receipt('ALICE', 2),
      missing: facts.receipt('Alice', 3),
      facts: facts.receiptFacts('Alice', -1),
      more: [facts.receipt('Alice', 17), facts.receipt('Alice', 19)],
    }))).value;
    assert.deepEqual(view.aliceOrphan, { at: T0 + 100 });
    assert.deepEqual(view.aliasOrphan, { at: T0 + 100 }, 'identity spelling resolves to the exact roster owner');
    assert.equal(view.missing, undefined);
    assert.deepEqual(view.facts, { latestAt: T0 + 100 }, 'orphan coordinates count for the latest receipt time');
    assert.deepEqual(view.more, [{ at: T0 + 100 }, { at: T0 + 100 }]);

    await port.transact((facts) => facts.markSeen('ghost', [4], T0 + 150));
    const unknown = (await port.read((facts) => ({
      exact: facts.receipt('ghost', 4),
      casefolded: facts.receipt('Ghost', 4),
    }))).value;
    assert.deepEqual(unknown.exact, { at: T0 + 150 });
    assert.equal(unknown.casefolded, undefined, 'an unknown owner keeps its raw spelling, not a case-folded lookup');

    const repeat = await port.transact((facts) => facts.markSeen('Alice', [1], T0 + 500));
    assert.equal(repeat.value, 0);
    assert.equal(repeat.changed, false, 'a repeated receipt writes nothing');
    assert.equal(repeat.version, written.version + 1);
    assert.deepEqual((await port.read((facts) => facts.receipt('Alice', 1))).value, { at: T0 + 100 }, 'first receipt time is immutable');

    await assert.rejects(port.transact((facts) => facts.markSeen('Alice', [26], T0)), /unassigned/);
    await assert.rejects(port.transact((facts) => facts.markSeen('Alice', [1], Number.NaN)), /malformed|finite|JSON/i);
  } finally {
    await port.close();
  }
});

test('cursor and presence distinguish nonaddressed progress, holes, reads and orphan receipts', async () => {
  const acts = stored(CURSOR_SOURCE);
  const port = createArtifactPort(':memory:', fixtureState([]));
  const probe = async (name) => (await port.read((facts) => ({
    cursor: readCursor(facts, name),
    presence: presenceAnchor(facts, name),
    aliasCursor: readCursor(facts, name.toLocaleUpperCase()),
  }))).value;
  try {
    await land(port, acts);

    const alice = await probe('Alice');
    assert.equal(alice.cursor, 8, 'progress stops before the unseen addressed act/12, at the last actor-bearing non-read');
    assert.equal(alice.aliasCursor, alice.cursor, 'identity spelling resolves');
    assert.equal(alice.presence, 5, 'a read is evidence, so the last say/done at or behind it anchors presence');
    const carol = await probe('Carol');
    assert.equal(carol.cursor, 8);
    assert.equal(carol.presence, -1, 'no own activity and no receipt evidence means no anchor');

    await port.transact((facts) => facts.markSeen('Alice', [13], T0 + 900));
    const beyondHole = await probe('Alice');
    assert.equal(beyondHole.cursor, 8, 'a seen row beyond the hole does not advance the cursor');
    assert.equal(beyondHole.presence, 13, 'an addressed receipt anchors presence');

    await port.transact((facts) => facts.markSeen('Alice', [10], T0 + 950));
    const withOrphan = (await port.read((facts) => ({ presence: presenceAnchor(facts, 'Alice'), facts: facts.receiptFacts('Alice', 4) }))).value;
    assert.equal(withOrphan.facts.latestAt, T0 + 950);
    assert.equal(withOrphan.facts.latestActorActivityIndex, 13, 'an orphan coordinate is not actor-bearing evidence');
    assert.equal(withOrphan.presence, 13, 'an orphan receipt does not move the anchor');

    await port.transact((facts) => facts.markSeen('Alice', [12], T0 + 1000));
    assert.equal((await probe('Alice')).cursor, 13, 'the contiguous prefix reaches the last addressed say');
  } finally {
    await port.close();
  }
});

test('catch filters before limiting, repeats exact catches, and reports truthful remaining', async () => {
  const acts = stored(SEQUENTIAL_SOURCE);
  const port = createArtifactPort(':memory:', fixtureState([]));
  try {
    await land(port, acts);

    const first = (await port.transact((facts) => decideCatch(facts, 'carol', { limit: 2 }, T0 + 500))).value;
    assert.deepEqual(first.activities.map((act) => act.id), ['act/3', 'act/7']);
    assert.equal(first.remaining, 3, 'remaining counts filtered unseen rows after insertion');
    assert.equal((await port.read(facts => readCursor(facts, 'Carol'))).value, 8, 'cursor advances over nonaddressed actor-bearing activity');
    assert.deepEqual((await port.read((facts) => facts.receipt('Carol', 3))).value, { at: T0 + 500 });

    const attentionOnly = (await port.transact((facts) => decideCatch(facts, 'Carol', { mention: true, limit: 10 }, T0 + 501))).value;
    assert.deepEqual(attentionOnly.activities.map((act) => act.id), ['act/9', 'act/10', 'act/12'], 'mention filter drops listener-only edges');
    assert.equal(attentionOnly.remaining, 0);
  } finally {
    await port.close();
  }

  const exactPort = createArtifactPort(':memory:', fixtureState(stored(SEQUENTIAL_SOURCE)));
  try {
    const none = (await exactPort.transact((facts) => decideCatch(facts, 'Carol', { from: ['Bob'], limit: 1 }, T0 + 600))).value;
    assert.deepEqual(none.activities, [], 'Bob never addresses Carol');
    assert.equal(none.remaining, 0, 'remaining counts only the filtered relation');
    assert.equal((await exactPort.read((facts) => facts.receipt('Carol', 3))).value, undefined);

    const senders = (await exactPort.transact((facts) => decideCatch(facts, 'Carol', { from: ['Alice'], limit: 2 }, T0 + 601))).value;
    assert.deepEqual(senders.activities.map((act) => act.id), ['act/3', 'act/7'], 'sender filter applies before the limit');
    assert.equal(senders.remaining, 3);

    const repeat = (await exactPort.transact((facts) => decideCatch(facts, 'Carol', { id: 'act/3' }, T0 + 602))).value;
    assert.deepEqual(repeat.activities.map((act) => act.id), ['act/3'], 'an exact catch may repeat a seen activity');
    assert.deepEqual((await exactPort.read((facts) => facts.receipt('Carol', 3))).value, { at: T0 + 601 }, 'the repeat preserves the original receipt');
    assert.equal(repeat.remaining, 3, 'exact remaining covers all historical directed unseen rows');

    const page = (await exactPort.transact((facts) => decideCatch(facts, 'Carol', { limit: 1 }, T0 + 603))).value;
    assert.deepEqual(page.activities.map((act) => act.id), ['act/9']);
    assert.equal(page.remaining, 2);
  } finally {
    await exactPort.close();
  }
});

test('a pre-rejoin catch sees earlier holes while pending discovery stops at the latest join', async () => {
  const port = createArtifactPort(':memory:', fixtureState(REJOIN_ACTS));
  try {
    const beforeCatch = (await port.read((facts) => ({
      historical: facts.directed('Alice', { unseenOnly: true }, { edge: 'oldest', limit: 10 }).items.map((head) => head.index),
      pending: facts.pendingAudience(-1, 8, 10).groups.map((group) => ({ index: group.index, recipients: group.recipients.map((row) => row.recipient) })),
      cursor: readCursor(facts, 'Alice'),
    }))).value;
    assert.deepEqual(beforeCatch.historical, [2, 3, 7, 8], 'ordinary catch is not cut by the latest join');
    assert.deepEqual(beforeCatch.pending, [{ index: 7, recipients: ['Alice'] }, { index: 8, recipients: ['Alice'] }], 'notification pending starts after the latest join');
    assert.equal(beforeCatch.cursor, 6, 'cursor sits at the rejoin coordinate before any addressed row');

    const page = (await port.read((facts) => facts.pendingAudience(-1, 8, 1))).value;
    assert.deepEqual(page.groups.map((group) => group.index), [7], 'a page limit bounds activity groups');
    assert.equal(page.hasMore, true);
    const whole = (await port.read((facts) => facts.pendingAudience(-1, 8, 2))).value;
    assert.equal(whole.hasMore, false);
    assert.deepEqual(Object.keys(whole.groups[0]).sort(), ['actor', 'at', 'index', 'recipients'], 'pending discovery carries no body');

    const caught = (await port.transact((facts) => decideCatch(facts, 'Alice', { limit: 10 }, T0 + 700))).value;
    assert.deepEqual(caught.activities.map((act) => act.id), ['act/2', 'act/3', 'act/7', 'act/8']);
    assert.equal(caught.remaining, 0);
    assert.equal((await port.read(facts => readCursor(facts, 'Alice'))).value, 8);
    assert.equal((await port.read((facts) => facts.pendingAudience(-1, 8, 10))).value.groups.length, 0, 'catch receipts clear pending discovery');
  } finally {
    await port.close();
  }
});

test('history context selects neighboring existing positions across gaps', async () => {
  const port = createArtifactPort(':memory:', fixtureState(GAPPED_ACTS));
  try {
    const context = async (centers, before, after) => (await port.read((facts) => facts.contextIndexes(centers, before, after))).value;
    assert.deepEqual(await context([14], 3, 3), [5, 8, 11, 14, 20, 23, 25], 'neighbors are existing positions, not coordinate arithmetic');
    assert.deepEqual(await context([8], 1, 1), [5, 8, 11], 'the previous position is act/5, not act/7');
    assert.deepEqual(await context([20], 1, 1), [14, 20, 23]);
    assert.deepEqual(await context([20, 5], 0, 0), [5, 20], 'centers union in index order');
  } finally {
    await port.close();
  }
});
