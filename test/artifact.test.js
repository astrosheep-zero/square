import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import {
  createSquareDoc,
  decodeArchive,
  decodeSquare,
  diagnoseSquareFile,
  emptyRuntimeState,
  encodeArchive,
  encodeSquare,
  loadArchive,
  loadSquare,
  probeSquare,
  writeArchiveFile,
  writeSquareFile,
} from '../dist/artifact.js';
import { deriveDeliveryModel } from '../dist/delivery.js';
import { formatActivityId } from '../dist/square-core.js';
import { appendAct } from '../dist/square-application.js';

const SQUARE_MAGIC = Buffer.from('SQUARE01', 'ascii');
const ARCHIVE_MAGIC = Buffer.from('SQARCH01', 'ascii');

function withIndexes(acts) {
  return acts.map((act, index) => ({ ...act, index }));
}

function makeDoc(overrides = {}) {
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

function writeFixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-artifact-'));
  const squarePath = path.join(dir, 'SQUARE.square');
  const doc = makeDoc(overrides);
  writeSquareFile(squarePath, doc);
  return { dir, squarePath, doc };
}

function envelope(magic, payload) {
  const header = Buffer.alloc(magic.length + 4 + 32);
  magic.copy(header, 0);
  header.writeUInt32BE(payload.length, magic.length);
  crypto.createHash('sha256').update(payload).digest().copy(header, magic.length + 4);
  return Buffer.concat([header, payload]);
}

test('encode/decode roundtrip preserves document history and runtime', () => {
  const doc = makeDoc({
    hardCap: null,
    throttlePerMinute: 5,
    acts: [
      { kind: 'join', actor: 'Alice', at: 1700000000000 },
      { kind: 'say', actor: 'Alice', at: 1700000001000, body: 'hello @Bob' },
      { kind: 'hold', actor: 'Host', at: 1700000002000, body: 'pause' },
      { kind: 'resume', actor: 'Host', at: 1700000003000 },
      { kind: 'done', actor: 'Alice', at: 1700000004000, body: 'bye' },
    ],
  });
  doc.runtime.cursors.Alice = { consumedThroughIndex: 4, updatedAt: 1700000004000 };
  doc.runtime.deliveryReceipts.Bob = { [formatActivityId(1)]: { status: 'delivered', at: 1700000001500 } };
  doc.runtime.leases.Alice = { leaseId: 'lease-1', heartbeatAt: 3, expiresAt: 4 };
  doc.runtime.notifyLeases[JSON.stringify([formatActivityId(1), 'bob'])] = { leaseId: 'n1', expiresAt: 9, phase: 'claimed' };

  const decoded = decodeSquare(encodeSquare(doc));
  assert.deepEqual(decoded, doc);
  assert.equal('version' in decoded.runtime, false);
});

