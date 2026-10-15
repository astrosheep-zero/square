import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { createArtifactPort, createSquareFile } from '../dist/artifact.js';
import { canonicalPath } from '../dist/canonical-path.js';
import { emptyRuntimeState } from '../dist/square-sqlite.js';
import { maintainHostLedger } from '../dist/ledger-maintenance.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const OLD = NOW - 8 * DAY;

/** Typed ledger stand-in: rows live in memory, retirement is the same full-record compare-and-swap. */
class Ledger {
  constructor(records, { refuseRetirement = false } = {}) {
    this.rows = records.map((record) => ({ ...record }));
    this.refuseRetirement = refuseRetirement;
    this.retireCalls = [];
  }
  async listEvidence() {
    return this.rows.map((record) => ({ ...record }));
  }
  async retireEvidenceIfUnchanged(expected) {
    this.retireCalls.push({ ...expected });
    if (this.refuseRetirement) return false;
    const at = this.rows.findIndex((record) => isDeepStrictEqual(record, expected));
    if (at === -1) return false;
    this.rows.splice(at, 1);
    return true;
  }
}

function row(location, overrides = {}) {
  return {
    location,
    participant: 'Alice',
    session: 'session-1',
    activity: 'act/2',
    kind: 'wake',
    outcome: 'accepted',
    at: OLD,
    claimToken: 'claim-1',
    ...overrides,
  };
}

const EMPTY = () => ({ hardCap: null, preamble: [], warmup: [], acts: [], routes: [], runtime: emptyRuntimeState(0) });

async function edit(file, change) {
  const port = createArtifactPort(file);
  try {
    return (await port.transact(change)).value;
  } finally {
    await port.close();
  }
}

/** Two standing participants; Bob addresses Alice at act/2. */
const ADDRESSED = [
  { kind: 'join', actor: 'Alice', at: 1 },
  { kind: 'join', actor: 'Bob', at: 2 },
  { kind: 'say', actor: 'Bob', at: 3, body: 'hello @Alice', mentions: ['Alice'] },
];

async function artifact(t, acts = ADDRESSED) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'square-ledger-maintenance-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'square.square');
  await createSquareFile(file, EMPTY());
  await edit(file, (facts) => {
    for (const act of acts) facts.land(act);
  });
  return { root, file };
}

test('an exact receipt closes an old wake or presentation row', async (t) => {
  const { file } = await artifact(t);
  await edit(file, (facts) => facts.markSeen('Alice', [2], 10));
  const ledger = new Ledger([row(file), row(file, { kind: 'presentation', participant: 'ALICE', session: 'session-2', outcome: 'presented' })]);

  const report = await maintainHostLedger(ledger, { now: NOW });

  assert.deepEqual(report, { dryRun: false, eligible: 2, retired: 2, casMisses: 0, unavailableArtifacts: [] });
  assert.equal(ledger.rows.length, 0);
});

test('a later rejoin closes what no receipt covers', async (t) => {
  const { file } = await artifact(t, [
    ...ADDRESSED,
    { kind: 'done', actor: 'Alice', at: 4 },
    { kind: 'join', actor: 'Alice', at: 5 },
  ]);

  const report = await maintainHostLedger(new Ledger([row(file)]), { now: NOW });

  assert.equal(report.eligible, 1);
  assert.equal(report.retired, 1);
});

test('attention that never landed is retained, whatever else points at it', async (t) => {
  const { file } = await artifact(t, [
    ...ADDRESSED,
    { kind: 'say', actor: 'Bob', at: 4, body: 'second @Alice', mentions: ['Alice'] },
    { kind: 'join', actor: 'Cara', at: 5 },
  ]);
  // Receipts are exact and may name any index: act/3's receipt cannot close act/2, and a receipt may
  // name an activity no audience ever reached. A clipped preview stays pending, not closed.
  await edit(file, (facts) => {
    facts.markSeen('Alice', [3], 10);
    facts.markSeen('Cara', [2], 11);
  });
  const ledger = new Ledger([
    row(file),
    row(file, { participant: 'Cara' }),
    row(file, { participant: 'Bob', session: 'session-3' }),
    row(file, { kind: 'presentation', session: 'session-4', outcome: 'clipped' }),
  ]);

  const report = await maintainHostLedger(ledger, { now: NOW });

  assert.deepEqual(report, { dryRun: false, eligible: 0, retired: 0, casMisses: 0, unavailableArtifacts: [] });
  assert.equal(ledger.rows.length, 4);
});

test('dispatching, lifecycle, young, and malformed rows are skipped even when closure is provable', async (t) => {
  const { file } = await artifact(t);
  await edit(file, (facts) => facts.markSeen('Alice', [2], 10));
  const ledger = new Ledger([
    row(file),
    row(file, { outcome: 'dispatching' }),
    row(file, { kind: 'lifecycle' }),
    row(file, { at: NOW - DAY }),
    row(file, { activity: 'act/02' }),
    row(file, { participant: 'bad name' }),
    row(file, { location: '' }),
  ]);

  const report = await maintainHostLedger(ledger, { now: NOW });

  assert.deepEqual(report, { dryRun: false, eligible: 1, retired: 1, casMisses: 0, unavailableArtifacts: [] });
  assert.equal(ledger.rows.length, 6);
});

test('a dry run proves closure without touching the ledger or the artifact', async (t) => {
  const { file } = await artifact(t);
  await edit(file, (facts) => facts.markSeen('Alice', [2], 10));
  const before = await fs.readFile(file);
  const ledger = new Ledger([row(file)]);

  const report = await maintainHostLedger(ledger, { dryRun: true, now: NOW });

  assert.deepEqual(report, { dryRun: true, eligible: 1, retired: 0, casMisses: 0, unavailableArtifacts: [] });
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(ledger.retireCalls, []);
  assert.equal(ledger.rows.length, 1);
});

test('unavailable artifacts and refused swaps are reported without retiring', async (t) => {
  const { root, file } = await artifact(t);
  await edit(file, (facts) => facts.markSeen('Alice', [2], 10));
  const missing = path.join(root, 'missing.square');
  const broken = path.join(root, 'broken.square');
  await fs.writeFile(broken, 'not a square artifact');

  const unavailable = new Ledger([row(file), row(missing), row(broken)]);
  const unavailableReport = await maintainHostLedger(unavailable, { now: NOW });
  assert.equal(unavailableReport.eligible, 1);
  assert.equal(unavailableReport.retired, 1);
  assert.deepEqual(unavailableReport.unavailableArtifacts, [await canonicalPath(broken), await canonicalPath(missing)].sort());
  assert.equal(unavailable.rows.length, 2);

  const refused = new Ledger([row(file)], { refuseRetirement: true });
  const refusedReport = await maintainHostLedger(refused, { now: NOW });
  assert.deepEqual(refusedReport, { dryRun: false, eligible: 1, retired: 0, casMisses: 1, unavailableArtifacts: [] });
  assert.equal(refused.rows.length, 1);
});
