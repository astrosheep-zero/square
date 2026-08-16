import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { diagnoseSquare, emptyRuntimeState, loadSquare, parseSquare, renderSquare, renderSquareDoc, saveRuntimeSidecar } from '../dist/artifact.js';
import { planRepair } from '../dist/doctor.js';
import { repairSquare } from '../dist/square-application.js';
import { appendAct } from '../dist/square-application.js';

function withIndexes(acts) {
  return acts.map((act, index) => ({ ...act, index }));
}

function makeDoc(overrides = {}) {
  const acts = withIndexes(overrides.acts ?? []);
  return {
    hardCap: 'hardCap' in overrides ? overrides.hardCap : 3,
    throttlePerMinute: overrides.throttlePerMinute,
    preamble: overrides.preamble ?? ['Intro line'],
    warmup: overrides.warmup ?? ['Warmup body'],
    acts,
    runtime: overrides.runtime ?? { ...emptyRuntimeState(acts.length), nextActIndex: acts.length },
  };
}

function writeFixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-artifact-'));
  const squarePath = path.join(dir, 'square.md');
  const doc = makeDoc(overrides);
  fs.writeFileSync(squarePath, renderSquareDoc(doc));
  return { dir, squarePath, doc };
}

test('loadSquare preserves markdown activity indexes when the runtime sidecar is absent', () => {
  const { dir, squarePath } = writeFixture({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'say', actor: 'Alice', at: 2, body: 'hello' },
    ],
  });

  const loaded = loadSquare(squarePath);
  assert.equal(loaded.runtime.nextActIndex, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadSquare does not reuse an index when the runtime sidecar is behind markdown', () => {
  const { dir, squarePath } = writeFixture({
    acts: [{ kind: 'join', actor: 'Alice', at: 1, body: '' }],
  });
  fs.writeFileSync(`${squarePath}.runtime.json`, JSON.stringify(emptyRuntimeState(0)));

  const loaded = loadSquare(squarePath);
  const appended = appendAct(squarePath, loaded, { kind: 'say', actor: 'Alice', at: 2, body: 'hello' });
  assert.equal(appended.index, 1);
  assert.deepEqual(loadSquare(squarePath).acts.map((act) => act.index), [0, 1]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadSquare rejects an obsolete runtime receipt field', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-runtime-migration-'));
  const file = path.join(dir, 'square.md');
  const doc = parseSquare(renderSquare({ hardCap: null, force: true }, 'warmup'));
  fs.writeFileSync(file, renderSquareDoc(doc));
  fs.writeFileSync(`${file}.runtime.json`, JSON.stringify({
    version: 2,
    nextActIndex: 0,
    cursors: {},
    mentionReceipts: { Alice: { act_0: { status: 'delivered', at: 1 } } },
    leases: {},
  }));

  assert.throws(() => loadSquare(file), /deliveryReceipts contains an invalid receipt map/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadSquare rejects malformed runtime sidecar fields', () => {
  const malformed = [
    ['version', (runtime) => ({ ...runtime, version: 1 })],
    ['nextActIndex', (runtime) => ({ ...runtime, nextActIndex: -1 })],
    ['cursors', (runtime) => ({ ...runtime, cursors: { Alice: { consumedThroughIndex: '0' } } })],
    ['deliveryReceipts', (runtime) => ({ ...runtime, deliveryReceipts: { Alice: { bad: {} } } })],
    ['leases', (runtime) => ({ ...runtime, leases: { Alice: { leaseId: '' } } })],
    ['notifyLeases', (runtime) => ({
      ...runtime,
      notifyLeases: { attention: { leaseId: 'lease', expiresAt: 1, phase: 'dispatching', attemptN: 1, routeKind: 'invalid' } },
    })],
  ];

  for (const [field, mutate] of malformed) {
    const { dir, squarePath, doc } = writeFixture();
    fs.writeFileSync(`${squarePath}.runtime.json`, JSON.stringify(mutate(doc.runtime)));
    assert.throws(() => loadSquare(squarePath), new RegExp(`runtime sidecar.*${field === 'version' ? 'version' : field}`));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor repair preserves compacted stable indexes', () => {
  const doc = {
    hardCap: 3,
    preamble: ['Intro line'],
    warmup: ['Warmup body'],
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '', index: 5 },
      { kind: 'say', actor: 'Alice', at: 2, body: 'hello', index: 6 },
    ],
    runtime: { ...emptyRuntimeState(7), nextActIndex: 7 },
  };
  const repaired = planRepair(diagnoseSquare(renderSquareDoc(doc))).repaired;
  assert.deepEqual(repaired.doc.acts.map((act) => act.index), [5, 6]);
  assert.equal(repaired.doc.runtime.nextActIndex, 7);
  assert.doesNotMatch(repaired.actions.map((action) => action.message).join('\n'), /renumbered/);
});

