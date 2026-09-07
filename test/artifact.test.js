import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  createSquareState,
  diagnoseSquareFile,
  emptyRuntimeState,
  loadSquare,
  probeSquare,
  writeSquareFile,
} from '../dist/artifact.js';
import { deriveDeliveryModel } from '../dist/delivery.js';
import { express } from '../dist/landing.js';
import { formatActivityId } from '../dist/square-core.js';
import { validateSquareState } from '../dist/square-state.js';
import { createFileCell, createMemoryCell } from '../dist/square-storage.js';

const APPLICATION_ID = 0x53515245;
const USER_VERSION = 1;

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

async function writeFixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-artifact-'));
  const squarePath = path.join(dir, 'SQUARE.square');
  const squareState = makeState(overrides);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await writeSquareFile(squarePath, squareState);
  return { dir, squarePath, squareState };
}

function readSnapshot(squarePath) {
  const database = new DatabaseSync(squarePath, { readOnly: true });
  try {
    const identity = database.prepare('PRAGMA application_id').get().application_id;
    const version = database.prepare('PRAGMA user_version').get().user_version;
    const journalMode = database.prepare('PRAGMA journal_mode').get().journal_mode;
    const row = database.prepare('SELECT id, revision, state FROM square_snapshot').get();
    const table = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'square_snapshot'").get().sql;
    return { identity, version, journalMode, row, table };
  } finally {
    database.close();
  }
}

function createRawDatabase(squarePath, options = {}) {
  const database = new DatabaseSync(squarePath);
  try {
    database.exec(`PRAGMA application_id = ${options.applicationId ?? APPLICATION_ID}`);
    database.exec(`PRAGMA user_version = ${options.userVersion ?? USER_VERSION}`);
    database.exec(options.schema ?? 'CREATE TABLE square_snapshot (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision >= 0), state TEXT NOT NULL)');
    if (options.row !== false) {
      database.prepare('INSERT INTO square_snapshot (id, revision, state) VALUES (?, ?, ?)').run(
        1,
        options.revision ?? 0,
        options.state ?? JSON.stringify(makeState()),
      );
    }
  } finally {
    database.close();
  }
}

function databaseBytes(squarePath) {
  return fs.readFileSync(squarePath);
}

test('requires the Node SQLite runtime promised by the package minimum', () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok(
    (major === 22 && minor >= 16) || major >= 24,
    `node ${process.versions.node} does not provide the supported SQLite runtime`,
  );
  assert.equal(typeof DatabaseSync, 'function');
  assert.equal(
    JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node,
    '^22.16.0 || >=24.0.0',
  );
});

test('a written square is the pinned SQLite singleton snapshot with no square lock or business sidecar', async (t) => {
  const { dir, squarePath, squareState } = await writeFixture(t, {
    hardCap: null,
    throttlePerMinute: 5,
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'listen', actor: 'Alice', target: 'Bob', at: 2 },
      { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', mentions: ['Bob'] },
      { kind: 'ignore', actor: 'Alice', target: 'Bob', at: 4 },
      { kind: 'hold', actor: 'Host', at: 5, body: 'pause' },
      { kind: 'resume', actor: 'Host', at: 6 },
      { kind: 'done', actor: 'Alice', at: 7, body: 'bye' },
    ],
  });
  squareState.runtime.observations.Alice = { [formatActivityId(6)]: { state: 'seen', at: 8 } };
  squareState.runtime.leases.Alice = { leaseId: 'lease-1', heartbeatAt: 9, expiresAt: 10 };
  await writeSquareFile(squarePath, squareState);

  const snapshot = readSnapshot(squarePath);
  assert.equal(snapshot.identity, APPLICATION_ID);
  assert.equal(snapshot.version, USER_VERSION);
  assert.equal(snapshot.journalMode, 'delete');
  assert.equal(snapshot.row.id, 1);
  assert.equal(snapshot.row.revision, 1);
  assert.equal(snapshot.row.state, JSON.stringify(squareState));
  assert.match(snapshot.table, /id\s+INTEGER\s+PRIMARY KEY\s+CHECK\s*\(\s*id\s*=\s*1\s*\)/i);
  assert.match(snapshot.table, /revision\s+INTEGER\s+NOT NULL\s+CHECK\s*\(\s*revision\s*>=\s*0\s*\)/i);
  assert.match(snapshot.table, /state\s+TEXT\s+NOT NULL/i);
  assert.deepEqual(await loadSquare(squarePath), squareState);
  assert.equal(fs.existsSync(`${squarePath}.lock`), false);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(squarePath)]);
});

