import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  Square, deliveryLedgerMutedUntil, discover, muteDeliveryLedger,
} from '../dist/api/square-api.js';
import { DeliveryLedger } from '../dist/ledger/delivery-ledger.js';
import { canonicalPath } from '../dist/storage/canonical-path.js';
import { seatMuteId, seatMutePrefix } from '../dist/app/square-notification-mute.js';
import { renderSquareList, renderStatusResult } from '../dist/surfaces/operation-presentation.js';
import { run, withName } from './square-cli-helpers.js';

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-mute-'));
  const file = path.join(root, 'SQUARE.square');
  const ledgerLocation = options.ledgerLocation ?? path.join(root, 'delivery.sqlite');
  let now = options.now ?? 1000;
  const clock = () => now;
  const square = await Square.build({ path: file, markdown: 'Mute scene', ledgerLocation, clock });
  const alice = (await square.join('Alice', { owner: 'test:alice' })).participant;
  const bob = (await square.join('Bob', { owner: 'test:bob' })).participant;
  t.after(async () => { await square.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, ledgerLocation, square, alice, bob, clock,
    setNow(value) { now = value; return now; },
  };
}

async function suppression(location, clock, owner, id) {
  const ledger = await DeliveryLedger.open({ location, clock });
  try { return await ledger.suppression({ owner, id }); }
  finally { await ledger.close(); }
}

function globalHoldCount(location) {
  const db = new DatabaseSync(location, { readOnly: true });
  try { return db.prepare("SELECT COUNT(*) AS n FROM suppressions WHERE owner IS NULL AND id='ledger-mute'").get().n; }
  finally { db.close(); }
}

test('global and captured-seat holds are independent and repeat only their own deadline', async (t) => {
  const f = await fixture(t);
  const location = await canonicalPath(f.file);
  const prefix = seatMutePrefix(location, { participant: 'Alice', generation: f.alice.generation });
  const id = seatMuteId('test:alice', prefix);

  assert.deepEqual(await f.alice.mute({ duration: '100ms' }), { mutedUntil: 1100 });
  assert.equal((await suppression(f.ledgerLocation, f.clock, 'test:alice', id)).expiresAt, 1100);
  assert.equal(await deliveryLedgerMutedUntil({ ledgerLocation: f.ledgerLocation, clock: f.clock }), null);

  assert.deepEqual(await muteDeliveryLedger({ duration: '50ms', ledgerLocation: f.ledgerLocation, clock: f.clock }), { mutedUntil: 1050 });
  assert.equal(await deliveryLedgerMutedUntil({ ledgerLocation: f.ledgerLocation, clock: f.clock }), 1050);
  assert.equal((await suppression(f.ledgerLocation, f.clock, 'test:alice', id)).expiresAt, 1100);

  assert.deepEqual(await f.alice.mute({ duration: '200ms' }), { mutedUntil: 1200 });
  assert.equal(await deliveryLedgerMutedUntil({ ledgerLocation: f.ledgerLocation, clock: f.clock }), 1050);
  await f.bob.mute({ duration: '300ms' });
  const bobPrefix = seatMutePrefix(location, { participant: 'Bob', generation: f.bob.generation });
  const bobId = seatMuteId('test:bob', bobPrefix);
  assert.equal((await suppression(f.ledgerLocation, f.clock, 'test:bob', bobId)).expiresAt, 1300);

  assert.deepEqual(await f.alice.mute({ duration: 'off' }), { mutedUntil: null });
  assert.equal(await suppression(f.ledgerLocation, f.clock, 'test:alice', id), undefined);
  assert.equal((await suppression(f.ledgerLocation, f.clock, 'test:bob', bobId)).expiresAt, 1300);
  assert.equal(await deliveryLedgerMutedUntil({ ledgerLocation: f.ledgerLocation, clock: f.clock }), 1050);

  assert.deepEqual(await muteDeliveryLedger({ duration: 'off', ledgerLocation: f.ledgerLocation, clock: f.clock }), { mutedUntil: null });
  assert.equal(await deliveryLedgerMutedUntil({ ledgerLocation: f.ledgerLocation, clock: f.clock }), null);
  assert.equal((await suppression(f.ledgerLocation, f.clock, 'test:bob', bobId)).expiresAt, 1300);
});