test('doctor repair keeps sidecar delivery state while repairing markdown', async () => {
  const { dir, squarePath, doc } = writeFixture({
    acts: [{ kind: 'join', actor: 'Alice', at: 1, body: '' }],
  });
  doc.runtime.cursors.Alice = { consumedThroughIndex: 0, updatedAt: 1 };
  doc.runtime.deliveryReceipts.Alice = { act_0: { status: 'delivered', at: 2 } };
  doc.runtime.leases.Alice = { leaseId: 'lease-1', heartbeatAt: 3, expiresAt: 4 };
  fs.writeFileSync(`${squarePath}.runtime.json`, JSON.stringify(doc.runtime));
  fs.appendFileSync(squarePath, '\n<!-- square:act {"index":1} -->\n### Broken\n');

  const result = await repairSquare(squarePath);
  assert.equal(result.repaired?.quarantinedBlocks.length, 1);
  const loaded = loadSquare(squarePath);
  assert.deepEqual(loaded.runtime.cursors.Alice, doc.runtime.cursors.Alice);
  assert.deepEqual(loaded.runtime.deliveryReceipts.Alice.act_0, doc.runtime.deliveryReceipts.Alice.act_0);
  assert.deepEqual(loaded.runtime.leases.Alice, doc.runtime.leases.Alice);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('doctor repair drops runtime metadata when it must change act indexes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-artifact-gap-'));
  const squarePath = path.join(dir, 'square.md');
  const doc = {
    hardCap: 3,
    preamble: [],
    warmup: ['warmup'],
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '', index: 0 },
      { kind: 'say', actor: 'Alice', at: 2, body: 'hello', index: 2 },
    ],
    runtime: emptyRuntimeState(3),
  };
  doc.runtime.cursors.Alice = { consumedThroughIndex: 2, updatedAt: 2 };
  doc.runtime.deliveryReceipts.Alice = { act_2: { status: 'delivered', at: 3 } };
  doc.runtime.leases.Alice = { leaseId: 'lease-1', heartbeatAt: 3, expiresAt: 4 };
  fs.writeFileSync(squarePath, renderSquareDoc(doc));
  fs.writeFileSync(`${squarePath}.runtime.json`, JSON.stringify(doc.runtime));

  await repairSquare(squarePath);
  const loaded = loadSquare(squarePath);
  assert.deepEqual(loaded.acts.map((act) => act.index), [0, 1]);
  assert.deepEqual(loaded.runtime.cursors, {});
  assert.deepEqual(loaded.runtime.deliveryReceipts, {});
  assert.deepEqual(loaded.runtime.leases, {});
  assert.equal(loaded.runtime.nextActIndex, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('v3 render/parse roundtrip preserves act history, runtime lives in sidecar', () => {
  const doc = makeDoc({
    hardCap: null,
    throttlePerMinute: 5,
    acts: [
      { kind: 'join', actor: 'Alice', at: 1700000000000, body: '' },
      { kind: 'say', actor: 'Alice', at: 1700000001000, body: 'hello @Bob' },
      { kind: 'hold', actor: 'Host', at: 1700000002000, body: 'pause' },
      { kind: 'resume', actor: 'Host', at: 1700000003000, body: '' },
      { kind: 'done', actor: 'Alice', at: 1700000004000, body: 'bye' },
    ],
  });

  const rendered = renderSquareDoc(doc);
  assert.match(rendered, /^format_version: 3$/m);
  assert.doesNotMatch(rendered, /^participants:/m);
  assert.doesNotMatch(rendered, /mind_square_state/);
  assert.match(rendered, /<!-- square:act \{"index":1,"kind":"say","actor":"Alice","at":1700000001000\} -->/);
  assert.match(rendered, /_say · /);

  const parsed = parseSquare(rendered);
  // parseSquare only handles the markdown — runtime comes from sidecar
  assert.equal(parsed.hardCap, null);
  assert.equal(parsed.throttlePerMinute, 5);
  assert.equal(parsed.acts.length, 5);
  assert.equal(parsed.acts[0].kind, 'join');
  assert.equal(parsed.acts[1].kind, 'say');
  assert.equal(parsed.acts[4].kind, 'done');
  // runtime is empty (from parseSquare), loaded separately by loadSquare
  assert.equal(parsed.runtime.version, 2);
  assert.equal(parsed.runtime.nextActIndex, 5);
});

test('strict parser rejects missing and old format versions', () => {
  const rendered = renderSquareDoc(makeDoc({ acts: [{ kind: 'join', actor: 'Alice', at: 1, body: '' }] }));
  const missing = rendered.replace(/^format_version: 3\n/m, '');
  assert.throws(() => parseSquare(missing), /Create a new square/);

  const v2 = rendered.replace(/^format_version: 3$/m, 'format_version: 2');
  assert.throws(() => parseSquare(v2), /no longer supported/);
});

test('say metadata roundtrips through the artifact boundary', () => {
  const doc = makeDoc({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '' },
      { kind: 'join', actor: 'Bob', at: 2, body: '' },
      { kind: 'say', actor: 'Alice', at: 3, body: 'center @Bob' },
      { kind: 'say', actor: 'Alice', at: 4, body: 'bell', reach: 'bell', reply: 2 },
    ],
  });

  const rendered = renderSquareDoc(doc);
  assert.match(rendered, /<!-- square:act \{"index":2,"kind":"say","actor":"Alice","at":3\} -->/);
  assert.match(rendered, /<!-- square:act \{"index":3,"kind":"say","actor":"Alice","at":4,"reach":"bell","reply":2\} -->/);
  assert.doesNotMatch(rendered, /beside/);

  const parsed = parseSquare(rendered);
  assert.equal(parsed.acts[2].reach, undefined);
  assert.equal(parsed.acts[3].reach, 'bell');
  assert.equal(parsed.acts[3].reply, 2);

  const beside = rendered.replace(
    '<!-- square:act {"index":2,"kind":"say","actor":"Alice","at":3} -->',
    '<!-- square:act {"index":2,"kind":"say","actor":"Alice","at":3,"reach":{"beside":"Bob"}} -->'
  );
  assert.throws(() => parseSquare(beside), /malformed act reach metadata/);
});