test('SQLite artifact access preserves escaped special-character paths', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-special-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const squarePath = path.join(dir, 'square #? [名].square');
  const state = makeState({ preamble: ['escaped path'] });
  await writeSquareFile(squarePath, state);
  assert.deepEqual(await loadSquare(squarePath), state);
  const cell = createFileCell(squarePath);
  t.after(() => cell.close());
  await cell.transact((current) => ({ state: { ...current, preamble: ['still escaped'] }, result: undefined }));
  assert.deepEqual((await loadSquare(squarePath)).preamble, ['still escaped']);
  assert.equal(readSnapshot(squarePath).row.revision, 1);
});

test('SquareState validation retains historical indexes, runtime, lease, and activity-shape invariants', () => {
  const archived = makeState({ acts: [{ kind: 'say', actor: 'Alice', at: 5, body: 'archived @Bob', mentions: ['Bob'] }] });
  archived.acts[0].index = 4;
  archived.runtime.nextActIndex = 5;
  archived.runtime.observations.Bob = { [formatActivityId(1)]: { state: 'seen', at: 2 } };
  assert.equal(validateSquareState(archived), archived);

  const cases = [
    ['future observation', (state) => { state.runtime.observations.Bob = { [formatActivityId(state.runtime.nextActIndex)]: { state: 'seen', at: 3 } }; }, /unassigned activity index/],
    ['reused index', (state) => { state.acts[1].index = 0; }, /schema is malformed/],
    ['out-of-order index', (state) => { state.acts[0].index = 2; state.acts[1].index = 1; }, /schema is malformed/],
    ['extra runtime key', (state) => { state.runtime.version = 1; }, /schema is malformed/],
    ['invalid lease', (state) => { state.runtime.leases.Alice = { leaseId: 'lease', heartbeatAt: 2, expiresAt: 1 }; }, /schema is malformed/],
    ['malformed listen', (state) => { state.acts = [{ kind: 'listen', actor: 'Alice', at: 1, index: 0 }]; state.runtime.nextActIndex = 1; }, /schema is malformed/],
    ['malformed ignore', (state) => { state.acts = [{ kind: 'ignore', actor: 'Alice', target: 'Bob', at: 1, index: 0, route: 'mention' }]; state.runtime.nextActIndex = 1; }, /schema is malformed/],
  ];
  for (const [name, mutate, expected] of cases) {
    const state = makeState({ acts: [{ kind: 'join', actor: 'Alice', at: 1 }, { kind: 'join', actor: 'Bob', at: 2 }] });
    mutate(state);
    assert.throws(() => validateSquareState(state), expected, name);
  }
});

test('bell and reply metadata persist as validated SquareState', async (t) => {
  const state = makeState({
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'Bob', at: 2 },
      { kind: 'say', actor: 'Alice', at: 3, body: 'center @Bob', mentions: ['Bob'] },
      { kind: 'say', actor: 'Alice', at: 4, body: 'bell', reach: 'bell', reply: 2 },
    ],
  });
  const { squarePath } = await writeFixture(t, state);
  const persisted = await loadSquare(squarePath);
  assert.equal(persisted.acts[2].reach, undefined);
  assert.equal(persisted.acts[3].reach, 'bell');
  assert.equal(persisted.acts[3].reply, 2);
});

