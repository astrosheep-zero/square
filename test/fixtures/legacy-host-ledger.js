import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const legacyEvidenceIndexes = {
  host_presence_identity: ['host_presence', 'location_key', 'participant_key', 'seq'],
  host_presence_session: ['host_presence', 'session_key', 'seq'],
  host_presence_time: ['host_presence', 'effective_at'],
  host_evidence_attention: ['host_evidence', 'location_key', 'participant_key', 'activity_key', 'kind', 'session_key', 'seq'],
  host_evidence_kind_session: ['host_evidence', 'kind', 'session_key', 'seq'],
  host_evidence_session: ['host_evidence', 'session_key', 'seq'],
  host_evidence_token: ['host_evidence', 'location_key', 'participant_key', 'activity_key', 'session_key', 'claim_token_key', 'seq'],
  host_evidence_outcome_time: ['host_evidence', 'outcome', 'effective_at'],
  host_evidence_time: ['host_evidence', 'effective_at'],
  host_evidence_native_token: ['host_evidence', 'session_key', 'claim_token_key', 'seq'],
};

/**
 * Write one frozen format-2 host ledger for migration tests.
 * Evidence rows and presence rows are stored in the given order; presence seq is insertion order.
 */
export function writeLegacyLedger(root, evidenceRows = [], presenceRows = []) {
  fs.mkdirSync(root, { recursive: true });
  const database = new DatabaseSync(path.join(root, 'host-ledger.sqlite'));
  try {
    database.exec('PRAGMA journal_mode=DELETE; PRAGMA application_id=1397835852; PRAGMA user_version=2;');
    database.exec(`
      CREATE TABLE host_meta (id INTEGER PRIMARY KEY CHECK(id=1), presence_revision INTEGER NOT NULL, evidence_revision INTEGER NOT NULL);
      CREATE TABLE host_presence (seq INTEGER PRIMARY KEY AUTOINCREMENT, location_key TEXT NOT NULL, participant_key TEXT NOT NULL, session_key TEXT NOT NULL, channel_key TEXT NOT NULL, effective_at REAL NOT NULL, row_json TEXT NOT NULL);
      CREATE TABLE host_evidence (seq INTEGER PRIMARY KEY AUTOINCREMENT, location_key TEXT NOT NULL, participant_key TEXT NOT NULL, session_key TEXT NOT NULL, activity_key TEXT NOT NULL, kind TEXT NOT NULL, outcome TEXT NOT NULL, claim_token_key TEXT, effective_at REAL NOT NULL, row_json TEXT NOT NULL);
      CREATE TABLE host_native_tokens (harness TEXT NOT NULL CHECK(harness='claude'), session_key TEXT NOT NULL, token_key TEXT NOT NULL, PRIMARY KEY(harness,session_key,token_key)) WITHOUT ROWID;
      INSERT INTO host_meta(id,presence_revision,evidence_revision) VALUES(1,${presenceRows.length ? 1 : 0},${evidenceRows.length ? 1 : 0});
    `);
    for (const [name, fields] of Object.entries(legacyEvidenceIndexes)) {
      database.exec(`CREATE INDEX ${name} ON ${fields[0]} (${fields.slice(1).join(',')});`);
    }
    const insertPresence = database.prepare('INSERT INTO host_presence(location_key,participant_key,session_key,channel_key,effective_at,row_json) VALUES(?,?,?,?,?,?)');
    for (const row of presenceRows) {
      const stored = { ...row, location: fs.realpathSync.native(row.location) };
      const effectiveAt = stored.at ?? stored.updatedAt;
      insertPresence.run(JSON.stringify(stored.location), JSON.stringify(stored.participant.toLocaleLowerCase()),
        JSON.stringify(stored.session), JSON.stringify(stored.channel), effectiveAt, JSON.stringify(stored));
    }
    const insertEvidence = database.prepare('INSERT INTO host_evidence(location_key,participant_key,session_key,activity_key,kind,outcome,claim_token_key,effective_at,row_json) VALUES(?,?,?,?,?,?,?,?,?)');
    for (const row of evidenceRows) {
      const stored = { ...row, location: fs.realpathSync.native(row.location) };
      insertEvidence.run(JSON.stringify(stored.location), JSON.stringify(stored.participant.toLocaleLowerCase()),
        JSON.stringify(stored.session), JSON.stringify(stored.activity), stored.kind, stored.outcome,
        stored.claimToken === undefined ? null : JSON.stringify(stored.claimToken), stored.at, JSON.stringify(stored));
    }
  } finally { database.close(); }
}
