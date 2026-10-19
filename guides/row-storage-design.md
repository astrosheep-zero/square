# Row-oriented artifact design

**Status: design closed; row runtime candidate implemented and measured, awaiting independent review/acceptance.**
Source baseline: `99679eb` (0.3.70). This document specifies the design; [runtime delivery evidence](row-runtime-delivery-evidence.md) records implementation verification and actual capacity measurements. Explicit migration remains a separately accepted delivery.

## Decision in brief

- Keep one versioned SQLite `.square`; replace whole-history JSON reads/writes with transaction-scoped typed domain reads and transitions.
- Domain code owns behavior; the artifact adapter owns SQLite. Keep the public operation facade; any future daemon runs those operations and their transactions server-side, rather than transmitting callback-based storage ports.
- Persist authority once: activities, sparse receipts, leases, ordered routes and configuration. Maintain participant/attention/audience indices atomically; do not add an inbox, cursor, eligible/notified flags, or a sidecar.
- Keep receiver-owned discovery without guaranteed push. Background traversal must progress despite unrelated writes and revisit earlier withheld candidates on change/expiry.
- Explicit `square --location <path.square> migrate` converts v1 in place in one transaction. No runtime dual format, automatic migration, daemon or socket is added.
- Two acceptance boundaries: row-backed runtime, then explicit migration. Release both together. No claim of 300-process capacity until the implementation is measured.

This document supersedes the exploratory inbox/snapshot sketches and temporary design reports. The domain specification below fixes interfaces/schema/algorithms; the migration and delivery terms fix failure handling and verification. The AGENTS.md amendment is proposed here and lands with runtime implementation, not as a claim about today's authority.

# Domain specification

The interfaces below are the settled private interfaces; public behavior remains unchanged. Migration and acceptance are specified later in this document.

## 1. Boundary and authority

Replace AGENTS.md's `All behavior operates on SquareState ...` sentence, with the runtime change, by:

> Behavior operates on typed Square domain facts obtained through transaction-scoped reads and domain transitions. SQLite schema, SQL, and storage framing remain private to the artifact boundary. Partial fact reads must not masquerade as a complete SquareState.

One typed domain representation: activities, sparse seen receipts, catch leases, and ordered published routes, plus small configuration facts. Current participants/attention and historical landed audience are reconstructible indices. No inbox, continuous cursor, pending flag, eligibility, persisted ordinal, or receiver acknowledgement watermark. Hold is read from the latest hold/resume activity, not another authoritative fact.

Three layers:
- Domain actions validate admission and produce `Act` values; domain projections combine the read capabilities below. Host/network work is outside artifact transactions.
- A domain transaction wrapper implements `SquareRead`/`SquareWrite`. `land()` allocates an index and runs the single shared landing transition. This wrapper owns interpretation of domain facts, not SQL.
- The private SQLite driver decodes typed rows, translates the finite selectors below, and applies typed landing effects. Only this driver performs artifact I/O. No SQL, row objects, statement handles, SQLite names, or transaction capabilities reach renderers/harnesses. The memory adapter implements the same capabilities and uses the same landing transition.

There is no whole-state runtime fallback. Full integrity inspection, legacy migration, and an explicit test/export projection are exceptional bounded-by-request operations; hot callers must not invoke them.

## 2. Exact private domain port

These types are private to the Square library. Public facade Activity/CatchResult/HistoryQuery/SquareSnapshot remain unchanged. Existing `Act`, `StoredAct`, `WatchLease`, `HardCap`, `Perception`, and `WakeRouteKind` keep their meanings; `StoredAct` decoding permits exactly the v1 optional-field distinctions, including absent say.mentions.

