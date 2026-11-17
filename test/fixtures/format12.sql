-- Frozen verbatim schema from a6cf8c22; no current initializer or version downgrade.
PRAGMA application_id=1397838405;
PRAGMA user_version=12;
CREATE TABLE storage_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  delivery_revision INTEGER NOT NULL CHECK (delivery_revision BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE square_notices (
  notice_index INTEGER PRIMARY KEY CHECK (notice_index >= 0), at REAL NOT NULL,
  sender_json TEXT NOT NULL, body_json TEXT NOT NULL, metadata_json TEXT
);
CREATE TABLE notice_audience (
  notice_index INTEGER NOT NULL, recipient_key_json TEXT NOT NULL, recipient_json TEXT NOT NULL,
  owner_json TEXT NOT NULL, generation_json TEXT NOT NULL, consumed_at REAL,
  PRIMARY KEY (notice_index,recipient_key_json)
) WITHOUT ROWID;
CREATE TABLE producer_consumption (
  recipient_key_json TEXT NOT NULL, owner_json TEXT NOT NULL, generation_json TEXT NOT NULL,
  sender_json TEXT NOT NULL, match_json TEXT NOT NULL, at REAL NOT NULL,
  PRIMARY KEY (recipient_key_json,generation_json,sender_json,match_json)
) WITHOUT ROWID;
CREATE TABLE square_posts (
  kind TEXT NOT NULL CHECK (kind IN ('activity','notice')), item_index INTEGER NOT NULL,
  recipient_key_json TEXT NOT NULL, token TEXT UNIQUE, owner_pid INTEGER,
  first_export_at REAL NOT NULL, claim_at REAL NOT NULL,
  posted INTEGER NOT NULL DEFAULT 0 CHECK (posted IN (0,1)), full INTEGER CHECK (full IN (0,1)),
  PRIMARY KEY (kind,item_index,recipient_key_json)
) WITHOUT ROWID;
CREATE TABLE square_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_act_index INTEGER NOT NULL CHECK (next_act_index BETWEEN 0 AND 9007199254740991),
  hard_cap INTEGER CHECK (hard_cap BETWEEN 1 AND 9007199254740991),
  throttle_per_minute INTEGER CHECK (throttle_per_minute BETWEEN 1 AND 9007199254740991),
  preamble_json TEXT NOT NULL CHECK (json_valid(preamble_json)),
  warmup_json TEXT NOT NULL CHECK (json_valid(warmup_json))
);
CREATE TABLE activities (
  act_index INTEGER PRIMARY KEY CHECK (act_index BETWEEN 0 AND 9007199254740991),
  at REAL NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('join','done','say','read','listen','ignore','unlisten')),
  actor_json TEXT COLLATE BINARY NOT NULL,
  actor_key_json TEXT COLLATE BINARY NOT NULL,
  reach TEXT CHECK (reach = 'bell'),
  reply_index INTEGER CHECK (reply_index >= 0 AND reply_index < act_index),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  CHECK (kind = 'say' OR (reach IS NULL AND reply_index IS NULL))
);
CREATE INDEX activity_kind_index ON activities(kind, act_index);
CREATE INDEX activity_actor_index ON activities(actor_key_json, act_index);
CREATE INDEX activity_say_actor_index ON activities(actor_key_json, act_index) WHERE kind='say';
CREATE INDEX activity_say_time ON activities(at, act_index) WHERE kind='say';
CREATE INDEX activity_bell_actor_time ON activities(actor_key_json, at, act_index) WHERE kind='say' AND reach='bell';
CREATE TABLE participants (
  name_key_json TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  name_json TEXT NOT NULL,
  first_index INTEGER NOT NULL UNIQUE,
  joined INTEGER NOT NULL CHECK (joined IN (0,1)),
  done INTEGER NOT NULL CHECK (done IN (0,1)),
  say_count INTEGER NOT NULL CHECK (say_count >= 0),
  last_active_at REAL,
  last_join_index INTEGER,
  CHECK (NOT (joined=1 AND done=1))
) WITHOUT ROWID;
CREATE TABLE attention (
  listener_key_json TEXT COLLATE BINARY NOT NULL,
  target_key_json TEXT COLLATE BINARY NOT NULL,
  target_json TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('listen','ignore')),
  since_index INTEGER NOT NULL,
  PRIMARY KEY (listener_key_json, target_key_json)
) WITHOUT ROWID;
CREATE INDEX attention_target ON attention(target_key_json, kind, listener_key_json);
CREATE TABLE landed_audience (
  act_index INTEGER NOT NULL,
  recipient_key_json TEXT COLLATE BINARY NOT NULL,
  recipient_order INTEGER NOT NULL CHECK (recipient_order >= 0),
  reason TEXT NOT NULL CHECK (reason IN ('mention','reply','attention','bell')),
  owner_json TEXT,
  generation_json TEXT,
  PRIMARY KEY (act_index, recipient_key_json),
  UNIQUE (act_index, recipient_order)
) WITHOUT ROWID;
CREATE INDEX audience_recipient ON landed_audience(recipient_key_json, act_index);
CREATE TABLE participant_seats (
  participant_key_json TEXT PRIMARY KEY NOT NULL, participant_json TEXT NOT NULL,
  owner_json TEXT NOT NULL, generation_json TEXT NOT NULL,
  wake_address_json TEXT, attachment TEXT NOT NULL CHECK (attachment IN ('attached','detached'))
) WITHOUT ROWID;
CREATE INDEX participant_seat_owner ON participant_seats(owner_json);
CREATE TABLE caught_activity (
  recipient_key_json TEXT NOT NULL, act_index INTEGER NOT NULL, at REAL NOT NULL,
  PRIMARY KEY (recipient_key_json,act_index)
) WITHOUT ROWID;
CREATE TABLE catch_leases (
  recipient_key_json TEXT PRIMARY KEY NOT NULL, generation_json TEXT NOT NULL,
  lease_json TEXT NOT NULL CHECK (json_valid(lease_json))
) WITHOUT ROWID;
