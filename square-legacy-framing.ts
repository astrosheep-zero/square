import type { DatabaseSync } from 'node:sqlite';

export const FORMAT4_ADDED_OBJECTS: ReadonlySet<string> = new Set([
  'seats', 'seat_body', 'delivery_evidence', 'delivery_claim_token', 'delivery_activity', 'delivery_cancellations',
]);
export const FORMAT4_REPLACED_OBJECTS: ReadonlySet<string> = new Set(['routes', 'route_participant', 'route_session']);
const LEGACY_ROUTES_SQL = `CREATE TABLE routes (
  position INTEGER PRIMARY KEY CHECK (position >= 0),
  participant_key_json TEXT COLLATE BINARY NOT NULL,
  session_json TEXT COLLATE BINARY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('opencode-server','codex-queue','claude-native','paseo')),
  updated_at REAL NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
);
CREATE INDEX route_participant ON routes(participant_key_json, position);
CREATE INDEX route_session ON routes(session_json, position);`;

function normalizedSql(sql: string): string {
  return sql.trim().replace(/;$/, '').replace(/\s+/g, ' ').replace(/\s*([(),=])\s*/g, '$1');
}

function legacyRowSchema(currentSchemaSql: string, version: 2 | 3): string[] {
  const statements = currentSchemaSql.split(';').map((statement) => statement.trim()).filter(Boolean)
    .filter((statement) => {
      const match = /^(?:CREATE (?:UNIQUE )?TABLE|CREATE (?:UNIQUE )?INDEX)\s+([a-z_]+)/i.exec(statement);
      return match === null || !FORMAT4_ADDED_OBJECTS.has(match[1]) && !FORMAT4_REPLACED_OBJECTS.has(match[1]);
    });
  const legacyStatements = statements.join(';\n')
    .replace('  delivery_revision INTEGER NOT NULL CHECK (delivery_revision BETWEEN 0 AND 9007199254740991),\n', '')
    .replace('  generation_json TEXT NOT NULL DEFAULT \'""\',\n', '');
  const allStatements = [...legacyStatements.split(';').map((statement) => statement.trim()).filter(Boolean),
    ...LEGACY_ROUTES_SQL.split(';').map((statement) => statement.trim()).filter(Boolean)];
  let schema = allStatements.join(';\n');
  if (version === 2) {
    schema = schema.replace("kind IN ('join','done','say','hold','resume','read','listen','ignore','unlisten')", "kind IN ('join','done','say','hold','resume','read','listen','ignore')");
  }
  return schema.split(';').map((statement) => normalizedSql(statement)).filter(Boolean).sort();
}

/**
 * Read-only recognition of the exact row framing accepted by explicit migration.
 * It inspects identity, owned schema and journal mode only; it never reads row
 * contents (including legacy routes), changes pragmas, or performs DDL.
 */
export function legacyRowFramingIssue(
  database: DatabaseSync,
  applicationId: number,
  version: 2 | 3,
  location: string,
  currentSchemaSql: string,
): string | undefined {
  const identity = database.prepare('SELECT application_id, user_version FROM pragma_application_id, pragma_user_version').get() as { application_id?: unknown; user_version?: unknown };
  if (identity.application_id !== applicationId) return 'unrelated SQLite database.';
  if (identity.user_version !== version) return 'unsupported SQLite format version.';

  const actual = (database.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND sql IS NOT NULL").all() as { sql?: unknown }[])
    .map((row) => typeof row.sql === 'string' ? normalizedSql(row.sql) : '')
    .sort();
  const expected = legacyRowSchema(currentSchemaSql, version);
  if (actual.length !== expected.length || actual.some((sql, index) => sql !== expected[index])) return 'unsupported row schema.';

  const journalMode = (database.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown }).journal_mode;
  if (journalMode !== (location === ':memory:' ? 'memory' : 'delete')) return 'unsupported journal mode.';
  return undefined;
}