test('a rejected future observation cannot suppress the next real directed activity', async (t) => {
  const { squarePath } = await writeFixture(t, {
    acts: [
      { kind: 'join', actor: 'Alice', at: 1 },
      { kind: 'join', actor: 'Bob', at: 2 },
    ],
  });
  const poisoned = await loadSquare(squarePath);
  poisoned.runtime.observations.Bob = {
    [formatActivityId(poisoned.runtime.nextActIndex)]: { state: 'seen', at: 3 },
  };
  await assert.rejects(() => writeSquareFile(squarePath, poisoned), /unassigned activity index/);

  const cell = createFileCell(squarePath);
  t.after(() => cell.close());
  await express({ cell, clock: () => 3, location: squarePath }, 'Alice', 'hey @Bob', { force: true, mentions: ['Bob'] });
  const persisted = await loadSquare(squarePath);
  assert.equal(persisted.acts.at(-1)?.index, 2);
  assert.deepEqual(deriveDeliveryModel(persisted).pendingFor('Bob').map((item) => item.item.index), [2]);
});

test('file cells preserve model validation, rollback, no-op revisions, and synchronous callbacks', async (t) => {
  const { squarePath, squareState } = await writeFixture(t);
  const cell = createFileCell(squarePath);
  t.after(async () => cell.close());

  assert.equal((await cell.read()).version, 0);
  await cell.transact((state) => ({ result: state.preamble[0] }));
  assert.equal((await cell.read()).version, 0);

  await assert.rejects(() => cell.transact(() => { throw new Error('abort this transition'); }), /abort this transition/);
  assert.equal((await cell.read()).version, 0);
  assert.deepEqual(await loadSquare(squarePath), squareState);

  await assert.rejects(
    () => cell.transact(async (state) => ({ state: { ...state, preamble: ['must not commit'] }, result: undefined })),
    /synchronous|thenable|Promise/i,
  );
  assert.equal((await cell.read()).version, 0);
  assert.deepEqual(await loadSquare(squarePath), squareState);

  const malformed = structuredClone(squareState);
  malformed.runtime.nextActIndex = -1;
  await assert.rejects(
    () => cell.transact(() => ({ state: malformed, result: undefined })),
    /nextActIndex is behind|Invalid square artifact|malformed/i,
  );
  assert.equal((await cell.read()).version, 0);
  assert.deepEqual(await loadSquare(squarePath), squareState);

  await cell.transact((state) => ({ state: { ...state, preamble: ['committed'] }, result: undefined }));
  assert.equal((await cell.read()).version, 1);
  assert.deepEqual((await loadSquare(squarePath)).preamble, ['committed']);
});

test('memory cells reject asynchronous transitions and retain file-cell no-op and rollback semantics', async () => {
  const initial = makeState();
  const cell = createMemoryCell(initial);
  assert.equal((await cell.read()).version, 0);
  await cell.transact((state) => ({ result: state.preamble[0] }));
  assert.equal((await cell.read()).version, 0);
  await assert.rejects(
    () => cell.transact(async (state) => ({ state: { ...state, preamble: ['must not commit'] }, result: undefined })),
    /synchronous|thenable|Promise/i,
  );
  await assert.rejects(() => cell.transact(() => { throw new Error('memory rollback'); }), /memory rollback/);
  assert.equal((await cell.read()).version, 0);
  assert.deepEqual((await cell.read()).state, initial);
  await cell.close();
});

test('memory and file cells keep same-state returns as no-ops and isolate caller mutations', async (t) => {
  const initial = makeState({ preamble: ['isolated'] });
  const { squarePath } = await writeFixture(t, initial);
  const file = createFileCell(squarePath);
  const memory = createMemoryCell(initial);
  t.after(async () => Promise.all([file.close(), memory.close()]));

  for (const cell of [file, memory]) {
    const first = await cell.read();
    first.state.preamble[0] = 'caller changed only its copy';
    const second = await cell.read();
    assert.equal(second.version, 0);
    assert.deepEqual(second.state.preamble, ['isolated']);

    await cell.transact((state) => ({ state: structuredClone(state), result: undefined }));
    assert.equal((await cell.read()).version, 0);
    assert.deepEqual((await cell.read()).state.preamble, ['isolated']);
  }
});