test('a written snapshot is one SQUARE01 file with no runtime sidecar', () => {
  const { dir, squarePath, doc } = writeFixture({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'say', actor: 'Alice', at: 2, body: 'hello' },
    ],
  });

  const bytes = fs.readFileSync(squarePath);
  assert.equal(bytes.subarray(0, 8).toString('ascii'), 'SQUARE01');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name !== path.basename(squarePath)), []);
  assert.deepEqual(loadSquare(squarePath), doc);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('appendAct never reuses an index and publishes the complete next snapshot', () => {
  const { dir, squarePath } = writeFixture({
    acts: [{ kind: 'join', actor: 'Alice', at: 1 }],
  });
  const loaded = loadSquare(squarePath);
  const appended = appendAct(squarePath, loaded, { kind: 'say', actor: 'Alice', at: 2, body: 'hello' });
  assert.equal(appended.index, 1);
  const persisted = loadSquare(squarePath);
  assert.deepEqual(persisted.acts.map((act) => act.index), [0, 1]);
  assert.equal(persisted.runtime.nextActIndex, 2);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => !name.endsWith('.lock') && name !== path.basename(squarePath)), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadSquare rejects paths that are not .square artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-ext-'));
  const file = path.join(dir, 'square.md');
  fs.writeFileSync(file, 'not a square');
  assert.throws(() => loadSquare(file), /must use the \.square extension/);
  assert.equal(probeSquare(file), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('decodeSquare rejects bad framing, digest, and payload', () => {
  const doc = makeDoc();
  const valid = encodeSquare(doc);

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
  const doc = makeDoc({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'say', actor: 'Alice', at: 2, body: 'hello @Bob' },
    ],
  });

  const behind = structuredClone(doc);
  behind.runtime.nextActIndex = 1;
  assert.throws(() => encodeSquare(behind), /nextActIndex is behind/);

  const reused = structuredClone(doc);
  reused.acts[1].index = 0;
  assert.throws(() => encodeSquare(reused), /snapshot schema is malformed/);

  const extraRuntime = structuredClone(doc);
  extraRuntime.runtime.version = 2;
  assert.throws(() => encodeSquare(extraRuntime), /snapshot schema is malformed/);

  const invalidReceipt = structuredClone(doc);
  invalidReceipt.runtime.deliveryReceipts.Alice = { bad: { status: 'delivered', at: 1 } };
  assert.throws(() => encodeSquare(invalidReceipt), /snapshot schema is malformed/);

  const invalidLease = structuredClone(doc);
  invalidLease.runtime.notifyLeases.attention = {
    leaseId: 'lease',
    expiresAt: 1,
    phase: 'dispatching',
    attemptN: 1,
    routeKind: 'invalid',
  };
  assert.throws(() => encodeSquare(invalidLease), /snapshot schema is malformed/);

  const beside = structuredClone(doc);
  beside.acts[1].reach = { beside: 'Bob' };
  assert.throws(() => encodeSquare(beside), /snapshot schema is malformed/);
});

test('codec rejects future cursor, receipt, and notify-lease references', () => {
  const doc = makeDoc({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'Bob', at: 2 },
    ],
  });

  const futureCursor = structuredClone(doc);
  futureCursor.runtime.cursors.Bob = { consumedThroughIndex: 2, updatedAt: 3 };
  assert.throws(() => encodeSquare(futureCursor), /runtime references an unassigned activity index/);

  const futureReceipt = structuredClone(doc);
  futureReceipt.runtime.deliveryReceipts.Bob = { [formatActivityId(2)]: { status: 'delivered', at: 3 } };
  assert.throws(() => encodeSquare(futureReceipt), /runtime references an unassigned activity index/);

  const futureLease = structuredClone(doc);
  futureLease.runtime.notifyLeases[JSON.stringify([formatActivityId(2), 'bob'])] = {
    leaseId: 'n1',
    expiresAt: 9,
    phase: 'claimed',
  };
  assert.throws(() => encodeSquare(futureLease), /runtime references an unassigned activity index/);

  const malformedLease = structuredClone(doc);
  malformedLease.runtime.notifyLeases.attention = { leaseId: 'n1', expiresAt: 9, phase: 'claimed' };
  assert.throws(() => encodeSquare(malformedLease), /snapshot schema is malformed/);

  const mixedCaseLease = structuredClone(doc);
  mixedCaseLease.runtime.notifyLeases[JSON.stringify([formatActivityId(1), 'Bob'])] = {
    leaseId: 'n1',
    expiresAt: 9,
    phase: 'claimed',
  };
  assert.throws(() => encodeSquare(mixedCaseLease), /snapshot schema is malformed/);

  const underscoreReceipt = structuredClone(doc);
  underscoreReceipt.runtime.deliveryReceipts.Bob = { [['act', '1'].join('_')]: { status: 'delivered', at: 3 } };
  assert.throws(() => encodeSquare(underscoreReceipt), /snapshot schema is malformed/);
});

test('archived activity references remain valid below nextActIndex', () => {
  const doc = makeDoc({
    acts: [{ kind: 'say', actor: 'Alice', at: 5, body: 'later @Bob' }],
  });
  doc.acts[0].index = 4;
  doc.runtime.nextActIndex = 5;
  doc.runtime.cursors.Bob = { consumedThroughIndex: 1, updatedAt: 2 };
  doc.runtime.deliveryReceipts.Bob = { [formatActivityId(1)]: { status: 'delivered', at: 2 } };
  doc.runtime.notifyLeases[JSON.stringify([formatActivityId(1), 'bob'])] = { leaseId: 'n1', expiresAt: 9, phase: 'claimed' };
  assert.deepEqual(decodeSquare(encodeSquare(doc)), doc);
});