test('independent exact, prefix and permanent holds survive resuming both scopes', async (t) => {
  const f = await fixture(t);
  const ledger = await DeliveryLedger.open({ location: f.ledgerLocation, clock: f.clock });
  t.after(() => ledger.close());
  const exact = await ledger.suppress({ owner: 'test:alice', key: ['kept', 'exact'], scope: 'exact', expiresAt: 5000 });
  const prefix = await ledger.suppress({ owner: 'test:alice', key: ['kept'], scope: 'prefix', expiresAt: 5000 });
  const permanent = await ledger.suppress({ owner: 'test:bob', key: ['gone'], scope: 'exact' });

  await f.alice.mute({ duration: '100ms' });
  await muteDeliveryLedger({ duration: '100ms', ledgerLocation: f.ledgerLocation, clock: f.clock });
  await f.alice.mute({ duration: 'off' });
  await muteDeliveryLedger({ duration: 'off', ledgerLocation: f.ledgerLocation, clock: f.clock });

  assert.ok(await ledger.suppression({ owner: 'test:alice', id: exact.id }));
  assert.ok(await ledger.suppression({ owner: 'test:alice', id: prefix.id }));
  assert.ok(await ledger.suppression({ owner: 'test:bob', id: permanent.id }));
});

test('one ledger hold blocks every owner and resumes retained work after expiry without GC or another write', async (t) => {
  const f = await fixture(t);
  await muteDeliveryLedger({ duration: '100ms', ledgerLocation: f.ledgerLocation, clock: f.clock });
  const ledger = await DeliveryLedger.open({ location: f.ledgerLocation, clock: f.clock });
  t.after(() => ledger.close());
  const aliceSession = await ledger.session('test:alice'), bobSession = await ledger.session('test:bob');
  assert.equal((await ledger.post({ owner: 'test:alice', key: ['producer', 'held'], text: 'retained' })).status, 'suppressed');
  assert.equal((await ledger.post({ owner: 'test:bob', key: ['producer', 'bob'], text: 'retained' })).status, 'suppressed');
  assert.deepEqual(await ledger.pending('test:alice', { generation: aliceSession.generation }), []);
  assert.deepEqual(await ledger.pending('test:bob', { generation: bobSession.generation }), []);
  assert.equal(globalHoldCount(f.ledgerLocation), 1);

  f.setNow(1100);
  assert.equal(await deliveryLedgerMutedUntil({ ledgerLocation: f.ledgerLocation, clock: f.clock }), null);
  assert.deepEqual((await ledger.pending('test:alice', { generation: aliceSession.generation })).map(card => card.key), [['producer', 'held']]);
  assert.deepEqual((await ledger.pending('test:bob', { generation: bobSession.generation })).map(card => card.key), [['producer', 'bob']]);
  assert.equal(globalHoldCount(f.ledgerLocation), 1, 'reads did not collect the expired row');
});

test('a global-only configured-clock hold survives a new express and resumes its retained card at the deadline', async (t) => {
  const f = await fixture(t);
  const squarePath = await canonicalPath(f.file);
  assert.deepEqual(await muteDeliveryLedger({ duration: '100ms', ledgerLocation: f.ledgerLocation, clock: f.clock }), { mutedUntil: 1100 });
  assert.equal((await f.bob.express('held by the square', { mentions: ['Alice'], force: true })).activity.id, 'act/2');
  assert.equal(await deliveryLedgerMutedUntil({ ledgerLocation: f.ledgerLocation, clock: f.clock }), 1100, 'a new write does not renew or drop the global hold');
  assert.equal(globalHoldCount(f.ledgerLocation), 1);
  const ledger = await DeliveryLedger.open({ location: f.ledgerLocation, clock: f.clock });
  t.after(() => ledger.close());
  const session = await ledger.session('test:alice');
  assert.deepEqual(await ledger.pending('test:alice', { generation: session.generation }), []);
  const seatId = seatMuteId('test:alice', seatMutePrefix(squarePath, { participant: 'Alice', generation: f.alice.generation }));
  assert.equal(await suppression(f.ledgerLocation, f.clock, 'test:alice', seatId), undefined, 'global-only holds no seat row');

  f.setNow(1100);
  assert.equal(await deliveryLedgerMutedUntil({ ledgerLocation: f.ledgerLocation, clock: f.clock }), null);
  assert.deepEqual((await ledger.pending('test:alice', { generation: session.generation })).map(card => card.key),
    [['square', squarePath, 'recipient', 'alice', 'join', f.alice.generation, 'act', '2']]);
  assert.equal(globalHoldCount(f.ledgerLocation), 1, 'reads did not collect the expired hold');
});

