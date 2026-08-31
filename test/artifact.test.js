import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import {
  createSquareState,
  decodeSquare,
  diagnoseSquareFile,
  emptyRuntimeState,
  encodeSquare,
  loadSquare,
  probeSquare,
  writeSquareFile,
} from '../dist/artifact.js';
import { deriveDeliveryModel } from '../dist/delivery.js';
import { formatActivityId } from '../dist/square-core.js';
import { express } from '../dist/landing.js';
import {
  createFileCell,
  diagnoseSquareFile as diagnoseStoredSquareFile,
  probeSquareFile,
  readSquareFile,
  withSquareFileLock,
} from '../dist/square-storage.js';

const SQUARE_MAGIC = Buffer.from('SQUARE01', 'ascii');
function withIndexes(acts) {
  return acts.map((act, index) => ({ ...act, index }));
}

function makeState(overrides = {}) {
  const acts = withIndexes(overrides.acts ?? []);
  return {
    hardCap: 'hardCap' in overrides ? overrides.hardCap : 3,
    ...(overrides.throttlePerMinute === undefined ? {} : { throttlePerMinute: overrides.throttlePerMinute }),
    preamble: overrides.preamble ?? ['Intro line'],
    warmup: overrides.warmup ?? ['Warmup body'],
    acts,
    runtime: overrides.runtime ?? { ...emptyRuntimeState(acts.length), nextActIndex: acts.length },
  };
}

async function writeFixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-artifact-'));
  const squarePath = path.join(dir, 'SQUARE.square');
  const squareState = makeState(overrides);
  await writeSquareFile(squarePath, squareState);
  return { dir, squarePath, squareState };
}

function envelope(magic, payload) {
  const header = Buffer.alloc(magic.length + 4 + 32);
  magic.copy(header, 0);
  header.writeUInt32BE(payload.length, magic.length);
  crypto.createHash('sha256').update(payload).digest().copy(header, magic.length + 4);
  return Buffer.concat([header, payload]);
}

test('encode/decode roundtrip preserves Square state', () => {
  const squareState = makeState({
    hardCap: null,
    throttlePerMinute: 5,
    acts: [
      { kind: 'join', actor: 'Alice', at: 1700000000000 },
      { kind: 'listen', actor: 'Alice', target: 'aku/riko/7a', at: 1700000000500 },
      { kind: 'say', actor: 'Alice', at: 1700000001000, body: 'hello @Bob', mentions: ['Bob'] },
      { kind: 'ignore', actor: 'Alice', target: 'aku/riko/7a', at: 1700000001500 },
      { kind: 'hold', actor: 'Host', at: 1700000002000, body: 'pause' },
      { kind: 'resume', actor: 'Host', at: 1700000003000 },
      { kind: 'done', actor: 'Alice', at: 1700000004000, body: 'bye' },
    ],
  });
  squareState.runtime.observations.Alice = { [formatActivityId(6)]: { state: 'seen', at: 1700000004000 } };
  squareState.runtime.observations.Bob = { [formatActivityId(2)]: { state: 'seen', at: 1700000001500 } };
  squareState.runtime.leases.Alice = { leaseId: 'lease-1', heartbeatAt: 3, expiresAt: 4 };

  const decoded = decodeSquare(encodeSquare(squareState));
  assert.deepEqual(decoded, squareState);
  assert.equal('version' in decoded.runtime, false);
});

