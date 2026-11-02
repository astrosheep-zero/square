import type { DatabaseSync } from 'node:sqlite';
import { type Row, integer, requireFact, string } from './sqlite-values.js';

/** The only schema owned by the shared physical store. */
export const STORAGE_META_SQL = `CREATE TABLE storage_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  delivery_revision INTEGER NOT NULL CHECK (delivery_revision BETWEEN 0 AND 9007199254740991)
);`;

export function initializeStorageMeta(db: DatabaseSync, revision = 0): void {
  integer(revision);
  db.exec(STORAGE_META_SQL);
  db.prepare('INSERT INTO storage_meta(id,revision,delivery_revision) VALUES(1,?,0)').run(revision);
}

export function resetStorageMeta(db: DatabaseSync): void {
  db.exec('DROP TABLE storage_meta');
}

export function readStorageRevision(db: DatabaseSync, delivery = false): number {
  const rows = db.prepare(`SELECT id, ${delivery ? 'delivery_revision' : 'revision'} AS revision FROM storage_meta`).all() as Row[];
  requireFact(rows.length === 1 && rows[0].id === 1, 'revision header is malformed.');
  return integer(rows[0].revision);
}

function normalizedSql(sql: string): string {
  return sql.trim().replace(/;$/, '').replace(/\s+/g, ' ').replace(/\s*([(),=])\s*/g, '$1');
}

/** Compare an owner's complete current schema and journal mode without modifying the database. */
export function validateSchema(db: DatabaseSync, expectedSql: string, location = ''): void {
  const expected = expectedSql.split(';').map(s => s.trim()).filter(Boolean).map(normalizedSql).sort();
  const actual = (db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND sql IS NOT NULL").all() as Row[])
    .map(row => normalizedSql(string(row.sql))).sort();
  requireFact(actual.length === expected.length && actual.every((sql, index) => sql === expected[index]), 'unsupported row schema.');
  requireFact((db.prepare('PRAGMA journal_mode').get() as Row).journal_mode === (location === ':memory:' ? 'memory' : 'delete'), 'unsupported journal mode.');
}