test('a seat-only configured-clock hold survives a new express and resumes that seat without touching another owner', async (t) => {
  const f = await fixture(t);
  const squarePath = await canonicalPath(f.file);
  const seatId = seatMuteId('test:alice', seatMutePrefix(squarePath, { participant: 'Alice', generation: f.alice.generation }));
  assert.deepEqual(await f.alice.mute({ duration: '100ms' }), { mutedUntil: 1100 });
  assert.equal(await deliveryLedgerMutedUntil({ ledgerLocation: f.ledgerLocation, clock: f.clock }), null, 'seat-only holds no global deadline');
  assert.equal((await f.bob.express('held for one seat', { mentions: ['Alice'], force: true })).activity.id, 'act/2');
  assert.equal((await f.alice.express('delivered next door', { mentions: ['Bob'], force: true })).activity.id, 'act/3');
  const ledger = await DeliveryLedger.open({ location: f.ledgerLocation, clock: f.clock });
  t.after(() => ledger.close());
  const aliceSession = await ledger.session('test:alice'), bobSession = await ledger.session('test:bob');
  assert.deepEqual(await ledger.pending('test:alice', { generation: aliceSession.generation }), []);
  assert.deepEqual((await ledger.pending('test:bob', { generation: bobSession.generation })).map(card => card.key),
    [['square', squarePath, 'recipient', 'bob', 'join', f.bob.generation, 'act', '3']], 'another owner writes and receives while the hold stands');
  assert.equal((await suppression(f.ledgerLocation, f.clock, 'test:alice', seatId)).expiresAt, 1100, 'a new write does not renew, replace or drop the seat hold');
  assert.equal(globalHoldCount(f.ledgerLocation), 0, 'seat-only holds no global row');

  f.setNow(1100);
  assert.equal(await deliveryLedgerMutedUntil({ ledgerLocation: f.ledgerLocation, clock: f.clock }), null);
  assert.deepEqual((await ledger.pending('test:alice', { generation: aliceSession.generation })).map(card => card.key),
    [['square', squarePath, 'recipient', 'alice', 'join', f.alice.generation, 'act', '2']]);
});

test('a seat replacement during hold installation releases only the obsolete generation hold', async (t) => {
  const f = await fixture(t);
  const squarePath = await canonicalPath(f.file);
  const oldId = seatMuteId('test:alice', seatMutePrefix(squarePath, { participant: 'Alice', generation: f.alice.generation }));
  const second = await Square.at({ path: f.file, ledgerLocation: f.ledgerLocation, clock: f.clock });
  t.after(() => second.close());
  const original = DeliveryLedger.prototype.setSuppression;
  let replaced, armed = true;
  t.mock.method(DeliveryLedger.prototype, 'setSuppression', async function (input, signal) {
    if (armed) {
      armed = false;
      replaced = (await second.join('Alice', { owner: 'test:alice', takeover: true })).participant;
    }
    return original.call(this, input, signal);
  });
  await assert.rejects(f.alice.mute({ duration: '100ms' }), /seat has been replaced/);
  assert.equal(await suppression(f.ledgerLocation, f.clock, 'test:alice', oldId), undefined, 'the obsolete generation hold is released');
  const newId = seatMuteId('test:alice', seatMutePrefix(squarePath, { participant: 'Alice', generation: replaced.generation }));
  assert.notEqual(newId, oldId);
  assert.equal(await suppression(f.ledgerLocation, f.clock, 'test:alice', newId), undefined, 'the replacement generation was never held');
});

