import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { emptyRuntimeState, loadSquare } from '../dist/artifact.js';
import { deliveryDelta } from '../dist/activity-feed.js';
import { coreActivities, coreHold, coreResume, decideAct, decideJoin } from '../dist/decisions.js';
import { appendAct } from '../dist/square-application.js';

function makeDoc(overrides = {}) {
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

test('joining contributes one canonical lifecycle activity for an unknown participant', () => {
  const result = decideJoin(makeDoc(), 'Alice', 100);

  assert.equal(result.addParticipant, true);
  assert.equal(result.joinedName, 'Alice');
  assert.equal(result.joinAct.kind, 'join');
  assert.equal(result.joinAct.actor, 'Alice');
});

test('pending activities begin after the recipient joined and include directed reach', () => {
  const doc = makeDoc({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'say', actor: 'Alice', at: 2, body: 'too early @Bob' },
      { kind: 'join', actor: 'Bob', at: 3, body: '' },
      { kind: 'say', actor: 'Alice', at: 4, body: 'live @Bob' },
      { kind: 'say', actor: 'Alice', at: 5, body: 'private', reach: { beside: 'Bob' } },
    ],
  });

  assert.deepEqual(
    coreActivities(doc, { pending: true, viewer: 'Bob' }).map((item) => item.index),
    [3, 4]
  );
});

test('mention history follows the same recipient boundary as beside delivery', () => {
  const doc = makeDoc({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'join', actor: 'Cara', at: 3, body: '' },
      { kind: 'say', actor: 'Alice', at: 4, body: 'private', reach: { beside: 'Bob' } },
    ],
  });

  assert.deepEqual(coreActivities(doc, { mention: 'Bob' }).map((item) => item.index), [3]);
  assert.deepEqual(coreActivities(doc, { mention: 'Cara' }), []);
});

test('directed pending attention survives a cursor that already consumed the public stream', () => {
  const doc = makeDoc({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'pending @Bob' },
      { kind: 'say', actor: 'Bob', at: 4, body: 'self activity' },
    ],
  });
  doc.runtime.cursors.Bob = { consumedThroughIndex: 3, updatedAt: 4 };

  assert.deepEqual(deliveryDelta(doc, 'Bob').map((item) => item.index), [2]);
});

test('host controls preserve the requesting actor and body', () => {
  const doc = makeDoc();
  const hold = coreHold(doc, 'Host', 'pause', 10);
  const resume = coreResume(doc, 'Host', 11);

  assert.deepEqual(
    { kind: hold.kind, actor: hold.actor, body: hold.body },
    { kind: 'hold', actor: 'Host', body: 'pause' }
  );
  assert.deepEqual(
    { kind: resume.kind, actor: resume.actor },
    { kind: 'resume', actor: 'Host' }
  );
});

test('a participant cursor advances to the newest self activity and never reuses an index', () => {
  const doc = makeDoc();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'square-core-')), 'square.md');
  appendAct(file, doc, { kind: 'join', actor: 'Alice', at: 1, body: '' });
  appendAct(file, doc, { kind: 'say', actor: 'Alice', at: 2, body: 'hello' });
  appendAct(file, doc, { kind: 'done', actor: 'Alice', at: 3, body: 'bye' });

  const stored = loadSquare(file);
  assert.equal(stored.runtime.cursors.Alice.consumedThroughIndex, 2);
  assert.deepEqual(stored.acts.map((act) => act.index), [0, 1, 2]);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('a valid expression emits the caller as actor and preserves its body, reach, and reply', () => {
  const doc = makeDoc({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
    ],
    runtime: {
      version: 2,
      nextActIndex: 2,
      cursors: {},
      deliveryReceipts: {},
      leases: {},
    },
  });
  const decision = decideAct(doc, {
    name: 'Alice',
    body: 'hi @Bob',
    reach: { beside: 'Bob' },
    reply: 1,
    force: true,
    now: 3,
  });

  assert.equal(decision.type, 'sent');
  if (decision.type === 'sent') {
    assert.deepEqual(
      { kind: decision.act.kind, actor: decision.act.actor, body: decision.act.body, reach: decision.act.reach, reply: decision.act.reply },
      { kind: 'say', actor: 'Alice', body: 'hi @Bob', reach: { beside: 'Bob' }, reply: 1 }
    );
  }
});

test('an expression without a mention or bell is invalid', () => {
  const doc = makeDoc({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
    ],
  });

  assert.throws(
    () => decideAct(doc, { name: 'Alice', body: 'hello everyone', force: true, now: 3 }),
    (error) => error.code === 'invalid_args' && /@mention.*--bell/.test(error.message)
  );

  assert.throws(
    () => decideAct(doc, { name: 'Alice', body: 'aside', reach: { beside: 'Bob' }, force: true, now: 3 }),
    (error) => error.code === 'invalid_args'
  );
});

test('reply rejects an activity id that has not landed yet', () => {
  const doc = makeDoc({ acts: [{ kind: 'join', actor: 'Alice', at: 1, body: '' }] });
  assert.throws(
    () => decideAct(doc, { name: 'Alice', body: 'late answer', force: true, now: 2, reply: 9 }),
    /Unknown reply activity: act_9/
  );
});