```ts
type ActivityIndex = number; // validated nonnegative safe integer
interface SquareHeader {
  readonly revision: number;
  readonly nextActIndex: number; // assigned coordinate boundary, NOT max(index)+1
  readonly lastActIndex: number; // greatest existing row, or -1
  readonly hardCap: HardCap;
  readonly throttlePerMinute?: number;
  readonly preamble: readonly string[];
  readonly warmup: readonly string[];
}
interface ParticipantFact {
  readonly name: string;        // first actor spelling encountered by replay
  readonly firstIndex: number; // roster order
  readonly joined: boolean;
  readonly done: boolean;
  readonly sayCount: number;   // lifetime, including before any join
  readonly lastActiveAt?: number; // max timestamp of actor's activities
  readonly lastJoinIndex?: number;
}
interface AttentionFact {
  readonly listener: string; // canonical actor spelling
  readonly target: string;   // spelling retained when relation was inserted
  readonly kind: 'listen' | 'ignore';
  readonly sinceIndex: number;
}
interface ActivityHead {
  readonly index: ActivityIndex;
  readonly at: number;
  readonly kind: StoredAct['kind'];
  readonly actor?: string;   // actual activity spelling, not roster spelling
  readonly reach?: 'bell';
  readonly reply?: ActivityIndex;
}
interface ActivityFilter {
  readonly afterIndex?: number;  // exclusive; -1 permitted
  readonly beforeIndex?: number; // exclusive
  readonly throughIndex?: number; // inclusive scan fence
  readonly indexes?: readonly ActivityIndex[]; // context union or exact batch
  readonly kinds?: readonly StoredAct['kind'][];
  readonly actors?: readonly string[];
  readonly actorMatch?: 'identity' | 'exact'; // default identity
  readonly actorRequired?: true;
  readonly afterAt?: number; // exclusive; no implicit upper-time bound
}
interface IndexPage {
  readonly edge: 'oldest' | 'newest';
  readonly limit: number; // positive safe integer, internal storage batch only
}
interface FactPage<T> {
  readonly items: readonly T[]; // ascending index, even when edge=newest
  readonly hasMore: boolean;   // more matching rows at the chosen edge
}
interface DirectedFilter {
  readonly afterIndex?: number;
  readonly beforeIndex?: number;
  readonly throughIndex?: number;
  readonly unseenOnly?: true;
  readonly senders?: readonly string[];
  readonly attentionOnly?: true; // route in mention/reply/bell; excludes listener-only
}
interface DirectedHead {
  readonly index: ActivityIndex;
  readonly at: number;
  readonly actor: string;
  readonly recipient: string;
  readonly route: 'mention' | 'reply' | 'attention' | 'bell';
}
interface LandedRecipient {
  readonly recipient: string;
  readonly route: DirectedHead['route'];
}
interface ReceiptFacts {
  readonly latestAt?: number; // ALL exact-owner receipts, including assigned gaps
  readonly latestActorActivityIndex?: number;
  // largest receipt coordinate > afterIndex which has an actor-bearing activity
}
interface ReceiptAssignment {
  readonly owner: string; // original, EXACT outer key, not nameKey(owner)
  readonly index: ActivityIndex;
}
type JsonValue = null | boolean | number | string
  | readonly JsonValue[] | { readonly [key: string]: JsonValue };
interface RouteFact {
  readonly location: string;
  readonly participant: string;
  readonly sessionId: string;
  readonly channel: string;
  readonly kind: WakeRouteKind;
  readonly address: Readonly<Record<string, string>>;
  readonly updatedAt: number;
  readonly epoch?: JsonValue; // v1 validator did not constrain epoch
  readonly extra: Readonly<Record<string, JsonValue>>; // other v1 route properties
}
// Normal publication produces numeric/absent epoch and extra={}.
// Eligibility narrows epoch to number/undefined before creating WakeRoute requests.

interface SquareRead {
  header(): SquareHeader;
  participant(requestedName: string): ParticipantFact | undefined;
  roster(): readonly ParticipantFact[]; // firstIndex ascending
  attention(listener: string): readonly AttentionFact[]; // sinceIndex ascending
  incomingAttention(sender: string): readonly AttentionFact[];
  // incoming matches nameKey(target); includes listen and ignore, not only joined actors
  hold(): { readonly active: boolean; readonly at?: number;
            readonly reason?: string; readonly actor?: string };

  activity(index: ActivityIndex): StoredAct | undefined;
  activityHeads(filter: ActivityFilter, page: IndexPage): FactPage<ActivityHead>;
  activities(indexes: readonly ActivityIndex[]): readonly StoredAct[];
  // existing requested rows only, ascending index; no implicit complete-history load
  activityCount(filter: ActivityFilter): number;
  contextIndexes(centers: readonly ActivityIndex[], before: number, after: number): readonly ActivityIndex[];
  // union of neighboring EXISTING ACTIVITY POSITIONS, before other filters
  sayOrdinals(indexes: readonly ActivityIndex[]): Readonly<Record<number, number>>;
  // only existing says; count same-name says <= target index, over lifetime
  recentSayTimes(afterExclusive: number, takeLatest: number,
                 actor?: string, bellOnly?: true): readonly number[];
  // newest takeLatest timestamps, ascending by timestamp; future timestamps included

  audience(index: ActivityIndex): readonly LandedRecipient[]; // landing recipient order
  directed(recipient: string, filter: DirectedFilter, page: IndexPage): FactPage<DirectedHead>;
  directedAt(recipient: string, index: ActivityIndex): DirectedHead | undefined;
  directedCount(recipient: string, filter: DirectedFilter): number;
  pendingAudience(afterExclusive: number, throughInclusive: number, activityLimit: number): {
    readonly groups: readonly {
      readonly index: ActivityIndex;
      readonly at: number;
      readonly actor: string;
      readonly recipients: readonly LandedRecipient[];
    }[];
    readonly hasMore: boolean;
  };
  // oldest DISTINCT activity indices; each group contains ALL currently joined,
  // post-latest-join, individually unseen recipients, in landing order. No body.

  receipt(requestedName: string, index: ActivityIndex): { readonly at: number } | undefined;
  receiptFacts(requestedName: string, afterIndex: number): ReceiptFacts;
  receiptAssignments(): readonly ReceiptAssignment[]; // explicit SDK snapshot ONLY
  lease(requestedName: string): WatchLease | undefined; // raw, freshness is domain policy
  routes(): readonly RouteFact[]; // complete ordered route array, including duplicates
}
interface SquareWrite extends SquareRead {
  land(activity: Act & { readonly at: number }): StoredAct;
  markSeen(requestedName: string, indexes: readonly ActivityIndex[], at: number): number;
  // count newly inserted receipts; first receipt timestamp is immutable
  putLease(requestedName: string, lease: WatchLease): boolean;
  removeLease(requestedName: string, expectedLeaseId: string): boolean;
  replaceRoutes(routes: readonly RouteFact[]): boolean;
  // structural equality including order/duplicates; no implicit route normalization
}
interface SquareReadResult<R> { readonly value: R; readonly version: number; }
interface SquareCommitResult<R> extends SquareReadResult<R> { readonly changed: boolean; }
interface SquareArtifactPort {
  read<R>(select: (facts: SquareRead) => R, signal?: AbortSignal): Promise<SquareReadResult<R>>;
  transact<R>(change: (facts: SquareWrite) => R, signal?: AbortSignal): Promise<SquareCommitResult<R>>;
  revision(signal?: AbortSignal): Promise<number>; // header-only observation, no domain payload
  changed(sinceVersion: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}
```

Selector semantics are fixed: fields AND; list elements OR; an absent list means no constraint; an explicitly empty list matches nothing. Name comparisons use JS domain `nameKey`, except explicitly exact actor matching. Unknown recipient produces no directed rows; resolution/validation and existing error wording belong to action code. No regex/SQL-expression/predicate injection interface. Pages are finite relational reads, not a new query language. `activities()` is the only multi-body hydration operation.

`pendingAudience` is a domain-defined relation: the domain owns its joined/post-join/exact-receipt predicate and memory equivalent; SQL mechanically implements it. Host eligibility, lease freshness, cancellation, ownership, grace periods, and route/effect authorization are not SQL policy. `activityLimit` bounds complete candidate groups before host eligibility, never the final sweep result. It is the only global pending traversal: required by sweep/dispatch/doctor. Receiver reads never use it. Its limit counts activity groups, not recipients, so a large bell cannot split or lose recipients. Audience hydration explicitly orders by recipient_order (mention order, then reply, then listeners in roster order), never by the recipient primary key. Existing deliverPending dispatch remains roster-major then activity-index-major: collect bodyless groups and iterate per recipient in captured roster order; sweep alone selects ascending distinct activity indices. `routes()` deliberately keeps one ordered value rather than introducing a route query framework or exposing surrogate row ids; route count is not activity-history size.

`participant()` normalizes identity but does not validate the requested string. Receipt and lease methods first resolve to `participant(name)?.name ?? name`, then use **exact owner spelling**. This is runtime.ts/perception-projection.ts behavior; it is NOT lowercase receipt lookup. `receiptAssignments()` returns raw owner/index values (also dormant keys and orphan coordinates). No timestamp map is needed for the SDK closure.

All returned values are detached immutable facts; no `SquareRead`, statement, lazy generator, or function closing over a transaction may survive its callback. Guard every transaction capability after callback completion. Callbacks are synchronous, cannot nest operations on the same artifact, and must not return a thenable. No automatic callback replay after it starts.

### Landing effect and exclusive writers

Private driver write surface, inaccessible to production actions:

```ts
interface LandingEffect {
  readonly activity: StoredAct;
  readonly participant?: ParticipantFact; // actor's new current fact
  readonly removeListeningOf?: string;   // done: listen only, ignore survives
  readonly replaceAttention?: AttentionFact;
  readonly audience: readonly LandedRecipient[]; // empty for non-say
}
interface LandingFacts {
  readonly actor?: ParticipantFact;
  readonly standing: readonly ParticipantFact[]; // roster order, only needed for say
  readonly incoming: readonly AttentionFact[];  // only needed for say's sender
  readonly outgoing: readonly AttentionFact[];  // only needed for listen/ignore
  readonly replyAuthor?: string;
}
function deriveLanding(activity: StoredAct, facts: LandingFacts): LandingEffect;
```

`deriveLanding` is pure and shared by runtime and rebuild. `land()` reads the necessary narrow facts, validates structural invariants (not action admission again), allocates **header.nextActIndex**, calls this transition, and applies the effect plus nextActIndex increment atomically. Migration supplies the preserved assigned indices; it never calls the allocator or admission validation. Earlier reply author lookup uses the existing activity row, including join/done/read/listen/actor-bearing hold; missing earlier coordinate means no author. Valid legacy replay never requires a future author because reply < own index.