test('a seat hold scopes exactly one captured join while other seats and squares stay free', async (t) => {
  const f = await fixture(t);
  const otherFile = path.join(f.root, 'OTHER.square');
  const other = await Square.build({ path: otherFile, markdown: 'Other', ledgerLocation: f.ledgerLocation, clock: f.clock });
  t.after(() => other.close());
  const otherAlice = (await other.join('Alice', { owner: 'test:alice' })).participant;
  const secondBob = (await f.square.join('Bob2', { owner: 'test:bob' })).participant;

  await f.alice.mute({ duration: '100ms' });
  const prefix = seatMutePrefix(await canonicalPath(f.file), { participant: 'Alice', generation: f.alice.generation });
  assert.ok(await suppression(f.ledgerLocation, f.clock, 'test:alice', seatMuteId('test:alice', prefix)));
  const otherPrefix = seatMutePrefix(await canonicalPath(otherFile), { participant: 'Alice', generation: otherAlice.generation });
  assert.equal(await suppression(f.ledgerLocation, f.clock, 'test:alice', seatMuteId('test:alice', otherPrefix)), undefined);
  const bobPrefix = seatMutePrefix(await canonicalPath(f.file), { participant: 'Bob2', generation: secondBob.generation });
  assert.equal(await suppression(f.ledgerLocation, f.clock, 'test:bob', seatMuteId('test:bob', bobPrefix)), undefined);
});

test('a seat hold suppresses only its captured recipient card, not a same-owner seat or another square', async (t) => {
  const f = await fixture(t, { now: Date.now() });
  const alice2 = (await f.square.join('Alice2', { owner: 'test:alice' })).participant;
  const otherFile = path.join(f.root, 'ELSEWHERE.square');
  const other = await Square.build({ path: otherFile, markdown: 'Elsewhere', ledgerLocation: f.ledgerLocation, clock: f.clock });
  t.after(() => other.close());
  const otherAlice = (await other.join('Alice', { owner: 'test:alice' })).participant;
  const otherBob = (await other.join('OtherBob', { owner: 'test:bob' })).participant;

  await f.alice.mute({ duration: '60s' });
  await f.bob.express('for both seats', { mentions: ['Alice', 'Alice2'], force: true });
  await otherBob.express('elsewhere for Alice', { mentions: ['Alice'], force: true });

  const ledger = await DeliveryLedger.open({ location: f.ledgerLocation, clock: f.clock });
  t.after(() => ledger.close());
  const session = await ledger.session('test:alice');
  const pending = await ledger.pending('test:alice', { generation: session.generation });
  const location = await canonicalPath(f.file), otherLocation = await canonicalPath(otherFile);
  const firstSquare = pending.filter(card => card.key[1] === location);
  assert.deepEqual(firstSquare.map(card => card.key[3]), ['alice2']);
  assert.equal(pending.some(card => card.key[1] === otherLocation && card.key[3] === 'alice'), true);
  const claim = await ledger.claimPresentation('test:alice', { generation: session.generation, budgetChars: 10_000 });
  assert.deepEqual(claim.cards.filter(card => card.key[1] === location).map(card => card.key[3]), ['alice2']);
  await claim.settle('released');

  await f.alice.mute({ duration: 'off' });
  const resumed = await ledger.pending('test:alice', { generation: session.generation });
  assert.equal(resumed.some(card => card.key[1] === location && card.key[3] === 'alice'), true, 'the suppressed card was retained');
  assert.equal(alice2.name, 'Alice2');
  assert.equal(otherAlice.name, 'Alice');
});

