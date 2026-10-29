// Differential evidence for the row-backed landing transition.
//
// Every maintained index read here (roster, landed audience + route, attention,
// lifetime say counts, last join/active) is compared against the frozen v1
// oracle in ./fixtures/legacy-square-core.js, which preserves the surviving
// pre-row square-core fold/replay semantics (obsolete activity handling removed).
// Its audience algorithm was verified against the shipped v1
// module over 400 random replays before those folds were deleted. This file is
// test-only: it imports nothing from production except the public fact port,
// the shared domain helpers and the read-side projections.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { decideCatch } from '../dist/catch-decisions.js';
import { formatActivityId, parseActivityId } from '../dist/model.js';
import { readCursor, presenceAnchor } from '../dist/runtime.js';
import { SCHEMA_SQL } from '../dist/square-sqlite.js';
import { createArtifactPort as createRealArtifactPort, createSquareFile, writeSquareFile } from '../dist/artifact.js';
import { createTestArtifactPort as createArtifactPort } from './fixtures/test-artifact-port.js';
import { snapshot } from '../dist/views.js';
import * as legacy from './fixtures/legacy-square-core.js';

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

const LISTENERS = ['Alice', 'Bob', 'Carol', 'Dave'];
const SENDERS = ['Alice', 'Bob', 'Carol'];

async function land(port, acts) {
  await port.transact((facts) => {
    for (const act of acts) facts.land(act);
  });
}

/** Read every maintained index in one synchronous callback. */
async function maintainedIndices(port, acts, listeners = LISTENERS, senders = SENDERS) {
  const says = acts.filter((act) => act.kind === 'say').map((act) => act.index);
  return (await port.read((facts) => ({
    header: facts.header(),
    roster: facts.roster().map((participant) => ({ ...participant })),
    audiences: Object.fromEntries(says.map((index) => [index, facts.audience(index).map((row) => ({ ...row }))])),
    attention: Object.fromEntries(listeners.map((listener) => [listener, facts.attention(listener).map((fact) => ({ ...fact }))])),
    incoming: Object.fromEntries(senders.map((sender) => [sender, facts.incomingAttention(sender).map((fact) => ({ ...fact }))])),
  }))).value;
}

function withoutRevision(maintained) {
  return { ...maintained, header: { ...maintained.header, revision: 0 } };
}

function compareWithFrozenReplay(maintained, acts, listeners = LISTENERS, senders = SENDERS) {
  const oracle = legacy.replayLandedAudiences(acts);
  assert.deepEqual(maintained.roster.map((participant) => participant.name), oracle.participants, 'roster names/order');
  assert.deepEqual(
    [...maintained.roster].sort((a, b) => a.firstIndex - b.firstIndex).map((participant) => participant.name),
    oracle.participants,
    'firstIndex order',
  );
  assert.deepEqual(maintained.roster.filter((p) => p.joined).map((p) => p.name), oracle.joined, 'joined set');
  assert.deepEqual(maintained.roster.filter((p) => p.done).map((p) => p.name), oracle.done, 'done set');
  for (const participant of maintained.roster) {
    assert.equal(participant.sayCount, oracle.sayCount(participant.name), `sayCount(${participant.name})`);
    assert.equal(participant.lastJoinIndex, oracle.lastJoinIndex(participant.name), `lastJoinIndex(${participant.name})`);
    assert.equal(participant.lastActiveAt, oracle.lastActiveAt(participant.name), `lastActiveAt(${participant.name})`);
  }

  const says = acts.filter((act) => act.kind === 'say').map((act) => act.index);
  assert.deepEqual(Object.keys(maintained.audiences).map(Number).sort((a, b) => a - b), says, 'every say is readable');
  for (const index of says) {
    const rows = maintained.audiences[index];
    assert.deepEqual(rows.map((row) => row.recipient), oracle.recipientsAtLanding(index), `landed audience order at act/${index}`);
    assert.deepEqual(rows, oracle.groups(index), `landed audience routes at act/${index}`);
    // The labeled oracle must stay a mechanical rearrangement of the verbatim one.
    assert.deepEqual(oracle.groups(index).map((row) => row.recipient), oracle.recipientsAtLanding(index), `oracle labels at act/${index}`);
  }

  for (const listener of listeners) {
    const facts = maintained.attention[listener];
    assert.deepEqual(facts.filter((fact) => fact.kind === 'listen').map((fact) => fact.target), oracle.listening.get(legacy.nameKey(listener)) ?? [], `listening(${listener})`);
    assert.deepEqual(facts.filter((fact) => fact.kind === 'ignore').map((fact) => fact.target), oracle.ignored.get(legacy.nameKey(listener)) ?? [], `ignored(${listener})`);
    for (const fact of facts) assert.equal(fact.listener, listener, `attention listener spelling (${listener})`);
    for (let i = 1; i < facts.length; i += 1) assert.ok(facts[i - 1].sinceIndex <= facts[i].sinceIndex, `attention order (${listener})`);
  }

  const sortFacts = (facts) => [...facts].sort((a, b) => (a.listener + a.kind).localeCompare(b.listener + b.kind));
  for (const sender of senders) {
    const expected = [];
    for (const [listener, targets] of oracle.listening) {
      if (targets.some((target) => legacy.sameName(target, sender))) expected.push({ listener, kind: 'listen' });
    }
    for (const [listener, targets] of oracle.ignored) {
      if (targets.some((target) => legacy.sameName(target, sender))) expected.push({ listener, kind: 'ignore' });
    }
    const actual = maintained.incoming[sender].map((fact) => ({ listener: legacy.nameKey(fact.listener), kind: fact.kind }));
    assert.deepEqual(sortFacts(actual), sortFacts(expected), `incomingAttention(${sender})`);
  }

  return oracle;
}

function makeDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'square-row-domain-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('the frozen oracle labels stay a mechanical rearrangement of its verbatim recipients', () => {
  const acts = stored(SEQUENTIAL_SOURCE);
  const oracle = legacy.replayLandedAudiences(acts);
  for (const act of acts) {
    if (act.kind !== 'say') continue;
    assert.deepEqual(oracle.groups(act.index).map((row) => row.recipient), oracle.recipientsAtLanding(act.index));
  }

  // Seeded corpus: the labeled rearrangement must never drift from the verbatim
  // v1 recipient list, and its labels must respect bell > mention > reply > attention.
  const rank = { bell: 0, mention: 1, reply: 2, attention: 3 };
  let seed = 0x2f6e2b1;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (values) => values[Math.floor(random() * values.length)];
  const names = ['Ada', 'bo', 'Cy', 'dee'];
  const kinds = ['join', 'done', 'say', 'say', 'listen', 'ignore', 'read'];
  for (let round = 0; round < 200; round += 1) {
    const generated = [];
    const count = 2 + Math.floor(random() * 25);
    for (let index = 0; index < count; index += 1) {
      const kind = pick(kinds);
      const base = { kind, actor: pick(names), at: T0 + index, index };
      if (kind === 'say') {
        const mentions = Array.from({ length: Math.floor(random() * 3) }, () => pick([...names, 'ghost']));
        const reply = generated.some((act) => act.kind === 'say') && random() < 0.4 ? pick(generated.filter((act) => act.kind === 'say')).index : undefined;
        generated.push({ ...base, body: 's', ...(mentions.length === 0 ? {} : { mentions }), ...(random() < 0.2 ? { reach: 'bell' } : {}), ...(reply === undefined ? {} : { reply }) });
      } else if (kind === 'listen' || kind === 'ignore') {
        generated.push({ ...base, target: pick([...names, 'ghost']) });
      } else if (kind === 'read') {
        generated.push({ ...base, through: index });
      } else {
        generated.push(base);
      }
    }
    const replay = legacy.replayLandedAudiences(generated);
    for (const act of generated) {
      if (act.kind !== 'say') continue;
      const groups = replay.groups(act.index);
      assert.deepEqual(groups.map((row) => row.recipient), replay.recipientsAtLanding(act.index), `oracle labels (round ${round}, act/${act.index})`);
      assert.deepEqual(groups.map((row) => rank[row.route]), groups.map((row) => rank[row.route]).slice().sort((a, b) => a - b), `oracle priority (round ${round})`);
      if (act.reach === 'bell') assert.ok(groups.every((row) => row.route === 'bell'));
    }
  }

  // No triggers: the maintained indices are maintained by exactly one domain transition.
  assert.ok(!/CREATE\s+TRIGGER/i.test(SCHEMA_SQL));
});

test('landing one activity at a time reproduces the frozen v1 replay', async () => {
  const acts = stored(SEQUENTIAL_SOURCE);
  const port = createArtifactPort(':memory:', fixtureState([]));
  const imported = createArtifactPort(':memory:', fixtureState(acts));
  try {
    const returned = await port.transact((facts) => acts.map((act) => facts.land(act)));
    assert.deepEqual(returned.value.map((act) => act.index), acts.map((act) => act.index));
    assert.deepEqual(returned.value.map((act) => act.at), acts.map((act) => act.at));
    const maintained = await maintainedIndices(port, acts);
    compareWithFrozenReplay(maintained, acts);
    assert.equal(maintained.header.lastActIndex, acts.length - 1);
    assert.equal(maintained.header.nextActIndex, acts.length);
    assert.deepEqual(maintained.header, { ...maintained.header, revision: 1 }, 'one landing transaction advances the revision once');
    assert.deepEqual(withoutRevision(maintained), withoutRevision(await maintainedIndices(imported, acts)), 'the land path and the fixture import path agree');
    assert.equal(parseActivityId(formatActivityId(acts.length - 1)), acts.length - 1);
  } finally {
    await port.close();
    await imported.close();
  }
});