`markSeen` accepts any nonnegative index below nextActIndex, even if no activity/participant exists. It refuses unassigned coordinates and non-finite timestamps; it inserts only missing exact-owner receipts. Actions—not a receipt FK—ensure catch/native writes concern the intended activities. Lease writers similarly retain unknown/raw owner fallback. Only receipt insertion marks seen; presentation outcome, cancellation, and wake evidence do not.

`putLease`/`replaceRoutes` compare detached values and return false for semantic no-op; changed revision is not driven by a whole-state comparison. Multiple writes have read-your-writes. Takeover's done then join therefore sees the new participant state in the same transaction.

## 3. Actual v2 table/column/index shape

`application_id=0x53515245`, `user_version=2`, DELETE journal, synchronous FULL. The exact owned schema is these tables and indices; no triggers, views, FTS, runtime sidecar, or additional table. All key and string columns below use **JSON.stringify(string) with BINARY collation**, not raw JS strings. This preserves lone surrogates/NUL, including malformed legacy actor/target/owner/route strings and their derived keys. Equal JSON-string encodings mean exact JS-string equality. Normalized keys encode the result of JS `nameKey` (never SQLite LOWER). Decode at the artifact boundary.

Body/mentions/through/target and other non-indexed fields are stored once in typed payload JSON. Indexed structural fields are NOT also present in activity payload. Schema checks are storage framing; per-kind payload validation and cross-row assigned-coordinate checks are boundary validation.

```sql
CREATE TABLE square_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  next_act_index INTEGER NOT NULL CHECK (next_act_index BETWEEN 0 AND 9007199254740991),
  hard_cap INTEGER CHECK (hard_cap BETWEEN 1 AND 9007199254740991),
  throttle_per_minute INTEGER CHECK (throttle_per_minute BETWEEN 1 AND 9007199254740991),
  preamble_json TEXT NOT NULL CHECK (json_valid(preamble_json)),
  warmup_json TEXT NOT NULL CHECK (json_valid(warmup_json))
);
CREATE TABLE activities (
  act_index INTEGER PRIMARY KEY CHECK (act_index BETWEEN 0 AND 9007199254740991),
  at REAL NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('join','done','say','hold','resume','read','listen','ignore')),
  actor_json TEXT COLLATE BINARY,
  actor_key_json TEXT COLLATE BINARY,
  reach TEXT CHECK (reach = 'bell'),
  reply_index INTEGER CHECK (reply_index >= 0 AND reply_index < act_index),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  CHECK ((actor_json IS NULL) = (actor_key_json IS NULL)),
  CHECK (kind IN ('hold','resume') OR actor_json IS NOT NULL),
  CHECK (kind = 'say' OR (reach IS NULL AND reply_index IS NULL))
);
CREATE INDEX activity_kind_index ON activities(kind, act_index);
CREATE INDEX activity_actor_index ON activities(actor_key_json, act_index);
CREATE INDEX activity_say_actor_index ON activities(actor_key_json, act_index) WHERE kind='say';
CREATE INDEX activity_say_time ON activities(at, act_index) WHERE kind='say';
CREATE INDEX activity_bell_actor_time ON activities(actor_key_json, at, act_index) WHERE kind='say' AND reach='bell';

CREATE TABLE receipts (
  owner_json TEXT COLLATE BINARY NOT NULL,
  act_index INTEGER NOT NULL CHECK (act_index BETWEEN 0 AND 9007199254740991),
  at REAL NOT NULL,
  PRIMARY KEY (owner_json, act_index)
) WITHOUT ROWID;
CREATE INDEX receipt_owner_time ON receipts(owner_json, at);
CREATE TABLE catch_leases (
  owner_json TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  lease_id_json TEXT NOT NULL,
  heartbeat_at REAL NOT NULL,
  expires_at REAL NOT NULL CHECK (expires_at >= heartbeat_at),
  filter_json TEXT CHECK (filter_json IS NULL OR json_valid(filter_json))
) WITHOUT ROWID;

CREATE TABLE routes (
  position INTEGER PRIMARY KEY CHECK (position >= 0),
  participant_key_json TEXT COLLATE BINARY NOT NULL,
  session_json TEXT COLLATE BINARY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('opencode-server','codex-queue','claude-native','paseo')),
  updated_at REAL NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
);
CREATE INDEX route_participant ON routes(participant_key_json, position);
CREATE INDEX route_session ON routes(session_json, position);

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
  route TEXT NOT NULL CHECK (route IN ('mention','reply','attention','bell')),
  PRIMARY KEY (act_index, recipient_key_json),
  UNIQUE (act_index, recipient_order)
) WITHOUT ROWID;
CREATE INDEX audience_recipient ON landed_audience(recipient_key_json, act_index);
```

No foreign keys. In particular receipts must not reference activities or participants; replies/through must not require existing rows; leases/routes must not require known names. Derived tables are maintained and checked against authority, not used to reinterpret permissible v1 authority as invalid. `next_act_index > greatest existing activity index` and receipts < next_act_index are checked by the boundary (all receipts only on full integrity/import; inserted receipts on writes). No contiguous-index constraint. Finite fractional activity/receipt/lease times remain REAL, not INTEGER. Number-safe limits are enforced in the codec and allocator.

Activity payload shapes, with optional-property presence preserved:
- join/resume: `{}`.
- say: `{body: string, mentions?: string[]}`; reach/reply live only in their columns.
- done/hold: `{body?: string}`.
- read: `{through: number}`; no reference check on through.
- listen/ignore: `{target: string}`; no participant reference check on target.
Actor's original spelling lives in actor_json; actor_key_json is its indexed identity derivative. Neither is repeated in payload. Indices store coordinates/keys, never duplicate bodies.

Route payload contains location, original participant spelling, channel, address, optional epoch, and all extra properties accepted by the v1 validator; sessionId/kind/updatedAt are reconstructed from columns. `participant_key_json` is only a derivative, not a replacement for original participant spelling. Routes have **no unique identity constraint**. Import positions are array positions; `replaceRoutes` can rewrite this small array to positions 0..n-1. Holes in positions from internal deletion are harmless provided order is retained, but the chosen runtime replacement implementation rewrites contiguous positions. No canonical-location column: legacy routes retain raw locations; current route policy canonicalizes when it currently does, and wake/native equality does not silently gain canonicalization.

Preserve finite route epoch/extra JSON values and empty strings; do not otherwise tighten their legacy shapes. Use ordinary JSON encoding, not a bespoke numeric codec. Migration explicitly refuses non-finite numbers anywhere in a route (updatedAt, epoch, or nested extras) before DDL/inserts and leaves the artifact unchanged; never silently coerce them to null. These exponent-overflow values can pass the old permissive validator on manually authored JSON, but are not non-finite values normally persisted by the v1 JSON.stringify writer. Runtime codecs likewise require finite route numeric values. Raw schema equality is not receipt or participant equality.

No receipt `state` column: all receipts are seen. No persisted hold table: `hold()` selects last hold/resume using activity_kind_index; resume returns inactive with no stale reason/actor/time. No additional name registry: a participant is first touched by ANY actor-bearing activity, not necessarily join.

## 4. Exact derived transitions and routes