test('manual pending, ACK and perceive stay usable under a global hold without changing membership or presence', async (t) => {
  const f = await fixture(t, { now: Date.now() });
  const first = (await f.bob.express('one for Alice', { mentions: ['Alice'], force: true })).activity;
  const second = (await f.bob.express('two for Alice', { mentions: ['Alice'], force: true })).activity;
  const before = (await f.square.status()).participants.map(({ name, presence, deliveryAvailable }) => ({ name, presence, deliveryAvailable }));
  await muteDeliveryLedger({ duration: '60s', ledgerLocation: f.ledgerLocation, clock: f.clock });

  assert.deepEqual((await f.alice.pending()).activities.map(activity => activity.id), [first.id, second.id]);
  assert.deepEqual(await f.alice.ack([second.id]), { consumed: 1 });
  assert.deepEqual((await f.alice.perceive()).activities.map(activity => activity.id), [first.id]);
  assert.notEqual(await deliveryLedgerMutedUntil({ ledgerLocation: f.ledgerLocation, clock: f.clock }), null);
  const after = (await f.square.status()).participants.map(({ name, presence, deliveryAvailable }) => ({ name, presence, deliveryAvailable }));
  assert.deepEqual(after, before);
  assert.equal(after.find(person => person.name === 'Alice').presence, 'active');
  assert.equal(after.find(person => person.name === 'Bob').presence, 'active');
});

test('a stale handle cannot change a newer join generation’s hold', async (t) => {
  const f = await fixture(t);
  const location = await canonicalPath(f.file);
  const oldPrefix = seatMutePrefix(location, { participant: 'Alice', generation: f.alice.generation });
  const oldId = seatMuteId('test:alice', oldPrefix);
  await f.alice.mute({ duration: '100ms' });
  await f.alice.done();
  const current = (await f.square.join('Alice', { owner: 'test:alice' })).participant;
  await assert.rejects(f.alice.mute({ duration: '50ms' }), error => error.code === 'already_joined');
  await current.mute({ duration: '70ms' });
  const currentPrefix = seatMutePrefix(location, { participant: 'Alice', generation: current.generation });
  const currentId = seatMuteId('test:alice', currentPrefix);
  assert.equal((await suppression(f.ledgerLocation, f.clock, 'test:alice', currentId)).expiresAt, 1070);
  await assert.rejects(f.alice.mute({ duration: 'off' }), error => error.code === 'already_joined');
  assert.equal((await suppression(f.ledgerLocation, f.clock, 'test:alice', currentId)).expiresAt, 1070);
  assert.equal((await suppression(f.ledgerLocation, f.clock, 'test:alice', oldId)).expiresAt, 1100);
});

test('status, participants and discovery expose active deadlines without creating an absent ledger', async (t) => {
  const f = await fixture(t);
  await f.alice.mute({ duration: '100ms' });
  await muteDeliveryLedger({ duration: '50ms', ledgerLocation: f.ledgerLocation, clock: f.clock });

  const before = (await f.square.status()).participants.map(({ name, presence, deliveryAvailable }) => ({ name, presence, deliveryAvailable }));
  const status = await f.square.status({ viewer: 'Alice', observe: true });
  assert.deepEqual(status.participants.map(({ name, presence, deliveryAvailable }) => ({ name, presence, deliveryAvailable })), before);
  assert.equal(status.ledgerMutedUntil, 1050);
  assert.equal(status.participants.find(person => person.name === 'Alice').mutedUntil, 1100);
  assert.equal(status.participants.find(person => person.name === 'Bob').mutedUntil, undefined);
  const statusText = renderStatusResult(f.file, status);
  assert.match(statusText, /notifications paused until/);
  assert.match(statusText, /muted until/);

  const listed = await discover({ cwd: f.root }, { owner: 'test:alice', ledgerLocation: f.ledgerLocation, clock: f.clock });
  assert.equal(listed.ledgerMutedUntil, 1050);
  const item = listed.items.find(entry => entry.path === path.basename(f.file));
  assert.deepEqual(item.joined.map(seat => [seat.name, seat.pending, seat.mutedUntil]), [['Alice', 0, 1100]]);
  assert.equal(Object.hasOwn(item.joined[0], 'seat'), false);
  assert.match(renderSquareList(listed, { now: 1000, depth: 4, limit: 20 }), /notifications paused until/);
  assert.match(renderSquareList({ items: [], total: 0, stopped: false, remaining: 0, ledgerMutedUntil: 1050 }, { now: 1000, depth: 4, limit: 20 }), /notifications paused until/);

  const participants = await f.square.participants();
  assert.equal(participants.participants.find(person => person.name === 'Alice').mutedUntil, 1100);
  assert.equal((await f.square.participants({ local: true })).participants.find(person => person.name === 'Alice').mutedUntil, undefined);

  f.setNow(1060);
  assert.equal((await f.square.status()).ledgerMutedUntil, undefined);
  assert.equal((await f.square.status()).participants.find(person => person.name === 'Alice').mutedUntil, 1100);
  f.setNow(1110);
  assert.equal((await f.square.status()).participants.find(person => person.name === 'Alice').mutedUntil, undefined);

  const absent = path.join(f.root, 'absent.sqlite');
  const square = await Square.at({ path: f.file, ledgerLocation: absent, clock: f.clock });
  try {
    await square.status();
    await square.participants();
  } finally { await square.close(); }
  await discover({ cwd: f.root }, { owner: 'test:alice', ledgerLocation: absent, clock: f.clock });
  assert.equal(fs.existsSync(absent), false);
});