test('importing a gapped v1-shaped snapshot rebuilds the same maintained indices', async () => {
  const port = createArtifactPort(':memory:', fixtureState(GAPPED_ACTS));
  try {
    const maintained = await maintainedIndices(port, GAPPED_ACTS);
    compareWithFrozenReplay(maintained, GAPPED_ACTS);
    assert.equal(maintained.header.lastActIndex, 25);
    assert.equal(maintained.header.nextActIndex, 26);
    assert.equal(maintained.header.revision, 0);
  } finally {
    await port.close();
  }
});

test('a file-backed artifact agrees with memory and with the frozen replay', async (t) => {
  const directory = makeDirectory(t);
  const location = path.join(directory, 'SQUARE.square');
  assert.equal(await createSquareFile(location, fixtureState(GAPPED_ACTS)), true);
  assert.equal(await createSquareFile(location, fixtureState(GAPPED_ACTS)), false, 'create is race-safe');

  const file = createRealArtifactPort(location);
  const memory = createArtifactPort(':memory:', fixtureState(GAPPED_ACTS));
  try {
    const fromFile = await maintainedIndices(file, GAPPED_ACTS);
    compareWithFrozenReplay(fromFile, GAPPED_ACTS);
    assert.deepEqual(fromFile, await maintainedIndices(memory, GAPPED_ACTS), 'file and memory indices agree');
  } finally {
    await file.close();
    await memory.close();
  }

  await writeSquareFile(location, fixtureState(stored(SEQUENTIAL_SOURCE)));
  const replaced = createRealArtifactPort(location);
  try {
    const fromFile = await maintainedIndices(replaced, stored(SEQUENTIAL_SOURCE));
    assert.equal(fromFile.header.lastActIndex, SEQUENTIAL_SOURCE.length - 1);
    compareWithFrozenReplay(fromFile, stored(SEQUENTIAL_SOURCE));
  } finally {
    await replaced.close();
  }
});

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
      assignments: facts.receiptAssignments(),
    }))).value;
    assert.deepEqual(view.aliceOrphan, { at: T0 + 100 });
    assert.deepEqual(view.aliasOrphan, { at: T0 + 100 }, 'identity spelling resolves to the exact roster owner');
    assert.equal(view.missing, undefined);
    assert.deepEqual(view.facts, { latestAt: T0 + 100 }, 'orphan coordinates count for the latest receipt time');
    assert.deepEqual(view.assignments, [
      { owner: 'Alice', index: 1 }, { owner: 'Alice', index: 2 }, { owner: 'Alice', index: 17 }, { owner: 'Alice', index: 19 },
    ]);

    await port.transact((facts) => facts.markSeen('ghost', [4], T0 + 150));
    const unknown = (await port.read((facts) => ({
      exact: facts.receipt('ghost', 4),
      casefolded: facts.receipt('Ghost', 4),
      assignments: facts.receiptAssignments().filter((row) => row.index === 4),
    }))).value;
    assert.deepEqual(unknown.exact, { at: T0 + 150 });
    assert.equal(unknown.casefolded, undefined, 'an unknown owner keeps its raw spelling, not a case-folded lookup');
    assert.deepEqual(unknown.assignments, [{ owner: 'ghost', index: 4 }]);

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

test('the detached snapshot closure answers exactly, survives later writes and close', async () => {
  const port = createArtifactPort(':memory:', fixtureState(GAPPED_ACTS));
  await port.transact((facts) => {
    facts.markSeen('Alice', [25], T0 + 900);
    facts.markSeen('ghost', [1], T0 + 950);
  });
  const captured = (await port.read(facts => snapshot(facts, T0 + 1000))).value;

  assert.equal(captured.delivered('alice', 'act/25'), true);
  assert.equal(captured.delivered('Alice', 'act/25'), true);
  assert.equal(captured.delivered('Alice', 'act/24'), false);
  assert.equal(captured.delivered('ghost', 'act/1'), true);
  assert.equal(captured.delivered('Ghost', 'act/1'), false, 'the closure keeps the raw owner key, not a folded one');
  assert.throws(() => captured.delivered('Alice', 'act/-1'), /activity id/i);

  await port.transact((facts) => facts.markSeen('Alice', [20], T0 + 1100));
  assert.equal(captured.delivered('Alice', 'act/20'), false, 'a later write does not alter the captured snapshot');
  assert.equal((await port.read(facts => snapshot(facts, T0 + 1000))).value.delivered('Alice', 'act/20'), true);

  await port.close();
  assert.equal(captured.delivered('Alice', 'act/25'), true);
  assert.equal(captured.delivered('ghost', 'act/1'), true);
});