Landing uses pre-activity participant/attention facts:
1. Compute a say audience first. Resolve deduplicated mentions against standing roster (bell: all standing); then standing reply author; then active listeners in roster order. Skip sender and duplicate recipients. Ignore blocks all non-bell reach; bell bypasses ignore. Store ordered unique recipients and priority **bell > mention > reply > attention**. Explicit self mention remains in activity metadata but creates no self audience edge. Missing/departed reply author creates no edge; action result retains existing replyAuthorNotHere semantics.
2. Touch actor if new: name is first actor spelling, joined=false, done=false, sayCount=0. Update lastActiveAt with max(existing, activity.at), not latest-by-index time.
3. join sets joined=true/done=false and lastJoinIndex=index. done sets joined=false/done=true and clears OUTGOING listen only. Ignore survives departure/rejoin; incoming attention is not cleared. Say increments lifetime count, even for unusual imported prejoin/postdone sequences.
4. listen inserts listen only when not already listening; removes matching ignore. ignore removes matching listen and inserts ignore only when absent. Preserve target's first retained spelling and relation order, including unknown/self targets. A no-op legacy activity still touches actor time; replay never applies the current ten-name admission cap. hold/resume remain events; read does not acknowledge receipts or advance a persisted cursor.

There is one production transition, no SQL triggers and no separate migration fold. Test-only frozen old fold/replay supplies differential evidence. Index integrity checking can rebuild through the production transition but cannot replace differential tests with self-comparison.

Existing route policy remains domain code over `routes()` plus `replaceRoutes()`:
- Identity is canonical location + nameKey(participant) + EXACT sessionId where routes.ts currently uses routeIdentityKey. Applying a route removes **every** matching identity and appends one new row at the tail. Nonmatching order is preserved.
- Idempotent publish is no-op only with exactly ONE matching row, matching kind/channel/address/epoch, and existing.updatedAt > at - ROUTE_FRESH_MS. Equality compares address key/value sets, not property enumeration order. Duplicate matching rows force removal-and-tail-append even if one matches. A fresh future timestamp can therefore suppress refresh as today.
- requireCurrentSession refuses publication when participant is not joined or a foreign-session route exists at that canonical location. It does not claim host ownership in the artifact.
- Session/participant/ended-session retirement retains the current expectedEpoch/force/liveParticipants predicates. Unknown ledger evidence keeps a joined route where current code keeps it. Takeover removes participant routes across all locations as current square-actions does; ordinary join removes only at its supplied location.
- Wake eligibility joins routes with host ownership, selects maximal updatedAt per recipient **including ties**, and preserves array order of tied routes. Native preview still selects the FIRST matching array entry under its existing kind/session/exact epoch/name/address predicates. Do not replace either with a uniqueness constraint or timestamp-only arbitrary tie break.
- `RouteFact.extra` is a lossless boundary envelope; policy does not consult it. Epoch narrows only after exact ownership matching; malformed epoch cannot acquire an owner by coercion. Typed transport requests remain WakeRoute.

## 5. Cursor, receipts, presence, catch — fixed algorithms

Let P be resolved participant, K=P.name (or requested raw spelling if unknown), J=P.lastJoinIndex ?? -1. All receipt membership queries use encoded **K exactly**.

### Continuous cursor

Find B = smallest landed-audience index > J without receipt (K,index). Then find C = greatest EXISTING activity index > J and < B (no upper bound if no B), with actor present and kind != read. Return max(J,C), with missing C treated as J. Implementation uses `directed(... unseenOnly, oldest limit=1)` and `activityHeads(... actorRequired, kinds excluding read, newest limit=1)` in the SAME transaction. It does not read every intervening activity body.

Why this is exact: audience edges only exist on peer says. Before the first unseen addressed say, own and nonaddressed actor-bearing non-read events all advance readCursor. Read and actorless events do not. No cursor at B-1 is invented: if J=4, actor-bearing act/7 exists, act/9 is actorless, and unseen addressed act/12 blocks, cursor is 7, not 11 or 9. Seen act/13 beyond that hole does not advance it.

### Evidence and presence

`receiptFacts(K,J).latestAt` is MAX timestamp over ALL exact-owner receipts, including orphan coordinates and prejoin receipts. Joined participants' lastActiveAt for status is max(participant lastActiveAt, this timestamp); done/nonjoined participants ignore receipt timestamp for status. This matches current status, even though notification pending has a latest-join cutoff.

Presence anchor: if no join, return -1. E=max(J, largest own actor-bearing activity >J, largest receipt coordinate >J that actually has an actor-bearing activity). Read is allowed as evidence here. Anchor is greatest say/done index >J and <=E; if none, -1. Orphan receipts do not anchor presence. Nonaddressed activity advances cursor but is NOT evidence of presence. Get own head by actor identity/newest, evidenced receipt coordinate by receiptFacts, and final say/done head by range/newest. No full-history hydration.

### Counts and admission

- Suffix/behind/unreadActivityCount use directed rows > continuous cursor, **including individually seen rows beyond a hole**. Notification pending instead requires joined, >latest join, individually unseen. Do not substitute one count for the other.
- Hard cap uses lifetime sayCount. Quorum uses all known peers' done booleans (there must be at least one peer), not only currently standing peers.
- Throttle: request newest `limit` global say times with at > now-THROTTLE_WINDOW_MS; if that many exist, releaseAt is the oldest returned + window, retry=max(1, releaseAt-now). Bell: newest 1 actor bell timestamp > now-1h; that timestamp +1h is nextAt. Neither query excludes future timestamps.
- Behind summaries retain current per-sender counts/latest timestamp, last THREE suffix previews and their **suffix-relative** numbering. Lifetime sayOrdinals are for ordinary history/feed rendering; they are not substituted for unread-summary numbers. Block only when !force, suffix nonempty, and freshest summary age > UNREAD_BLOCK_GRACE_MS; max(0,now-at) remains the age. force bypasses behind only.

### Catch transaction

Resolve known viewer, validate options in the existing order, use one write transaction. Ordinary catch queries historical directed unseen rows (NO lastJoin cutoff), with senders and attentionOnly as applicable, oldest limit (default 10/max 100). `from:[]` matches nothing. Attention-only includes mention/reply/bell routes but not listener-only. Since directed membership is already true, these route categories exactly match current catch's viewer mention/reply/bell filter. Fetch bodies for selected indices only; insert seen receipts; compute resulting continuous cursor. **Ordinary remaining is filtered unseen count after insertion**. Exact-id catch verifies activity existence and historical directed membership, permits repeat of already-seen activity, and computes remaining over ALL historical directed unseen rows; repeat receipt has no write/revision change. Retain current conflict of id with own-property idle/from/mention/limit, error facts, and no standing requirement for catch.

Catch and concurrent ordinary catches serialize under BEGIN IMMEDIATE; filtered/exact later catch does not cover an earlier hole. Lease freshness stays expiresAt>now AND now-heartbeatAt<=WATCH_STALE_MS. Boundary lease ownership covers every matching notification, not only a catch page. Matching boundary lease uses current route-priority representation exactly as leaseOwnsNotification does, not a new raw mention interpretation. Generic wake eligibility does not acquire a new catch-lease gate; native preview retains its existing lease gate.

## 6. Paging, immutable pages, and independent discovery

Internal page size is **100**. It is not a presentation limit. Complete snapshot/history/catch operations assemble their result in ONE synchronous read/write transaction; internal pages all share that transaction. `sessionInbox` likewise assembles the COMPLETE artifact projection for each bound recipient in one synchronous read callback, then observes host eligibility outside it. Multiple artifacts and host evidence are not a distributed snapshot.