test('missing probes do not create a database and malformed or unsupported candidates are never overwritten', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-invalid-sqlite-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missing = path.join(dir, 'missing.square');
  assert.equal(await probeSquare(missing), undefined);
  assert.equal(fs.existsSync(missing), false);
  const invalidInitial = path.join(dir, 'invalid-initial.square');
  const invalidState = makeState();
  invalidState.runtime.nextActIndex = -1;
  await assert.rejects(() => writeSquareFile(invalidInitial, invalidState), /schema is malformed/);
  assert.equal(fs.existsSync(invalidInitial), false, 'invalid initial state left a placeholder artifact');
  const vanished = path.join(dir, 'vanished #? [名].square');
  await writeSquareFile(vanished, makeState());
  fs.unlinkSync(vanished);
  await assert.rejects(() => loadSquare(vanished), /not found|Invalid square artifact|unable to open/i);
  assert.equal(fs.existsSync(vanished), false, 'a missing artifact was recreated after disappearing before open');

  const candidates = [
    { name: 'old binary artifact', prepare(file) { fs.writeFileSync(file, Buffer.from('SQUARE01 obsolete')); } },
    { name: 'unrelated database', prepare(file) { createRawDatabase(file, { applicationId: 0x12345678 }); } },
    { name: 'unsupported version', prepare(file) { createRawDatabase(file, { userVersion: 2 }); } },
    { name: 'missing singleton row', prepare(file) { createRawDatabase(file, { row: false }); } },
    { name: 'malformed state JSON', prepare(file) { createRawDatabase(file, { state: '{not valid JSON' }); } },
    { name: 'invalid state model', prepare(file) { createRawDatabase(file, { state: JSON.stringify({ ...makeState(), runtime: { nextActIndex: -1, observations: {}, leases: {} } }) }); } },
  ];

  for (const candidate of candidates) {
    const squarePath = path.join(dir, `${candidate.name.replaceAll(' ', '-')}.square`);
    candidate.prepare(squarePath);
    const before = databaseBytes(squarePath);
    assert.equal(await probeSquare(squarePath), undefined, candidate.name);
    await assert.rejects(() => loadSquare(squarePath), /Invalid square artifact|unsupported|not a SQLite|malformed/i, candidate.name);
    await assert.rejects(() => writeSquareFile(squarePath, makeState({ preamble: ['must not replace'] })), /Invalid square artifact|unsupported|not a SQLite|malformed/i, candidate.name);
    assert.deepEqual(databaseBytes(squarePath), before, `${candidate.name} was mutated`);
  }
});

test('only the pinned singleton schema is accepted and unsupported shapes are never rewritten', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-schema-shape-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const expected = makeState({ preamble: ['raw pinned schema'] });
  const pinnedFixture = path.join(dir, 'pinned-fixture.square');
  createRawDatabase(pinnedFixture, { state: JSON.stringify(expected) });
  assert.deepEqual(await loadSquare(pinnedFixture), expected);
  assert.deepEqual(await probeSquare(pinnedFixture), expected);

  const productionOutput = path.join(dir, 'production-output.square');
  await writeSquareFile(productionOutput, expected);
  assert.deepEqual(await loadSquare(productionOutput), expected);
  assert.deepEqual(await probeSquare(productionOutput), expected);

  const unsupported = [
    {
      name: 'extra ordinary column',
      schema: 'CREATE TABLE square_snapshot (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision >= 0), state TEXT NOT NULL, note TEXT)',
    },
    {
      name: 'extra generated column',
      schema: 'CREATE TABLE square_snapshot (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision >= 0), state TEXT NOT NULL, state_length INTEGER GENERATED ALWAYS AS (length(state)) VIRTUAL)',
    },
    {
      name: 'missing singleton check',
      schema: 'CREATE TABLE square_snapshot (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision >= 0), state TEXT NOT NULL)',
    },
    {
      name: 'without-rowid table shape',
      schema: 'CREATE TABLE square_snapshot (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision >= 0), state TEXT NOT NULL) WITHOUT ROWID',
    },
    {
      name: 'additional application table',
      schema: 'CREATE TABLE square_snapshot (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision >= 0), state TEXT NOT NULL); CREATE TABLE square_audit (entry TEXT NOT NULL)',
    },
    {
      name: 'application table resembling an internal prefix',
      schema: 'CREATE TABLE square_snapshot (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision >= 0), state TEXT NOT NULL); CREATE TABLE sqlitex_audit (entry TEXT NOT NULL)',
    },
  ];

  for (const candidate of unsupported) {
    const squarePath = path.join(dir, `${candidate.name.replaceAll(' ', '-')}.square`);
    createRawDatabase(squarePath, { schema: candidate.schema, state: JSON.stringify(expected) });
    const before = databaseBytes(squarePath);
    assert.equal(await probeSquare(squarePath), undefined, candidate.name);
    await assert.rejects(() => loadSquare(squarePath), (error) => error?.code === 'invalid_args', candidate.name);
    await assert.rejects(
      () => writeSquareFile(squarePath, makeState({ preamble: ['must not force-replace unsupported schema'] })),
      (error) => error?.code === 'invalid_args',
      candidate.name,
    );
    assert.deepEqual(databaseBytes(squarePath), before, `${candidate.name} was mutated by force replacement`);
  }
});