test('a written snapshot is one SQUARE01 file with no runtime sidecar', async () => {
  const { dir, squarePath, squareState } = await writeFixture({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'say', actor: 'Alice', at: 2, body: 'hello' },
    ],
  });

  const bytes = fs.readFileSync(squarePath);
  assert.equal(bytes.subarray(0, 8).toString('ascii'), 'SQUARE01');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name !== path.basename(squarePath)), []);
  assert.deepEqual(await loadSquare(squarePath), squareState);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('file landing never reuses an index and publishes the complete next snapshot', async () => {
  const { dir, squarePath } = await writeFixture({
    acts: [{ kind: 'join', actor: 'Alice', at: 1 }],
  });
  const cell = createFileCell(squarePath);
  const appended = await express({ cell, clock: () => 2, location: squarePath }, 'Alice', 'hello @Alice', { force: true, mentions: ['Alice'] });
  assert.equal(appended.activity.id, 'act/1');
  const persisted = await loadSquare(squarePath);
  assert.deepEqual(persisted.acts.map((act) => act.index), [0, 1]);
  assert.equal(persisted.runtime.nextActIndex, 2);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => !name.endsWith('.lock') && name !== path.basename(squarePath)), []);
  await cell.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('file cells reuse unchanged snapshots without sharing caller state', async () => {
  const { dir, squarePath, squareState } = await writeFixture({ preamble: ['cached snapshot'] });
  const cell = createFileCell(squarePath);

  const first = await cell.read();
  first.state.preamble[0] = 'caller mutation';
  const second = await cell.read();

  assert.equal(first.version, 0);
  assert.equal(second.version, 0);
  assert.notEqual(first.state, second.state);
  assert.deepEqual(second.state, squareState);
  await cell.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('all production snapshot readers wait behind the artifact publication lock', async () => {
  const { dir, squarePath } = await writeFixture({ preamble: ['locked snapshot'] });
  const cell = createFileCell(squarePath);
  const originalOpen = fs.promises.open;
  const originalReadFile = fs.promises.readFile;

  async function assertReaderWaits(name, read) {
    let releaseLock;
    let lockHeld;
    const entered = new Promise((resolve) => { lockHeld = resolve; });
    const held = withSquareFileLock(squarePath, async () => {
      lockHeld();
      await new Promise((resolve) => { releaseLock = resolve; });
    });
    await entered;

    let targetOpened = false;
    fs.promises.open = async (...args) => {
      if (String(args[0]) === squarePath) targetOpened = true;
      return originalOpen(...args);
    };
    fs.promises.readFile = async (...args) => {
      if (String(args[0]) === squarePath) targetOpened = true;
      return originalReadFile(...args);
    };

    let pending;
    try {
      pending = read();
      for (let index = 0; index < 3; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(targetOpened, false, `${name} opened the artifact while publication held its lock`);
    } finally {
      releaseLock();
      await held;
      await pending;
    }
    assert.equal(targetOpened, true, `${name} never opened the artifact after publication released its lock`);
  }

  try {
    await assertReaderWaits('readSquareFile', () => readSquareFile(squarePath));
    await assertReaderWaits('probeSquareFile', () => probeSquareFile(squarePath));
    await assertReaderWaits('diagnoseSquareFile', () => diagnoseStoredSquareFile(squarePath));
    await assertReaderWaits('file cell read', () => cell.read());
  } finally {
    fs.promises.open = originalOpen;
    fs.promises.readFile = originalReadFile;
    await cell.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('file cells invalidate a cached snapshot for external writes, replacements, deletion, and recreation', async () => {
  const { dir, squarePath } = await writeFixture({ preamble: ['initial'] });
  const cell = createFileCell(squarePath);
  await cell.read();

  fs.writeFileSync(squarePath, encodeSquare(makeState({ preamble: ['in-place write'] })));
  const written = await cell.read();
  assert.equal(written.version, 1);
  assert.deepEqual(written.state.preamble, ['in-place write']);

  await writeSquareFile(squarePath, makeState({ preamble: ['replacement'] }));
  const replaced = await cell.read();
  assert.equal(replaced.version, 2);
  assert.deepEqual(replaced.state.preamble, ['replacement']);

  fs.unlinkSync(squarePath);
  await assert.rejects(cell.read(), /square file not found/);

  await writeSquareFile(squarePath, makeState({ preamble: ['recreated'] }));
  const recreated = await cell.read();
  assert.equal(recreated.version, 4);
  assert.deepEqual(recreated.state.preamble, ['recreated']);
  await cell.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('file transactions retain cached authority until committing the current snapshot', async () => {
  const { dir, squarePath } = await writeFixture({ preamble: ['initial'] });
  const cell = createFileCell(squarePath);
  await cell.read();
  await writeSquareFile(squarePath, makeState({ preamble: ['external'] }));

  const observedVersion = await cell.transact((state, version) => {
    assert.deepEqual(state.preamble, ['external']);
    return { result: version };
  });
  assert.equal(observedVersion, 1);

  await cell.transact((state) => {
    state.preamble[0] = 'uncommitted callback mutation';
    return { result: undefined };
  });
  assert.deepEqual((await cell.read()).state.preamble, ['external']);
  assert.deepEqual((await loadSquare(squarePath)).preamble, ['external']);

  await cell.transact((state) => {
    state.preamble[0] = 'committed';
    return { state, result: undefined };
  });
  assert.deepEqual((await cell.read()).state.preamble, ['committed']);
  assert.deepEqual((await loadSquare(squarePath)).preamble, ['committed']);
  await cell.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('file cells do not cache missing or malformed artifacts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-file-cell-failure-'));
  const squarePath = path.join(dir, 'SQUARE.square');
  const cell = createFileCell(squarePath);

  await assert.rejects(cell.read(), /square file not found/);
  await writeSquareFile(squarePath, makeState({ preamble: ['repaired missing'] }));
  assert.deepEqual((await cell.read()).state.preamble, ['repaired missing']);

  fs.writeFileSync(squarePath, 'malformed artifact');
  await assert.rejects(cell.read(), /Invalid square artifact/);
  await writeSquareFile(squarePath, makeState({ preamble: ['repaired malformed'] }));
  assert.deepEqual((await cell.read()).state.preamble, ['repaired malformed']);
  await cell.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadSquare rejects paths that are not .square artifacts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-ext-'));
  const file = path.join(dir, 'square.md');
  fs.writeFileSync(file, 'not a square');
  await assert.rejects(() => loadSquare(file), /must use the \.square extension/);
  assert.equal(await probeSquare(file), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('decodeSquare rejects bad framing, digest, and payload', () => {
  const squareState = makeState();
  const valid = encodeSquare(squareState);

  assert.throws(() => decodeSquare(valid.subarray(0, 10)), /truncated header/);
  assert.throws(() => decodeSquare(Buffer.concat([Buffer.from('NOTSQUARE'), valid.subarray(8)])), /bad magic or unsupported format version/);

  const truncated = Buffer.from(valid);
  truncated.writeUInt32BE(truncated.readUInt32BE(8) + 4, 8);
  assert.throws(() => decodeSquare(truncated), /payload length does not match/);

  const digest = Buffer.from(valid);
  digest[20] ^= 0xff;
  assert.throws(() => decodeSquare(digest), /payload digest mismatch/);

  const notGzip = envelope(SQUARE_MAGIC, Buffer.from('not-gzip'));
  assert.throws(() => decodeSquare(notGzip), /not valid gzip/);

  const notJson = envelope(SQUARE_MAGIC, zlib.gzipSync(Buffer.from('not-json')));
  assert.throws(() => decodeSquare(notJson), /not valid JSON/);
});

test('decodeSquare rejects malformed snapshot schema and a nextActIndex behind history', () => {
  const squareState = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'say', actor: 'Alice', at: 2, body: 'hello @Bob', mentions: ['Bob'] },
    ],
  });

  const behind = structuredClone(squareState);
  behind.runtime.nextActIndex = 1;
  assert.throws(() => encodeSquare(behind), /nextActIndex is behind/);

  const reused = structuredClone(squareState);
  reused.acts[1].index = 0;
  assert.throws(() => encodeSquare(reused), /snapshot schema is malformed/);

  const extraRuntime = structuredClone(squareState);
  extraRuntime.runtime.version = 2;
  assert.throws(() => encodeSquare(extraRuntime), /snapshot schema is malformed/);

  const invalidObservation = structuredClone(squareState);
  invalidObservation.runtime.observations.Alice = { bad: { state: 'seen', at: 1 } };
  assert.throws(() => encodeSquare(invalidObservation), /snapshot schema is malformed/);

  const invalidLease = structuredClone(squareState);
  invalidLease.runtime.leases.Alice = { leaseId: 'lease', heartbeatAt: 2, expiresAt: 1 };
  assert.throws(() => encodeSquare(invalidLease), /snapshot schema is malformed/);

  const beside = structuredClone(squareState);
  beside.acts[1].reach = { beside: 'Bob' };
  assert.throws(() => encodeSquare(beside), /snapshot schema is malformed/);

  const malformedListen = makeState({ acts: [{ kind: 'listen', actor: 'Alice', at: 1 }] });
  assert.throws(() => encodeSquare(malformedListen), /snapshot schema is malformed/);

  const extraIgnore = makeState({ acts: [{ kind: 'ignore', actor: 'Alice', target: 'Bob', at: 1, route: 'mention' }] });
  assert.throws(() => encodeSquare(extraIgnore), /snapshot schema is malformed/);
});

test('codec rejects future observation references', () => {
  const squareState = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'Bob', at: 2 },
    ],
  });

  const futureObservation = structuredClone(squareState);
  futureObservation.runtime.observations.Bob = { [formatActivityId(2)]: { state: 'seen', at: 3 } };
  assert.throws(() => encodeSquare(futureObservation), /runtime references an unassigned activity index/);

  const underscoreObservation = structuredClone(squareState);
  underscoreObservation.runtime.observations.Bob = { [['act', '1'].join('_')]: { state: 'seen', at: 3 } };
  assert.throws(() => encodeSquare(underscoreObservation), /snapshot schema is malformed/);
});

test('archived activity references remain valid below nextActIndex', () => {
  const squareState = makeState({
    acts: [{ kind: 'say', actor: 'Alice', at: 5, body: 'later @Bob', mentions: ['Bob'] }],
  });
  squareState.acts[0].index = 4;
  squareState.runtime.nextActIndex = 5;
  squareState.runtime.observations.Bob = { [formatActivityId(1)]: { state: 'seen', at: 2 } };
  assert.deepEqual(decodeSquare(encodeSquare(squareState)), squareState);
});

test('a future observation cannot persist and suppress the next real mention', async () => {
  const { dir, squarePath } = await writeFixture({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'Bob', at: 2 },
    ],
  });
  const poisoned = await loadSquare(squarePath);
  poisoned.runtime.observations.Bob = {
    [formatActivityId(poisoned.runtime.nextActIndex)]: { state: 'seen', at: 3 },
  };
  await assert.rejects(() => writeSquareFile(squarePath, poisoned), /runtime references an unassigned activity index/);

  const cell = createFileCell(squarePath);
  await express({ cell, clock: () => 3, location: squarePath }, 'Alice', 'hey @Bob', { force: true, mentions: ['Bob'] });
  const persisted = await loadSquare(squarePath);
  assert.equal(persisted.acts.at(-1).index, 2);
  assert.deepEqual(deriveDeliveryModel(persisted).pendingFor('Bob').map((item) => item.item.index), [2]);
  await cell.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('say metadata roundtrips through the binary snapshot', () => {
  const squareState = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'Bob', at: 2 },
      { kind: 'say', actor: 'Alice', at: 3, body: 'center @Bob', mentions: ['Bob'] },
      { kind: 'say', actor: 'Alice', at: 4, body: 'bell', reach: 'bell', reply: 2 },
    ],
  });

  const decoded = decodeSquare(encodeSquare(squareState));
  assert.equal(decoded.acts[2].reach, undefined);
  assert.equal(decoded.acts[3].reach, 'bell');
  assert.equal(decoded.acts[3].reply, 2);
});

test('doctor reports unreadable snapshots without repairing them', async () => {
  const { dir, squarePath } = await writeFixture();
  const clean = await diagnoseSquareFile(squarePath);
  assert.equal(clean.unfixable, undefined);
  assert.equal(clean.state.runtime.nextActIndex, 0);

  fs.writeFileSync(squarePath, 'not a snapshot');
  const broken = await diagnoseSquareFile(squarePath);
  assert.match(broken.unfixable, /Invalid square artifact/);
  assert.equal(broken.state, undefined);
  assert.equal(fs.readFileSync(squarePath, 'utf8'), 'not a snapshot');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createSquareState builds a snapshot from options and stdin without Markdown markers', async () => {
  const squareState = await createSquareState({ force: true, hardCap: null, throttlePerMinute: 4 }, '## Topic\n\nHost context');
  assert.equal(squareState.hardCap, null);
  assert.equal(squareState.throttlePerMinute, 4);
  assert.deepEqual(squareState.preamble, ['## Topic', '', 'Host context']);
  assert.ok(squareState.warmup.some((line) => line.includes('stepped into the square')));
  assert.deepEqual(squareState.acts, []);
  assert.deepEqual(squareState.runtime, emptyRuntimeState());
});