Background traversal across page transactions instead captures immutable upper bound H=lastActIndex, original lower bound L, and each relevant recipient's canonical name + lastJoinIndex + joined state, captured together in the first artifact read transaction. Capture the detached host binding coordinate (session/channel/epoch, cancellation scope) separately under subscribe-before-read; heartbeat/updatedAt changes alone are not a new ownership coordinate. Its ephemeral position is the last examined activity index. **Do not restart on unrelated revision changes**: doing so starves a scan under continuous writers. Activities and landed edges <=H remain immutable; page values already returned are detached immutable values, not live views. Receipts/leases/routes may change during the pass, so this background collection is not advertised as a single artifact/ledger snapshot.

Advance past each scanned candidate even when host evidence/local exclusions/lease withhold it; global traversal advances past the entire activity group. Continue until bounded relation exhausted or caller's EXISTING post-eligibility selection limit is full. Sweep limit counts distinct eligible activity coordinates; early suppressed rows never consume it. New landing >H waits for the next pass. A relevant join/binding change invalidates only that recipient's pass; discard its accumulated candidates and schedule its new pass, rather than restarting other recipients. In global pages keep only the initially captured recipients whose join coordinate still matches; newly bound/rejoined recipients belong to their next pass. Final per-recipient join/binding checks also cover departure with no later returned candidate.

Track changes observed during a pass as a retained request for a subsequent pass FROM L, not as an acknowledgement through the last-examined index; don't interrupt finite progress for unrelated changes. Consume that request only when the follow-up pass begins, not when the old pass finishes; never acknowledge a newer observer revision as scanned. Retain the earliest relevant expiry of withheld candidates. Revisit withheld earlier candidates on that next pass or expiry. Before any transport/presentation/receipt effect revalidate the relevant join/binding, pending receipt, route/lease/cancellation and host claims/evidence with fresh reads and existing fences. A stale candidate can be skipped without claiming receipt. No DB transaction spans awaits to ledger/network. This policy makes finite traversal progress despite unrelated writers without pretending mutable eligibility is frozen.

`sessionInbox` remains COMPLETE per bound recipient: in its one read callback accumulate every post-latest-join unseen directed candidate and every required body, not the first storage page. Boundary rendering still owns its existing 1200-character limit/clipping/omission decisions. Pi's initial observer keys and its fresh complete lookup/observed keys retain their existing roles. After a successful Pi batch, **all initial batch keys**, including entries omitted from rendered context, enter handledPending exactly as today. Storage pages do not create separate batches or shrink that key set. Selected preview bodies can be separated from bodyless eligibility summaries only if this complete-result and exact batch-key behavior stays unchanged. The initial implementation keeps complete sessionInbox bodies; paged domain reads already eliminate unrelated-history hydration.

Observe/capture ledger changes BEFORE discovering bindings; subscribe/capture each artifact BEFORE its projection. Cache only the version actually projected, never the observer's later revision. Artifact/relevant ledger changes and catch-lease/host-claim expiry schedule reconsideration without restarting an active finite pass; relevant join/binding change invalidates only that recipient's pass. Failed injection evidence alone must not generate a retry spin. Unreadable artifact is retried, not cached as an empty current inbox; one failure does not disable other bindings.

Keep filesystem hints plus the existing 2-second authoritative revision reconciliation; producers may push or fail to push. Each receiver reads only its own bound participant relation. Pi/OpenCode autonomous loops stay; Claude stays its existing lifecycle/tool/turn-boundary discovery with bounded recovery. This storage contract does NOT add a Claude resident loop or claim every harness currently has idle discovery.

## 7. Complete caller replacement map (including render dependencies)

No production structure below carries `.state`, all `.activities`, or a deferred DB query. Renderers receive settled perceptions and numbers, never recompute audience from a partial SquareState.

| Current callers | Exact facts/replacement |
|---|---|
| openSquare/openSquareArtifact, wait baselines, watch headers, cli/program | header/revision only; remove preliminary whole-state validation/load. Every normal selected-row decode remains validated. |
| square-actions join/implicitJoin/takeover/done/endOwnedSession, registry-associated route cleanup | participant/roster as needed, routes, land/replaceRoutes; same host claim lock scopes and cleanup sequences. Takeover done+join is one txn. No full SDK snapshot. |
| createSquareApplication.join's before/after snapshot and CLI hold/resume/done count calls | new internal `joinFacts(name)` projection = requested participant, known joined-or-done count, standing count. Before conflict pending uses known joined-or-done count as today; application's participantCount keeps its existing known joined-or-done semantics. CLI header after hold/resume/done uses standing count. Wire private helpers on Square/context rather than calling public snapshot. |
| express/decideAct and behind rendering (activity.ts) | header, actor fact, roster for longest standing-body mention resolution, hold, reply head/existence, recentSayTimes, continuous cursor, directed suffix. Admission normalization/error order unchanged. A valid reply coordinate is <nextActIndex, even if a gap: preserve current acceptance of assigned-but-missing reply. ActivityPresentation supplies own count/cap/hold/roster, suffix items with lifetime ordinals + settled full perception, and behind summaries. No whole history used just to number previews. |
| listen/ignore/listening, watch leases and terminal checks | actor fact, outgoing attention; roster only for quorum; land or lease methods. Unknown valid attention target still allowed. Pulse keeps hold-before-terminal priority. |
| catch / native seen | directed selectors/activity exact, markSeen, cursor/counts in txn; native `current` becomes synchronous `(facts: SquareRead)=>boolean`, evaluated ONLY within reads/receipt txn. It cannot escape or call host I/O. |
| entryPresentation / cli/square-commands join | bounded newest say/done heads then bodies; selected sayOrdinals; explicit per-index perceptions for the selected viewer; header context/scene; actor's join count from activityCount(kind join, actor identity). Supply `joinedBefore` rather than replaying `.state.acts`. `lastN=null` remains an explicit complete history request, not normal join's default. |
| statusPresentation / cli/observation-commands status | roster+attention, hold, receiptFacts, continuous cursors and directed counts, fresh lease status; latest say/done + ordinal. Supply last THREE join events after latest public index, total number of such joins, and each `rejoined` boolean from existence of earlier done with EXACT actor spelling (current CLI equality). Latest line carries settled perception for context.name (including '' ambient viewer), not a SquareState. No receipts/history map hydrated. |
| participants/participantsPresentation/listPresentation | roster-derived status sorted by existing compareParticipantActivity; receipts/leases aggregates for participant statuses; list requires only active names, header preamble and say count. Change probeSquare to create a validated file-backed port, not full read then memory clone. |
| history / participantHistory / historyPresentation | relational head filter + contextIndexes; hydrate filtered candidate bodies for JS search, otherwise page only; count before final limit; selected ordinals + detached presence anchors/perceptions. Retain CLI lifecycle archive/raw coordinate windows and facade non-read inclusion. See algorithm below. |
| watchPresentation/watch.ts/renderWatchOutput | pass caught activity ids into projection; hydrate ONLY those rows, selected lifetime ordinals, caller-supplied caught perceptions, participant statuses/clock, count/cap/terminal. Finish/terminal-only call omits ids. No all-history lookup of caught ids. |
| streamProjection/streamTailProjection | ordinary stream pages raw activity heads BEFORE recipient filtering (100 existing rows), advances cursor to last examined raw row even on empty recipient output. Recipient stream filters historical audience, not pending/seen/latest-join. Tail selects last N matching rows but cursor is artifact's last actual index. Includes raw lifecycle/read exactly where current stream does. |
| sessionInbox/projectPresentation/boundary | participant joined/latestJoin + recipient directed unseen pages + lease; complete result using §6. Boundary's stale-activity fallback uses activity(index) existence, not `.acts.every`. |
| deliverPending/sweep/delivery-health/notifications | pendingAudience groups or audience(activity)+joined/latestJoin+receipt checks for exact activity, ordered routes and detached host ledger evidence. Eligibility projection takes these typed facts instead of state. Sweep scans past suppressed candidates. Health can explicitly collect its complete pending summaries without bodies; renderer's existing detail cap stays. |
| Claude cancellation/resume/route discovery | cancellation=max existing activity index with at<=cutoff (not assumed chronological time); use newest activity-head pages in one read txn, testing timestamps from greatest index downward and stopping at the first match. If none matches, cutoff is -1. Resume last join/done by EXACT actor spelling; no full snapshot. Routes keep first-match order. |
| nativePendingPreview (Claude/OpenCode), WakeCurrentness | exact directedAt + joined/latestJoin/unseen receipt, routes first-match/exact epoch/address, fresh lease, captured cancellation cutoff. Generic currentness still joins selected owned routes with host evidence; does not newly consult lease. Pre-effect projection does not persist eligibility. |
| public Square.snapshot().delivered(name,id) | explicit receiptAssignments + detached roster resolution + small header/status in ONE read txn, as below. Other production callers must not use this for count/standing. |
| doctor / explicit import/export tests | full selected-row validation and replay comparison of indices; detached result includes standing count, not state for CLI header. Legacy validator lives only in explicit migration/test oracle. No automatic repair. |