test('CLI mute sets and clears holds in either scope', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-mute-cli-'));
  const file = path.join(root, 'CLI.square');
  const ledger = path.join(root, 'delivery.sqlite');
  const env = { SQUARE_DELIVERY: ledger, SQUARE_NOW_MS: '5000' };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(run(['build', '--location', file, '--force'], { cwd: root, env, input: '# CLI mute\n' }).status, 0);
  const joined = run(withName(file, 'Alice', ['join']), { cwd: root, env });
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);

  const localText = run(withName(file, 'Alice', ['mute', '2m']), { cwd: root, env });
  assert.equal(localText.status, 0, localText.stderr);
  assert.match(localText.stdout, /@Alice steps back from notifications until/);
  const globalText = run(['mute', '2m'], { cwd: root, env });
  assert.equal(globalText.status, 0, globalText.stderr);
  assert.match(globalText.stdout, /notifications pause until/);

  assert.match(run(withName(file, 'Alice', ['status']), { cwd: root, env }).stdout, /muted until/);
  const unmutedLocal = run(withName(file, 'Alice', ['mute', 'off']), { cwd: root, env });
  assert.equal(unmutedLocal.status, 0, unmutedLocal.stderr);
  assert.match(unmutedLocal.stdout, /@Alice ends their notification hold/);
  const unmutedGlobal = run(['mute', 'off'], { cwd: root, env });
  assert.equal(unmutedGlobal.status, 0, unmutedGlobal.stderr);
  assert.match(unmutedGlobal.stdout, /the notification hold ends/);

  const missing = path.join(root, 'missing.sqlite');
  const refused = run(['--as', 'Alice', 'mute', '1m'], { cwd: root, env: { SQUARE_DELIVERY: missing, SQUARE_NOW_MS: '5000' } });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /as needs a square location/);
  assert.equal(fs.existsSync(missing), false);
  const help = run(['mute', '--help'], { cwd: root });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Pause or resume automatic notifications/);
  assert.match(help.stdout, /Omit to set the hold for the entire ledger\./);
});

test('invalid global mutes refuse before creating a ledger', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-mute-invalid-'));
  const location = path.join(root, 'must-stay-absent.sqlite');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(muteDeliveryLedger({ duration: '0ms', ledgerLocation: location }), { code: 'invalid_args' });
  await assert.rejects(muteDeliveryLedger({ duration: `${Number.MAX_SAFE_INTEGER}ms`, ledgerLocation: location, clock: () => 1 }), RangeError);
  assert.equal(fs.existsSync(location), false);
});

test('read-only ledger opens never create a file and ignore expired rows by the configured clock', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-mute-readonly-'));
  const location = path.join(root, 'absent.sqlite');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(DeliveryLedger.open({ location, clock: () => 10, readOnly: true }), { code: 'ENOENT' });
  assert.equal(fs.existsSync(location), false);

  let now = 100;
  const ledger = await DeliveryLedger.open({ location, clock: () => now });
  t.after(() => ledger.close());
  assert.deepEqual(await ledger.mute({ durationMs: 50 }), { mutedUntil: 150 });
  const readOnly = await DeliveryLedger.open({ location, clock: () => now, readOnly: true });
  try {
    assert.equal(await readOnly.mutedUntil(), 150);
    now = 150;
    assert.equal(await readOnly.mutedUntil(), null);
    assert.equal(globalHoldCount(location), 1);
  } finally { await readOnly.close(); }
});
