import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  LEDGER_APPLICATION_ID, LEDGER_FILENAME, initializeLedger, insertLedgerRecord, ledgerRecordColumns, ledgerRevisions, setLedgerRevisions,
} from '../dist/host-ledger-sqlite.js';

export { LEDGER_FILENAME, readLedgerRevisions } from '../dist/host-ledger-sqlite.js';

/** Absolute path of the one host-ledger database under a resolved ledger root. */
export function ledgerDatabasePath(root) {
  return path.join(root, LEDGER_FILENAME);
}

/** Open (creating and initializing if needed) the ledger database for write. */
export function openLedgerDatabase(root) {
  fs.mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(ledgerDatabasePath(root));
  if (db.prepare('PRAGMA application_id').get()?.application_id !== LEDGER_APPLICATION_ID) initializeLedger(db);
  return db;
}

/**
 * Seed records the public ledger API cannot produce: expired or future rows,
 * foreign-location rows, malformed-field rows. Rows go through the storage
 * codec and the category revision moves, so seeded state looks like a real write.
 */
export function seedLedger(root, { presence = [], evidence = [] } = {}) {
  const db = openLedgerDatabase(root);
  try {
    const before = ledgerRevisions(db);
    for (const row of presence) insertLedgerRecord(db, 'presence', row);
    for (const row of evidence) insertLedgerRecord(db, 'evidence', row);
    setLedgerRevisions(db, {
      presence: before.presence + (presence.length ? 1 : 0),
      evidence: before.evidence + (evidence.length ? 1 : 0),
    });
  } finally {
    db.close();
  }
}

/** Raw stored records in sequence order; [] when the ledger was never written. */
export function readLedgerRecords(root, kind) {
  const file = ledgerDatabasePath(root);
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const table = kind === 'presence' ? 'host_presence' : 'host_evidence';
    return db.prepare(`SELECT row_json FROM ${table} ORDER BY seq ASC`).all()
      .map((row) => JSON.parse(row.row_json));
  } finally {
    db.close();
  }
}

/**
 * Rewrite one stored record in place, the way a diagnostic-only edit lands:
 * row_json stays authority, the derived columns are re-derived, the revision moves.
 */
export function rewriteLedgerRecord(root, kind, seq, update) {
  const db = new DatabaseSync(ledgerDatabasePath(root));
  try {
    const table = kind === 'presence' ? 'host_presence' : 'host_evidence';
    const stored = db.prepare(`SELECT row_json FROM ${table} WHERE seq=?`).get(seq);
    if (stored === undefined) throw new Error(`No ${kind} record at seq ${seq}`);
    const next = { ...JSON.parse(stored.row_json), ...update };
    const derived = ledgerRecordColumns(kind, next);
    const fields = Object.keys(derived);
    db.prepare(`UPDATE ${table} SET ${fields.map((field) => `${field}=?`).join(',')},row_json=? WHERE seq=?`)
      .run(...fields.map((field) => derived[field]), JSON.stringify(next), seq);
    db.exec(`UPDATE host_meta SET ${kind}_revision=${kind}_revision+1 WHERE id=1`);
  } finally {
    db.close();
  }
}

/** SQLite resolves symlinks, and the adapter opens with the resolved root. */
export function isLedgerDatabasePath(location, root) {
  if (typeof location !== 'string' || path.basename(location) !== LEDGER_FILENAME) return false;
  const resolved = (value) => {
    try { return fs.realpathSync.native(value); }
    catch { return path.resolve(value); }
  };
  return path.dirname(resolved(location)) === resolved(root);
}

/**
 * Intercept statement work on one ledger database. `hook(method, sql, db)` runs
 * synchronously before the real call and may throw; every other database is
 * untouched. DatabaseSync methods are synchronous, so a hook never returns a
 * promise: blocking a real transaction belongs to real SQLite locks instead.
 */
export function interceptLedgerSql(t, root, hook) {
  for (const method of ['prepare', 'exec']) {
    const original = DatabaseSync.prototype[method];
    t.mock.method(DatabaseSync.prototype, method, function (...args) {
      if (isLedgerDatabasePath(this.location(), root)) hook(method, typeof args[0] === 'string' ? args[0] : undefined, this);
      return original.apply(this, args);
    });
  }
}

/** Fail the first `times` statements on one ledger database. */
export function failLedgerSql(t, root, { times = 1, message = 'injected ledger failure', code = 'EIO' } = {}) {
  let remaining = times;
  interceptLedgerSql(t, root, () => {
    if (remaining <= 0) return undefined;
    remaining -= 1;
    throw Object.assign(new Error(message), { code });
  });
  return () => remaining;
}