### Public SDK snapshot closure

Keep synchronous arbitrary `delivered(name,id)`. `snapshot()` intentionally copies ALL raw receipt assignments into a private detached Set keyed by JSON.stringify([rawOwner,index]), along with an immutable nameKey->first-roster-spelling map. Closure validates/parses id with current parseRequiredActivityId, resolves `map[nameKey(name)] ?? name`, and tests that exact owner/index set. This covers dormant raw owner keys, orphan assigned coordinates, unknown-name fallback, and arbitrary later calls after port close. It does not query a DB or retain SquareRead. Later writes do not alter this snapshot. No receipt times/activity bodies are copied. This O(receipts) exception is necessary for the existing synchronous API, and is limited to explicit SDK snapshot calls; lifecycle/status/poll/render use narrower helpers.

### History algorithm

1. In one read txn resolve known participant filters and optional known audience recipient; establish context union by existing activity positions, then AND index/time/actor/audience filters. Audience filter uses landed edges, including attention, not body tokens or current listening. API history includes non-read activities; CLI ordinary history hides read; CLI --at/context/--since retains its current raw candidates. Plain CLI rendering hides listen/ignore only at rendering, so those rows still occupy a page slot.
   Execution is fixed: with an audience filter, enumerate historical `directed` pages without unseenOnly or a join cutoff; intersect each page's indices with the context union and other index/time/actor/kind filters through `activityHeads`. Without an audience filter, enumerate `activityHeads` directly. Continue the source traversal even when an intersection is empty. Public limiting follows the remaining filters/search; storage page exhaustion is distinct from a filtered empty page. This composition needs no new audience selector or query framework.
2. Nonempty regex/fixed search additionally restricts to say/done. Compile existing JS case-insensitive search once and test id/actor/body, not SQL LIKE/SQLite regexp. Iterate all relationally matching candidate body pages in the txn to count matches; maintain only the requested edge's selected page plus the needed existence/count metadata. Regex remains potentially expensive exactly as current engine; no new safety claim. Empty supplied pattern keeps current no-search semantics for facade.
3. Default/before selects LAST N filtered matches; after selects FIRST N. Select chronological edge first; desc reverses ONLY selected page. A complete request remains explicit and follows existing CLI maximum refusal. Continuation availability is computed over the current archive-visible kind set and current public page min/max, preserving current text/JSON differences; it is not simply a raw-head hasMore flag. Return total search matches, selected rows, public-before/public-after existence, selected ordinals and all anchor names landing on selected coordinates.
4. Presence anchors are the §5 evidence algorithm for all roster names; compute without full hydration and attach only selected-coordinate annotations in roster order. Context positions include read/actorless activities; coordinate arithmetic must not replace position selection. History across separate calls promises stable activity-id coordinates, not frozen mutable receipt/presence annotations.

## 8. Error/transaction lifecycle (fixed)