test('a missing file cell transaction reports typed not_found without creating an artifact', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-missing-cell-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const squarePath = path.join(dir, 'missing.square');
  const cell = createFileCell(squarePath);
  t.after(() => cell.close());
  let called = false;

  await assert.rejects(
    () => cell.transact((state) => {
      called = true;
      return { state, result: undefined };
    }),
    (error) => error?.code === 'not_found',
  );
  assert.equal(called, false);
  assert.equal(fs.existsSync(squarePath), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('extension rejection and doctor corruption reporting preserve the unreadable artifact', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-extension-doctor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const markdown = path.join(dir, 'square.md');
  fs.writeFileSync(markdown, 'not a square');
  await assert.rejects(() => loadSquare(markdown), /must use the \.square extension/);
  assert.equal(await probeSquare(markdown), undefined);

  const squarePath = path.join(dir, 'SQUARE.square');
  await writeSquareFile(squarePath, makeState());
  fs.writeFileSync(squarePath, 'not a SQLite snapshot');
  const diagnosis = await diagnoseSquareFile(squarePath);
  assert.match(diagnosis.unfixable, /Invalid square artifact/);
  assert.equal(diagnosis.state, undefined);
  assert.equal(fs.readFileSync(squarePath, 'utf8'), 'not a SQLite snapshot');
});

test('symlink aliases share one SQLite authority without a square lock', async (t) => {
  const { dir, squarePath } = await writeFixture(t, { preamble: ['initial'] });
  const aliasPath = path.join(dir, 'alias.square');
  fs.symlinkSync(squarePath, aliasPath);
  const real = createFileCell(squarePath);
  const alias = createFileCell(aliasPath);
  t.after(async () => Promise.all([real.close(), alias.close()]));

  await Promise.all([
    real.transact((state) => ({ state: { ...state, preamble: [...state.preamble, 'real'] }, result: undefined })),
    alias.transact((state) => ({ state: { ...state, preamble: [...state.preamble, 'alias'] }, result: undefined })),
  ]);
  assert.deepEqual((await loadSquare(squarePath)).preamble.sort(), ['alias', 'initial', 'real']);
  assert.equal(fs.lstatSync(aliasPath).isSymbolicLink(), true);
  assert.equal(fs.existsSync(`${squarePath}.lock`), false);
  assert.equal(fs.existsSync(`${aliasPath}.lock`), false);
});

test('createSquareState still creates a model without persistence framing', async () => {
  const squareState = await createSquareState({ force: true, hardCap: null, throttlePerMinute: 4 }, '## Topic\n\nHost context');
  assert.equal(squareState.hardCap, null);
  assert.equal(squareState.throttlePerMinute, 4);
  assert.deepEqual(squareState.preamble, ['## Topic', '', 'Host context']);
  assert.ok(squareState.warmup.some((line) => line.includes('stepped into the square')));
  assert.deepEqual(squareState.acts, []);
  assert.deepEqual(squareState.runtime, emptyRuntimeState());
});
