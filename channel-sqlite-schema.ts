import type { DatabaseSync } from 'node:sqlite';
import type { StoreFormat } from './artifact-store.js';
import { initializeStorageMeta, resetStorageMeta, STORAGE_META_SQL, validateSchema } from './sqlite-framing.js';
import { requireFact, type Row } from './sqlite-values.js';

/** Channel owns this schema in both standalone and composed artifacts. */
export const CHANNEL_SCHEMA_SQL = `CREATE TABLE channel_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_msg_index INTEGER NOT NULL CHECK (next_msg_index BETWEEN 0 AND 9007199254740991),
  description TEXT NOT NULL
);
CREATE TABLE messages (
  msg_index INTEGER PRIMARY KEY CHECK (msg_index BETWEEN 0 AND 9007199254740991),
  at REAL NOT NULL, from_json TEXT NOT NULL, from_key_json TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)), preview TEXT
);
CREATE INDEX message_sender ON messages(from_key_json,msg_index);
CREATE TABLE message_addresses (
  msg_index INTEGER NOT NULL, recipient_key_json TEXT NOT NULL, recipient_json TEXT NOT NULL,
  recipient_order INTEGER NOT NULL CHECK (recipient_order >= 0), generation_json TEXT,
  PRIMARY KEY (msg_index,recipient_key_json), UNIQUE(msg_index,recipient_order)
) WITHOUT ROWID;
CREATE INDEX message_recipient ON message_addresses(recipient_key_json,msg_index);
CREATE TABLE receipts (
  owner_key_json TEXT NOT NULL, msg_index INTEGER NOT NULL, at REAL NOT NULL,
  PRIMARY KEY (owner_key_json,msg_index)
) WITHOUT ROWID;
CREATE INDEX receipt_owner_time ON receipts(owner_key_json,at);
CREATE TABLE endpoints (
  participant_key_json TEXT PRIMARY KEY NOT NULL, participant_json TEXT NOT NULL,
  owner_json TEXT NOT NULL, generation_json TEXT NOT NULL,
  wake_address_json TEXT CHECK (wake_address_json IS NULL OR json_valid(wake_address_json)),
  attachment TEXT NOT NULL CHECK (attachment IN ('attached','detached'))
) WITHOUT ROWID;
CREATE INDEX endpoint_owner ON endpoints(owner_json);
CREATE TABLE delivery_evidence (
  participant_key_json TEXT NOT NULL, participant_json TEXT NOT NULL, generation_json TEXT NOT NULL,
  msg_index INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('wake','presentation')),
  attempt_n INTEGER NOT NULL CHECK (attempt_n >= 0), outcome TEXT NOT NULL,
  at REAL NOT NULL, expires_at REAL, claim_token_json TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (participant_key_json,generation_json,msg_index,kind,attempt_n)
) WITHOUT ROWID;
CREATE UNIQUE INDEX delivery_claim_token ON delivery_evidence(claim_token_json) WHERE claim_token_json IS NOT NULL;
CREATE TABLE delivery_cancellations (
  participant_key_json TEXT NOT NULL, generation_json TEXT NOT NULL, through_index INTEGER NOT NULL,
  PRIMARY KEY (participant_key_json,generation_json)
) WITHOUT ROWID;
CREATE TABLE delivery_deferrals (
  participant_key_json TEXT NOT NULL, participant_json TEXT NOT NULL, generation_json TEXT NOT NULL,
  deferral_id_json TEXT NOT NULL, match_json TEXT NOT NULL CHECK (json_valid(match_json)), expires_at REAL NOT NULL,
  PRIMARY KEY (participant_key_json,generation_json,deferral_id_json)
) WITHOUT ROWID;
CREATE INDEX delivery_deferral_expiry ON delivery_deferrals(participant_key_json,generation_json,expires_at);
CREATE TABLE receive_claims (
  namespace_key_json TEXT NOT NULL, owner_key_json TEXT NOT NULL, generation_json TEXT NOT NULL,
  claim_id_json TEXT NOT NULL, heartbeat_at REAL NOT NULL, expires_at REAL NOT NULL CHECK (expires_at >= heartbeat_at),
  selector_json TEXT NOT NULL CHECK (json_valid(selector_json)), suppressed_json TEXT NOT NULL CHECK (json_valid(suppressed_json)),
  PRIMARY KEY (namespace_key_json,owner_key_json)
) WITHOUT ROWID;`;
export function initializeChannelSqlite(db: DatabaseSync, description = '# Channel\n'): void {
  db.exec(CHANNEL_SCHEMA_SQL);
  db.prepare('INSERT INTO channel_meta(id,next_msg_index,description) VALUES(1,0,?)').run(description);
}
export function resetChannelSqlite(db: DatabaseSync): void {
  for (const table of ['receive_claims', 'delivery_deferrals', 'delivery_cancellations', 'delivery_evidence', 'endpoints', 'receipts', 'message_addresses', 'messages', 'channel_meta']) db.exec(`DROP TABLE ${table}`);
}
export const channelLowerSchema = { schemaSql: CHANNEL_SCHEMA_SQL, initialize: initializeChannelSqlite, reset: resetChannelSqlite };
export const channelStoreFormat: StoreFormat = {
  applicationId: 0x43484e4c, userVersion: 1, observerKey: 'channel',
  validate(db, location) {
    const identity = db.prepare('SELECT application_id, user_version FROM pragma_application_id, pragma_user_version').get() as Row;
    requireFact(identity.application_id === this.applicationId, 'unrelated SQLite database.');
    requireFact(identity.user_version === this.userVersion, 'unsupported Channel SQLite format version.');
    validateSchema(db, `${STORAGE_META_SQL}\n${CHANNEL_SCHEMA_SQL}`, location);
  },
  reset(db) { resetChannelSqlite(db); resetStorageMeta(db); },
};
export function initializeStandaloneChannel(db: DatabaseSync, revision = 0, description = '# Channel\n'): void {
  initializeStorageMeta(db, revision);
  initializeChannelSqlite(db, description);
}