- Open existing artifact create-disabled; validate owned header/schema before persistent pragmas, and validate again in the transaction. New runtime refuses v1 with existing invalid_args plus migration_required recovery per lead terms; no dual read or automatic migration. Missing/unsupported/corrupt refusal semantics stay; selected row corruption is reported on access. Full doctor checks unrelated rows explicitly, rather than every hot read scanning authority.
- `read` starts one SQLite read transaction and pins revision before callback. Results are detached. A busy acquisition before callback may retry after the existing 25ms cancellable yield. No callback replay once invoked. `transact` starts BEGIN IMMEDIATE, invokes once, performs domain writes/read-your-writes, and increments revision ONCE if any authoritative value changed. No-op transaction returns unchanged version/changed=false; no whole-state clone/deep-equality cycle.
- BUSY COMMIT retries the SAME transaction/callback result. SQL/codec/callback error, thenable result, expired capability use, close, or abort before successful commit rolls back; capability is invalidated on every exit. Callback throw retains the original error. Exhausting safe nextActIndex/revision refuses before irreversible commit. If callback catches an internal driver failure, transaction is marked failed and cannot commit partial changes. A harmless domain validation exception can be caught before a write (needed by endOwnedSession's already_done/not_joined handling).
- Per-port queued writes and reads-after-prior-writes retain current ordering; memory port has equivalent serialization/no-op/revision behavior. Close aborts busy waits, waits for queued operations, releases observers/handles, and is idempotent; changed() returns false on close. Explicit caller abort propagates its reason. No returned callback/result exposes DB lifetime.
- External side effects never occur within an artifact txn. Preserve join claim->artifact->presence/route cleanup, lifecycle claim locks, wake claim->fresh checks->adapter->terminal evidence, and presentation read->claim->reread->sink->receipt txn->evidence. `presentPending` may use its current predicate only on SquareRead; native payload/epoch/lease fence is recomputed there. Clipped presentation returns success without seen; exact/native markSeen preserves first receipt time.
- Only admission failures get activityUnsent=true. Storage errors and failures after commit do NOT claim safe resend; successful commit cannot be retroactively rolled back by route/ledger/network failures. No distributed transaction/exactly-once remote presentation is asserted. Existing claim recovery/cancellation scopes remain in host ledger/adapters, not moved into artifact tables.

## 9. Closed decisions / handoff

No unresolved product decision remains for this storage design. Chosen cost tradeoffs are intentional: O(recipients) audience rows at landing (bells included), indexed exact counts/ordinals may scan keys, regex history still examines matching bodies, explicit SDK snapshot copies receipts, and complete sessionInbox remains complete. These are not promises of measured capacity. Host-ledger format/global NDJSON parsing/GC and harness scheduling improvements are excluded.

Migration implements the schema here using the single explicit in-place transaction below; it does not invent the schema/keys/domain transition. Verification, two independently acceptable deliveries, and capacity evidence are fixed in the migration and delivery terms below. Receipt lookup uses exact canonical roster spelling; route ordering/duplicates are retained; no mandatory backup or --check/--backup/max-workers configuration is introduced.

# Migration and delivery terms

These terms apply together with the domain specification above.

## Migration protocol

- Only `square --location <path.square> migrate`. No --check, --backup, --force, auto-migrate, bulk mode, separate lock database, sidecar, daemon, or runtime dual reader. An operator can make an offline backup with ordinary tooling; the command does not invent a backup lifecycle.
- application_id remains 0x53515245; user_version 2 identifies rows. Normal new-format reads/writes refuse version 1 with invalid_args / reason migration_required and descriptive offline-migration guidance. The CLI adds the shell-quoted recovery command; native tool errors do not embed invocation syntax. build --force does not bypass it. Unknown/unrelated/invalid formats are refused, not repaired.
- `doctor` remains read-only: recognizes legacy v1 and prints the migration recovery command (exit 2); validates v2 fully, including a replay comparison of derived indices. It must not imply that legacy v1 is damaged. Directory/list probing retains omission semantics for unsupported files; no new implicit migration/discovery subsystem.
- Open existing canonical path create-disabled. A read-only preflight establishes owned known schema/version before any persistent pragma or DDL. Require existing DELETE journal mode, refuse another mode without changing it; the shipped v1 creator/writer already establishes DELETE. Set connection busy_timeout=0 and synchronous=FULL. Acquire BEGIN IMMEDIATE, re-check format/schema under the lock, and validate the full v1 snapshot inside it. If v2 is already present and has valid framing/header, return already-format-2 without changing revision. A second migrator follows this same in-lock check.
- Use v1 validation retained ONLY in migration (test oracle may also retain it), plus one explicit restriction: non-finite numbers anywhere in a route (including nested extras) are unsupported input, refused before DDL/inserts with the artifact untouched. They are not normally persisted as non-finite values by the v1 JSON.stringify writer; do not add a bespoke overflow-number codec or silently coerce to null. Copy normally persisted authoritative facts losslessly, preserving revision and nextActIndex, activity indices/gaps and optional field distinctions, raw receipt/lease owner keys, route order/duplicates, strings and finite fractional timestamps. Absent routes and [] both become zero rows; empty receipt-owner maps are behaviorless and may become zero receipt rows. Do not canonicalize receipts or add foreign keys that reject accepted v1 facts.
- Actual receipt lookup is exact canonical roster spelling, not lowercase nameKey: preserve the raw owner-key relation and resolve lookup via the domain. Free-form JS strings must survive SQLite binding; JSON string encoding (including for key strings where necessary) preserves lone surrogates. All normalized lookup keys come from domain nameKey, never SQLite LOWER.
- Create v2 tables and insert authority. Build derived participant/hold/attention/audience facts with the SAME single-step domain transition used by runtime landing (admission checks are NOT replayed). Check insert/constraint failures normally; do not add a second full replay or a second in-memory copy just to validate the function against itself. Lossless authority equality and old-replay equivalence are migration tests; doctor can explicitly recompute indices for integrity checking. Drop square_snapshot. Set user_version=2 inside the same transaction. Commit once; nothing is published piecemeal.
- Busy acquisition/read retries yield using existing 25ms retry and operation cancellation. Busy COMMIT retries the same transaction; never rerun copy or domain callback. Error/abort before successful COMMIT rolls back. Process death before commit recovers v1 through SQLite journal; after commit leaves complete v2. Preserve path/inode/registry identity. No host-ledger mutation and no synthetic activity.
- Storage exclusion is guaranteed for the shipped SQLite v1 runtime because it validates again after BEGIN IMMEDIATE: its write commits before migration, or it sees v2 and refuses afterward. A pre-migration read can finish with its old snapshot. Migration does not revoke in-flight remote delivery or stop processes; recommend stopping/upgrading attached runtimes for an operationally quiet migration. Arbitrary external path replacement and pre-SQLite binaries are outside the artifact update protocol. Do not claim a distributed transaction or exactly-once remote delivery.

## Independent discovery and concurrency

- Keep filesystem hints plus 2-second autonomous authoritative revision reconciliation. Producer push remains optional; each receiver asks for its own bound recipient facts, not everybody's inbox. Subscribe/capture before inspecting bindings/artifact; don't acknowledge a revision newer than the data actually read.
- Page scans use an immutable upper activity bound and ephemeral last-examined index. Apply eligibility after scanning, continuing beyond withheld rows. A page limit is NOT a presentation/catch limit. An exhausted, suppressed scan cannot permanently forget candidates: artifact/ledger changes schedule reconsideration without restarting the active pass; relevant join/binding changes invalidate that recipient's pass; relevant expiry schedules reconsideration even without a write. Existing local cancellation and Pi omitted-batch suppression are not receipts and keep their scope.
- Complete user-facing snapshot/history/catch operations assemble their result in one synchronous read/write transaction, paging internally if useful. Background discovery across page transactions instead captures immutable upper activity bound plus relevant join/binding coordinate. Unrelated revisions must NOT restart its progress (that would starve under continuous writes). Receipts/leases/routes can change during scanning; recheck relevant join/binding and freshness before effects. Capture upper bound and join coordinate together in the initial artifact transaction; capture host binding separately. Compare semantic coordinates, not heartbeat timestamps. A change during a pass remains pending until the follow-up pass begins from the original lower bound, not from last-examined as an acknowledgement; never mark a newer observer revision consumed at completion. Retain earliest relevant withheld-candidate expiry. Relevant join/binding changes invalidate that recipient's pass. Background artifact+ledger eligibility is not advertised as a single snapshot. No DB transaction spans awaits to ledger/network.
- Preserve existing complete-result APIs. The explicit full SDK snapshot may copy receipts needed by its synchronous delivered() closure, but join/status/poll/render hot paths must not call that full snapshot just for counts. No DB callback/query capability survives transaction completion.
- This storage delivery preserves Pi/OpenCode idle discovery and existing Claude lifecycle/boundary behavior. It does not quietly add a new Claude resident poller. Any stronger harness scheduling change is separately scoped.

## Acceptance boundary and verification

Two independently acceptable implementations, not one aggregate:
1. Row-backed runtime: new format creation, domain port and single transition, all production callers moved, old whole-state runtime path removed, v1 refusal/doctor recovery, public behavior preserved and cost evidence.
2. Explicit v1 migration: depends on the settled v2 schema/transition; migration CLI and transactional preservation/recovery evidence. Core v2 behavior can be accepted on newly created artifacts without migration; migration is independently accepted on v1 fixtures. Release should ship both together so existing users have the recovery command.
Host-ledger format/GC, daemon/socket service, new notification delivery semantics, version pinning, and publication are excluded.

### Mandatory deletion and simplification acceptance

This is a replacement, not an additive adapter layer. Acceptance MUST reject an implementation that leaves the unnecessary old machinery in place even if behavior tests pass.

- Remove the production whole-state read/transact/snapshot-replacement path, full-state clones/deep-equality write detection, replay-per-operation delivery/perception closures, obsolete `FromState`/delta bridges, and `.state`/whole-history renderer inputs replaced by the caller map. Delete dead callers, exports and tests of removed implementation details; retain behavioral coverage.
- One production landing transition and one definition of each domain predicate. No parallel old/new runtime paths, compatibility wrappers, generic query framework, duplicate conversion layers, or unsupported defensive branches. The v1 decoder exists ONLY for explicit migration; frozen legacy semantic oracles are test-only. Full doctor/export and explicit SDK snapshot exceptions are narrow capabilities, not runtime fallbacks.
- Hand-written production source must be net smaller than pre-change baseline `99679eb2905dde5f282025bc7f5494f7da065e54`, both for the runtime candidate and the final combined runtime+migration candidate. Migration adds only its necessary one-time conversion code and must fit that combined reduction; it need not be net-negative relative to the already reduced runtime candidate. Count tracked production `.ts`, `.js`, `.mjs` files; exclude tests/fixtures, scripts, documentation, generated output, vendored references and dependencies. No unrelated deletions, moving production code into excluded paths, code minification, formatting-only reductions or removing behavioral tests to game the result.
- Delivery evidence includes the deletion/replacement map (old mechanism → replacement or removal), remaining legacy-reference search with justified migration/test-only exceptions, and production additions/deletions/net delta against the fixed baseline. Independent review judges unnecessary abstraction and duplication in addition to correctness. A passing test suite or negative line count alone cannot waive this criterion; unexplained retained obsolete code or net growth is a rejection, not deferred cleanup.

Minimum meaningful evidence (not a Cartesian test matrix):
- Differential trace covering mention/reply/listen/ignore/bell/done/rejoin: maintained indices equal the frozen v1 replay oracle (test-only), including route precedence and roster order. Comparing the new transition to itself does not count as semantic evidence. One shared production transition, no SQL trigger policy.
- Sparse receipt scenario: earlier unseen hole, later filtered/exact catch, repeat exact catch no write, pre-rejoin catch versus post-rejoin notification, truthful remaining and cursor/behind/presence distinction. Filter before limit; history context uses existing activity positions.
- Two-process transaction race and short recovery tests: concurrent catches do not double-consume ordinary catch; atomic activity+audience; abort/rollback and commit-busy callback runs once. Existing native epoch/cancel/claim-before-send/after-send tests stay green; no stronger distributed guarantee claimed.
- Discovery scenario with hints disabled and push absent, including an early withheld candidate and a later eligible one; expiry alone re-enables the earlier candidate. Verify failed evidence does not busy-loop. Preserve Pi omitted notification behavior.
- Migration: one representative lossless legacy fixture including gaps/orphan receipts/case keys and optional fields; second run no-op; invalid input no writes; concurrent v1 writer/version gate; process death before commit rolls back. Use actual old artifact implementation or pinned installed binary for old-writer evidence, not v2 code pretending to be old.
- Capacity evidence: adapt existing scripts/benchmark-idle-wait.mjs rather than add a daemon or general benchmark framework. Permit 300 workers directly (no max-workers config). Same artifact, 300 independent processes and shared synthetic host ledger. Run idle, then active bell discovery with push absent/hints disabled, then simultaneous catches. Report actual readiness count, completions, revision/selected-row instrumentation with positive controls, hydrated rows/bytes, CPU, busy/commit duration, discovery latency and ledger work separately. Bound run and fail loudly on incomplete workers; do not silently lower count. Existing 20s discovery window is a probe deadline, not an SLA. Compare small/larger unrelated histories to establish no full-history hydration on recipient hot reads; SQL exact counts may still scan index entries. Update instrumentation: old square_snapshot regex otherwise falsely counts zero after v2. No capacity success claim before running on implemented code.
- Commands after implementation: npm test (already sandboxed); npm run test:cli-process; explicit benchmark via node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs. No live registry/session identities or native remote delivery during probes.

## Authority amendment accompanying runtime implementation

Replace AGENTS.md's whole-state requirement with: “Behavior operates on typed Square domain facts obtained through transaction-scoped reads and domain transitions. SQLite schema, SQL, and storage framing remain private to the artifact boundary. Partial fact reads must not masquerade as a complete SquareState.”

This is an explicit proposed amendment authorized by the requested boundary redesign, not an assertion that today's text already says it. The design document records it now; runtime implementation changes AGENTS.md with the boundary, not before.

## Binding plan

The current lead agent remains holder of both deliveries. Assign implementation hands independently from acceptance boundaries; the reviewer of a candidate must not be its deliverer. Use both `reviewed` and `verified` gates. Do not bind an aggregate storage-plus-migration contract.

**Runtime delivery Region:**
```text
square-*.ts
artifact.ts
ports.ts
model.ts
runtime.ts
decisions.ts
catch-decisions.ts
activity.ts
activity-feed.ts
perception-projection.ts
presentation.ts
presentation-operations.ts
boundary-presentation.ts
views.ts
delivery.ts
delivery-operations.ts
delivery-health.ts
notifications.ts
inbox.ts
routes.ts
wake-eligibility.ts
wakes.ts
watch.ts
stream.ts
claude-delivery.ts
claude-mod.ts
cli/**
plugins/opencode/**
test/**
scripts/benchmark-idle-wait.mjs
AGENTS.md
guides/row-storage-design.md
guides/change-waits.md
```
These are planning regions, not a requirement to edit every listed file. Host-ledger persistence and packages/agent-delivery transport internals are excluded. New private domain/artifact helper modules use the existing `square-` family; no generic query framework is introduced.

**Migration delivery Region:** `artifact.ts`, `square-storage.ts`, the new private migration module `square-migration.ts`, `square-state.ts` for isolated v1 validation, `model.ts`, `cli/maintenance-commands.ts`, `cli/registry.ts`, `cli/program.ts`, `help.ts`, `test/migration.test.js`, its `test/fixtures/**`, and migration documentation. Depends on the runtime delivery's v2 schema/codec/shared transition. Sharing files is coordination, not an extra dependency.

Verification declarations for both delivery snapshots include `npm test` and `npm run test:cli-process` (sandboxed by their scripts), with timeouts chosen from actual baseline duration rather than arbitrarily cutting off tests. Runtime evidence additionally runs the adapted benchmark:
```sh
node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 300 --mode session
node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 300 --mode session --active --no-hints
```
These commands are implemented by the runtime candidate; `--no-hints` and direct 300-worker support are benchmark capabilities. `--no-hints` disables fs.watch only inside benchmark workers, never through production configuration. Active session mode includes the simultaneous catch phase and comparison at 1,800 versus 18,000 unrelated history rows; preserve result/counter positive controls and report incomplete phases as failure. There is no new production performance knob. The baseline 20-second discovery deadline is retained as a finite probe bound, not a user-facing latency guarantee.

Independent design review found the architecture sound. Its concrete closure amendments are incorporated: no revision-driven pagination restart, retained follow-up/expiry obligations, explicit history audience-selector composition, domain ownership of pendingAudience, and refusal instead of a bespoke non-finite JSON codec. Design review is not implementation review, a test result, or a capacity result.