test('a future receipt cannot persist and suppress the next real mention', () => {
  const { dir, squarePath } = writeFixture({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'Bob', at: 2 },
    ],
  });
  const poisoned = loadSquare(squarePath);
  poisoned.runtime.deliveryReceipts.Bob = {
    [formatActivityId(poisoned.runtime.nextActIndex)]: { status: 'delivered', at: 3 },
  };
  assert.throws(() => writeSquareFile(squarePath, poisoned), /runtime references an unassigned activity index/);

  appendAct(squarePath, loadSquare(squarePath), { kind: 'say', actor: 'Alice', at: 3, body: 'hey @Bob' });
  const persisted = loadSquare(squarePath);
  assert.equal(persisted.acts.at(-1).index, 2);
  assert.deepEqual(deriveDeliveryModel(persisted).pendingFor('Bob').map((item) => item.item.index), [2]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('say metadata roundtrips through the binary snapshot', () => {
  const doc = makeDoc({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'Bob', at: 2 },
      { kind: 'say', actor: 'Alice', at: 3, body: 'center @Bob' },
      { kind: 'say', actor: 'Alice', at: 4, body: 'bell', reach: 'bell', reply: 2 },
    ],
  });

  const decoded = decodeSquare(encodeSquare(doc));
  assert.equal(decoded.acts[2].reach, undefined);
  assert.equal(decoded.acts[3].reach, 'bell');
  assert.equal(decoded.acts[3].reply, 2);
});

test('doctor reports unreadable snapshots without repairing them', () => {
  const { dir, squarePath } = writeFixture();
  const clean = diagnoseSquareFile(squarePath);
  assert.equal(clean.unfixable, undefined);
  assert.equal(clean.doc.runtime.nextActIndex, 0);

  fs.writeFileSync(squarePath, 'not a snapshot');
  const broken = diagnoseSquareFile(squarePath);
  assert.match(broken.unfixable, /Invalid square artifact/);
  assert.equal(broken.doc, undefined);
  assert.equal(fs.readFileSync(squarePath, 'utf8'), 'not a snapshot');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createSquareDoc builds a snapshot from options and stdin without Markdown markers', () => {
  const doc = createSquareDoc({ force: true, hardCap: null, throttlePerMinute: 4 }, '## Topic\n\nHost context');
  assert.equal(doc.hardCap, null);
  assert.equal(doc.throttlePerMinute, 4);
  assert.deepEqual(doc.preamble, ['## Topic', '', 'Host context']);
  assert.ok(doc.warmup.some((line) => line.includes('stepped into the square')));
  assert.deepEqual(doc.acts, []);
  assert.deepEqual(doc.runtime, emptyRuntimeState());
});

test('compact archives use SQARCH01 and never merge as runtime', () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 1000, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2000, index: 1 },
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-archive-'));
  const archivePath = path.join(dir, 'SQUARE.archive.square');
  writeArchiveFile(archivePath, acts);

  const bytes = fs.readFileSync(archivePath);
  assert.equal(bytes.subarray(0, 8).toString('ascii'), 'SQARCH01');
  assert.deepEqual(loadArchive(archivePath), acts);
  assert.deepEqual(decodeArchive(encodeArchive(acts)), acts);
  assert.throws(() => decodeSquare(bytes), /bad magic or unsupported format version/);
  assert.throws(() => decodeArchive(encodeSquare(makeDoc())), /bad magic or unsupported format version/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('probeSquare ignores files without SQUARE01 magic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-probe-'));
  const archive = path.join(dir, 'SQUARE.archive.square');
  writeArchiveFile(archive, [{ kind: 'join', actor: 'Alice', at: 1, index: 0 }]);
  assert.equal(probeSquare(archive), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
