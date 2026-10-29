import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

import { openExistingSquareDatabase } from './artifact.js';
import { inSqliteTransaction } from './sqlite-transaction.js';
import { canonicalPath, canonicalPathSync } from './canonical-path.js';
import { formatActivityId, isWakeRouteKind, nameKey, sameBody, validateBody, type Seat, type StoredAct, type WakeAddress } from './model.js';
import { parseActivityId } from './square-core.js';
import { readLegacyHostData, type LegacyDeliveryEvidence, type LegacyHostData } from './square-migration-host-ledger.js';
import { legacyRowFramingIssue, FORMAT4_ADDED_OBJECTS } from './square-legacy-framing.js';
import { APPLICATION_ID, ACTIVITIES_TABLE_SQL, ACTIVITY_INDEXES_SQL, CURRENT_USER_VERSION, V2_USER_VERSION, V3_USER_VERSION, V4_USER_VERSION, V5_USER_VERSION, SCHEMA_SQL, FORMAT4_SCHEMA_SQL, DELIVERY_DEFERRALS_SQL, SEAT_ATTACHMENT_SQL, validateRowFraming, inspectPreAttachmentSqlite, createSqliteDriver, invalidArtifact,
  validateStoredActivity,
  type SquareRuntimeState, type SquareState } from './square-sqlite.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validateRecord(value: unknown, item: (candidate: unknown) => boolean): value is Record<string, unknown> {
  return isObject(value) && Object.entries(value).every(([key, candidate]) => key.length > 0 && item(candidate));
}

function validateRuntime(value: unknown): value is SquareRuntimeState {
  return isObject(value) && hasExactKeys(value, ['nextActIndex', 'observations', 'leases'])
    && isNonNegativeInteger(value.nextActIndex)
    && validateRecord(value.observations, (candidate) => isObject(candidate)
      && Object.entries(candidate).every(([id, observation]) => parseActivityId(id) !== undefined && isObject(observation) && hasExactKeys(observation, ['state', 'at']) && observation.state === 'seen' && isFiniteNumber(observation.at)))
    && validateRecord(value.leases, (candidate) => {
      try { validateLegacyLease(candidate); return true; } catch { return false; }
    });
}

function validateAssignedRuntimeReferences(runtime: SquareRuntimeState): 'ok' | 'malformed' | 'future' {
  for (const observations of Object.values(runtime.observations)) {
    for (const id of Object.keys(observations)) {
      const index = parseActivityId(id);
      if (index === undefined) return 'malformed';
      if (index >= runtime.nextActIndex) return 'future';
    }
  }
  return 'ok';
}

function validateActs(value: unknown): value is StoredAct[] {
  if (!Array.isArray(value)) return false;
  let previous = -1;
  try {
    for (const candidate of value) {
      const act = validateStoredActivity(candidate);
      if (act.kind === 'unlisten' || act.index <= previous) return false;
      previous = act.index;
    }
  } catch { return false; }
  return true;
}

function nonFiniteRoutePath(value: unknown, path: string): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : path;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = nonFiniteRoutePath(value[index], `${path}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const found = nonFiniteRoutePath(item, `${path}.${key}`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Refuse exponent overflow with its legacy path before JSON could coerce it. */
function assertFiniteRouteNumbers(routes: readonly unknown[]): void {
  for (let index = 0; index < routes.length; index += 1) {
    const found = nonFiniteRoutePath(routes[index], `routes[${index}]`);
    if (found !== undefined) throw invalidArtifact(`${found} is not a finite number.`);
  }
}

/** Validate persisted v1 JSON; row codecs share activity and lease acceptance. */
export function validateSquareState(value: unknown): SquareState {
  if (isObject(value) && Array.isArray(value.routes)) assertFiniteRouteNumbers(value.routes);
  if (!isObject(value) || !hasExactKeys(value, ['hardCap', 'preamble', 'warmup', 'acts', 'runtime'], ['throttlePerMinute', 'routes'])
    || !(value.hardCap === null || (Number.isSafeInteger(value.hardCap) && (value.hardCap as number) > 0))
    || (value.throttlePerMinute !== undefined && (!Number.isSafeInteger(value.throttlePerMinute) || (value.throttlePerMinute as number) <= 0))
    || !isStringArray(value.preamble) || !isStringArray(value.warmup) || !validateActs(value.acts)
    || (value.routes !== undefined && (!Array.isArray(value.routes) || !value.routes.every((route) => isObject(route) && isWakeRouteKind(route.kind)
      && typeof route.location === 'string' && typeof route.participant === 'string' && typeof route.sessionId === 'string'
      && typeof route.channel === 'string' && isObject(route.address) && Object.values(route.address).every((item) => typeof item === 'string')
      && typeof route.updatedAt === 'number')))
    || !validateRuntime(value.runtime)) throw invalidArtifact('snapshot schema is malformed.');
  const historyBoundary = value.acts.at(-1)?.index ?? -1;
  if (value.runtime.nextActIndex <= historyBoundary) throw invalidArtifact('nextActIndex is behind the activity history.');
  const references = validateAssignedRuntimeReferences(value.runtime as SquareRuntimeState);
  if (references === 'malformed') throw invalidArtifact('snapshot schema is malformed.');
  if (references === 'future') throw invalidArtifact('runtime references an unassigned activity index.');
  return value as unknown as SquareState;
}

export interface MigrationCounts {
  readonly activities: number;
  readonly receipts: number;
  readonly leases: number;
  readonly routes: number;
  readonly recoveredSeats: number;
  readonly unownedStanding: number;
  readonly sharedBodySeats: number;
  readonly skippedEvidence: number;
}

export interface MigrationOutcome {
  readonly status: 'migrated' | 'already-current';
  /** Participants standing after the conversion, for the CLI header. */
  readonly standing: number;
  readonly counts?: MigrationCounts;
}

function identity(database: DatabaseSync): { applicationId: unknown; userVersion: unknown } {
  const row = database.prepare('SELECT application_id, user_version FROM pragma_application_id, pragma_user_version').get() as { application_id?: unknown; user_version?: unknown };
  return { applicationId: row.application_id, userVersion: row.user_version };
}

function standing(database: DatabaseSync): number {
  return createSqliteDriver(database).roster().filter((participant) => participant.joined).length;
}

const ACTIVITY_INDEX_NAMES = ['activity_kind_index', 'activity_actor_index', 'activity_say_actor_index', 'activity_say_time', 'activity_bell_actor_time'] as const;
function rebuildV2Activities(database: DatabaseSync): void {
  database.exec([
    ...ACTIVITY_INDEX_NAMES.map((name) => `DROP INDEX ${name};`),
    'ALTER TABLE activities RENAME TO activities_v2;',
    ACTIVITIES_TABLE_SQL,
    'INSERT INTO activities(act_index,at,kind,actor_json,actor_key_json,reach,reply_index,payload_json) SELECT act_index,at,kind,actor_json,actor_key_json,reach,reply_index,payload_json FROM activities_v2 ORDER BY act_index;',
    'DROP TABLE activities_v2;',
    ...ACTIVITY_INDEXES_SQL.map((sql) => `${sql};`),
  ].join('\n'));
}

function validateCurrentFraming(database: DatabaseSync, location: string): void {
  validateRowFraming(database, CURRENT_USER_VERSION, location);
  createSqliteDriver(database).header();
}

function assertSource(condition: unknown, detail = 'row is malformed.'): asserts condition {
  if (!condition) throw invalidArtifact(detail);
}
function parseJson(value: unknown, detail: string): unknown {
  assertSource(typeof value === 'string', detail);
  try { return JSON.parse(value as string) as unknown; }
  catch { throw invalidArtifact(detail); }
}
function decodeJsonString(value: unknown, nonempty = false): string {
  const parsed = parseJson(value, 'row contains invalid JSON.');
  assertSource(typeof parsed === 'string' && (!nonempty || parsed.length > 0) && JSON.stringify(parsed) === value, 'string encoding is malformed.');
  return parsed;
}
function sourceInteger(value: unknown, minimum = 0): number {
  assertSource(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum);
  return value as number;
}
function sourceFinite(value: unknown): number {
  assertSource(typeof value === 'number' && Number.isFinite(value));
  return value as number;
}
function sourceStringArray(value: unknown): string[] {
  const parsed = parseJson(value, 'header contains invalid JSON.');
  assertSource(Array.isArray(parsed) && parsed.every((item) => typeof item === 'string'));
  assertSource(JSON.stringify(parsed) === value, 'header string encoding is malformed.');
  return parsed as string[];
}
interface LegacyDelivery {
  readonly participant: string;
  readonly generation: Seat['generation'];
  readonly index: number;
  readonly kind: 'wake' | 'presentation';
  readonly attemptN: number;
  readonly outcome: 'dispatching' | 'accepted' | 'failed' | 'unknown' | 'released' | 'presented' | 'clipped';
  readonly at: number;
  readonly expiresAt?: number;
  readonly claimToken?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}
interface RowMigrationPlan {
  readonly standing: number;
  readonly seats: readonly Seat[];
  readonly deliveries: readonly LegacyDelivery[];
  readonly leaseGenerations: readonly { readonly ownerJson: string; readonly generation: Seat['generation'] }[];
  readonly sourceToken: string;
  readonly counts: MigrationCounts;
}
interface LegacyRoute {
  readonly location: string;
  readonly participant: string;
  readonly body: Seat['body'];
  readonly wakeAddress: WakeAddress;
}
function decodeLegacyRoute(row: Record<string, unknown>): LegacyRoute {
  assertSource(sourceInteger(row.position) >= 0);
  const parsed = parseJson(row.payload_json, 'route payload is malformed.');
  assertSource(isObject(parsed)
    && hasExactKeys(parsed, ['location', 'participant', 'channel', 'address', 'extra'], ['epoch']), 'route payload is malformed.');
  assertSource(typeof parsed.location === 'string' && typeof parsed.participant === 'string'
    && typeof parsed.channel === 'string' && isObject(parsed.address)
    && Object.values(parsed.address).every((value) => typeof value === 'string')
    && isObject(parsed.extra), 'route payload is malformed.');
  assertSource(isWakeRouteKind(row.kind), 'route kind is malformed.');
  const participant = parsed.participant;
  assertSource(row.participant_key_json === JSON.stringify(nameKey(participant)), 'route participant key is malformed.');
  const sessionId = decodeJsonString(row.session_json);
  sourceFinite(row.updated_at);
  const body = { channel: parsed.channel, session: sessionId, ...(parsed.extra.agent === undefined ? {} : { agent: parsed.extra.agent }) } as Seat['body'];
  validateBody(body);
  const address = parsed.address as Record<string, string>;
  if (row.kind === 'claude-native') assertSource(address.sessionId === undefined || address.sessionId === sessionId, 'native route session conflicts with its body.');
  return { location: parsed.location, participant, body,
    wakeAddress: { kind: row.kind, address: { ...address, ...(row.kind === 'claude-native' ? { sessionId } : {}) } } };
}
function validateLegacyLease(value: unknown): void {
  assertSource(isObject(value) && hasExactKeys(value, ['leaseId', 'heartbeatAt', 'expiresAt'], ['filter']), 'legacy lease is malformed.');
  assertSource(typeof value.leaseId === 'string' && value.leaseId.length > 0
    && typeof value.heartbeatAt === 'number' && Number.isFinite(value.heartbeatAt)
    && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
    && value.expiresAt >= value.heartbeatAt, 'legacy lease is malformed.');
  if (!Object.hasOwn(value, 'filter')) return;
  const filter = value.filter;
  assertSource(isObject(filter) && hasExactKeys(filter, [], ['participants', 'mention']), 'legacy lease filter is malformed.');
  assertSource((!Object.hasOwn(filter, 'participants') || Array.isArray(filter.participants) && filter.participants.every((item) => typeof item === 'string'))
    && (!Object.hasOwn(filter, 'mention') || typeof filter.mention === 'string'), 'legacy lease filter is malformed.');
}
function readLegacyRoutes(database: DatabaseSync): LegacyRoute[] {
  return (database.prepare('SELECT position,participant_key_json,session_json,kind,updated_at,payload_json FROM routes ORDER BY position').all() as Record<string, unknown>[])
    .map(decodeLegacyRoute);
}
function uniqueSeatAddress(routes: readonly LegacyRoute[]): WakeAddress | undefined {
  const addresses = new Map<string, WakeAddress>();
  for (const route of routes) {
    const entries = Object.entries(route.wakeAddress.address).sort(([left], [right]) => left.localeCompare(right));
    addresses.set(JSON.stringify([route.wakeAddress.kind, entries]), route.wakeAddress);
  }
  return addresses.size === 1 ? [...addresses.values()][0] : undefined;
}
function establishingJoin(driver: ReturnType<typeof createSqliteDriver>, participant: { name: string; lastJoinIndex?: number }): number {
  const join = driver.activityHeads({ actors: [participant.name], kinds: ['join'] }, { edge: 'newest', limit: 1 }).items[0];
  assertSource(join?.kind === 'join' && join.index === participant.lastJoinIndex, `participant ${participant.name} has no verifiable establishing join.`);
  return join.index;
}
function planSeats(
  location: string,
  roster: ReturnType<ReturnType<typeof createSqliteDriver>['roster']>,
  routes: readonly LegacyRoute[],
  owners: LegacyHostData['owners'],
  driver: ReturnType<typeof createSqliteDriver>,
): Seat[] {
  const seats: Seat[] = [];
  const localRoutes = routes.filter(route => canonicalPathSync(route.location) === location);
  for (const participant of roster.filter((participant) => participant.joined)) {
    const joined = establishingJoin(driver, participant);
    const candidates = localRoutes.filter((route) => nameKey(route.participant) === nameKey(participant.name));
    const owner = owners.find(row => nameKey(row.participant) === nameKey(participant.name));
    const body = owner?.body ?? candidates[0]?.body;
    if (body === undefined || !candidates.every(route => sameBody(route.body, body))) continue;
    const address = uniqueSeatAddress(candidates);
    seats.push({
      participant: participant.name,
      body,
      generation: formatActivityId(joined),
      attachment: 'attached',
      ...(address === undefined ? {} : { wakeAddress: address }),
    });
  }
  return seats;
}
function tableToken(database: DatabaseSync, table: string, order: string): string {
  const rows = database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Record<string, unknown>[];
  return JSON.stringify(rows.map((row) => Object.entries(row).sort(([left], [right]) => left.localeCompare(right))));
}
function legacySourceToken(database: DatabaseSync): string {
  return JSON.stringify([
    ['square_meta', tableToken(database, 'square_meta', 'id')],
    ['activities', tableToken(database, 'activities', 'act_index')],
    ['participants', tableToken(database, 'participants', 'name_key_json')],
    ['attention', tableToken(database, 'attention', 'listener_key_json,target_key_json')],
    ['landed_audience', tableToken(database, 'landed_audience', 'act_index,recipient_order')],
    ['receipts', tableToken(database, 'receipts', 'owner_json,act_index')],
    ['catch_leases', tableToken(database, 'catch_leases', 'owner_json')],
    ['routes', tableToken(database, 'routes', 'position')],
  ]);
}

function inspectLegacyRowArtifact(database: DatabaseSync, location: string, host: LegacyHostData): RowMigrationPlan {
  const metaRows = database.prepare('SELECT * FROM square_meta').all() as Record<string, unknown>[];
  assertSource(metaRows.length === 1 && metaRows[0].id === 1, 'header row is malformed.');
  const meta = metaRows[0];
  sourceInteger(meta.revision);
  const nextActIndex = sourceInteger(meta.next_act_index);
  assertSource(meta.hard_cap === null || (typeof meta.hard_cap === 'number' && Number.isSafeInteger(meta.hard_cap) && meta.hard_cap > 0), 'header row is malformed.');
  assertSource(meta.throttle_per_minute === null || (typeof meta.throttle_per_minute === 'number' && Number.isSafeInteger(meta.throttle_per_minute) && meta.throttle_per_minute > 0), 'header row is malformed.');
  sourceStringArray(meta.preamble_json);
  sourceStringArray(meta.warmup_json);

  const driver = createSqliteDriver(database);
  let activityCount = 0;
  let previous = -1;
  for (const row of database.prepare('SELECT act_index FROM activities ORDER BY act_index').iterate() as Iterable<Record<string, unknown>>) {
    const index = sourceInteger(row.act_index);
    assertSource(index > previous && index < nextActIndex, 'activity index is malformed or unassigned.');
    const activity = driver.activity(index);
    assertSource(activity !== undefined);
    validateStoredActivity(activity);
    activityCount++;
    previous = index;
  }
  assertSource(nextActIndex > previous, 'nextActIndex is behind the activity history.');
  const roster = driver.roster();
  const routes = readLegacyRoutes(database);
  for (const row of database.prepare('SELECT owner_json,act_index,at FROM receipts').iterate() as Iterable<Record<string, unknown>>) {
    decodeJsonString(row.owner_json, true);
    assertSource(sourceInteger(row.act_index) < nextActIndex, 'receipt references an unassigned activity index.');
    sourceFinite(row.at);
  }
  const leaseGenerations: Array<{ ownerJson: string; generation: Seat['generation'] }> = [];
  const leaseOwners: string[] = [];
  for (const row of database.prepare('SELECT owner_json,lease_id_json,heartbeat_at,expires_at,filter_json FROM catch_leases').iterate() as Iterable<Record<string, unknown>>) {
    const owner = decodeJsonString(row.owner_json, true);
    leaseOwners.push(row.owner_json as string);
    const leaseId = decodeJsonString(row.lease_id_json, true);
    const lease = {
      leaseId,
      heartbeatAt: sourceFinite(row.heartbeat_at),
      expiresAt: sourceFinite(row.expires_at),
      ...(row.filter_json === null ? {} : { filter: parseJson(row.filter_json, 'lease filter is malformed.') }),
    };
    validateLegacyLease(lease);
    const ownerParticipant = roster.find((participant) => participant.joined && participant.name === owner);
    if (ownerParticipant?.lastJoinIndex !== undefined) leaseGenerations.push({ ownerJson: row.owner_json as string, generation: formatActivityId(ownerParticipant.lastJoinIndex) });
  }
  const seats = planSeats(location, roster, routes, host.owners, driver);
  const standingCount = roster.filter(participant => participant.joined).length;
  const deliveries = planLegacyDeliveries(host.evidence, seats, driver);
  const counts: MigrationCounts = {
    activities: activityCount,
    receipts: Number((database.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n),
    leases: leaseOwners.length,
    routes: routes.length,
    recoveredSeats: seats.length,
    unownedStanding: standingCount - seats.length,
    sharedBodySeats: seats.filter(seat => seats.some(other => other !== seat && sameBody(other.body, seat.body))).length,
    skippedEvidence: host.evidence.length - deliveries.length,
  };
  const sourceToken = legacySourceToken(database);
  return { standing: standingCount, seats, leaseGenerations, sourceToken, counts, deliveries };
}
function legacyPayloadHash(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

function legacyDeliveryPayload(source: LegacyDeliveryEvidence, current?: WakeAddress): Readonly<Record<string, unknown>> {
  const native = source.nativeDelivery;
  if (native === undefined) return {};
  assertSource(isObject(native) && typeof native.payload === 'string' && native.payload.length > 0, 'native delivery correlation is malformed.');
  if (native.harness === 'claude') {
    assertSource(typeof source.claimToken === 'string' && /^[a-zA-Z0-9-]+$/.test(source.claimToken)
      && typeof native.endpoint === 'string' && native.endpoint.length > 0
      && (native.messageId === undefined || typeof native.messageId === 'string' && native.messageId.length > 0), 'Claude native correlation is malformed.');
    const address = current?.kind === 'claude-native' && current.address.endpoint === native.endpoint
      ? current.address : { endpoint: native.endpoint, loaded: 'true' };
    return { correlation: { harness: 'claude', token: source.claimToken,
      ...(native.messageId === undefined ? {} : { messageId: native.messageId }), payloadHash: legacyPayloadHash(native.payload) },
      route: { kind: 'claude-native', address: { ...address, sessionId: source.session } } };
  }
  assertSource(native.harness === 'opencode' && typeof native.inputId === 'string' && native.inputId.length > 0, 'OpenCode native correlation is malformed.');
  return { correlation: { harness: 'opencode', token: native.inputId, payloadHash: legacyPayloadHash(native.payload) },
    route: current?.kind === 'opencode-server' && current.address.sessionId === source.session
      ? current : { kind: 'opencode-server', address: { sessionId: source.session } } };
}

function planLegacyDeliveries(records: readonly LegacyDeliveryEvidence[], seats: readonly Seat[], driver: ReturnType<typeof createSqliteDriver>): LegacyDelivery[] {
  const byGroup = new Map<string, Array<Omit<LegacyDelivery, 'attemptN'> & { readonly attemptN?: number }>>();
  const completedBodies = new Map<string, string | null>();
  for (const source of records) {
    // Validate structure even when no surviving owner can accept this row.
    assertSource(source.kind === 'wake' || source.kind === 'presentation', 'delivery evidence kind is unsupported.');
    assertSource(['dispatching', 'accepted', 'failed', 'unknown', 'released', 'presented', 'clipped'].includes(source.outcome), 'delivery evidence outcome is unsupported.');
    assertSource(source.session.length > 0
      && (source.channel === undefined || typeof source.channel === 'string' && source.channel.length > 0)
      && (source.agent === undefined || typeof source.agent === 'string' && source.agent.length > 0), 'delivery evidence body is malformed.');
    const index = parseActivityId(source.activity);
    assertSource(index !== undefined, 'delivery evidence activity id is malformed.');
    const at = sourceFinite(source.at);
    const expiresAt = source.expiresAt === undefined ? undefined : sourceFinite(source.expiresAt);
    const claimToken = source.claimToken;
    assertSource(claimToken === undefined || typeof claimToken === 'string' && claimToken.length > 0, 'delivery claim token is malformed.');
    assertSource(source.attemptN === undefined || Number.isSafeInteger(source.attemptN) && source.attemptN >= 0, 'delivery attempt number is malformed.');
    const participant = driver.participant(source.participant);
    const seat = seats.find(seat => nameKey(seat.participant) === nameKey(source.participant));
    const payload = legacyDeliveryPayload(source, seat?.wakeAddress);
    const native = source.kind === 'wake' && source.nativeDelivery !== undefined;
    if (!participant?.joined && !(participant?.done && native)) continue;
    if (participant.joined && (seat === undefined || seat.body.session !== source.session
      || source.agent !== seat.body.agent || source.channel !== undefined && source.channel !== seat.body.channel)) continue;
    const harness = (source.nativeDelivery as Record<string, unknown> | undefined)?.harness;
    if (native && seat !== undefined && harness !==
      (seat.body.channel === 'claude-code' ? 'claude' : seat.body.channel === 'opencode' ? 'opencode' : undefined)) continue;
    const joined = establishingJoin(driver, participant);
    const generation = formatActivityId(joined);
    if (index <= joined || driver.activity(index)?.kind !== 'say' || driver.directedAt(participant.name, index) === undefined) continue;
    if (participant.done) {
      const done = driver.activityHeads({ actors: [participant.name], kinds: ['done'] }, { edge: 'newest', limit: 1 }).items[0];
      if (done === undefined || index >= done.index) continue;
      const body = { channel: harness === 'claude' ? 'claude-code' : 'opencode', session: source.session,
        ...(source.agent === undefined ? {} : { agent: source.agent }) } as Seat['body'];
      if (source.channel !== undefined && source.channel !== body.channel) continue;
      const coordinate = JSON.stringify([body.channel, body.session, body.agent]);
      const key = nameKey(participant.name), previous = completedBodies.get(key);
      completedBodies.set(key, previous === undefined || previous === coordinate ? coordinate : null);
    }
    const group = JSON.stringify([nameKey(participant.name), generation, index, source.kind]);
    const row = {
      participant: participant.name,
      generation,
      index,
      kind: source.kind,
      outcome: source.outcome as LegacyDelivery['outcome'],
      at,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(claimToken === undefined ? {} : { claimToken }),
      payload,
      ...(source.attemptN === undefined ? {} : { attemptN: source.attemptN }),
    };
    const rows = byGroup.get(group) ?? [];
    rows.push(row);
    byGroup.set(group, rows);
  }
  const deliveries: LegacyDelivery[] = [];
  for (const rows of byGroup.values()) {
    if (completedBodies.get(nameKey(rows[0].participant)) === null) continue;
    const explicit = rows.flatMap(row => row.attemptN === undefined ? [] : [row.attemptN]);
    if (new Set(explicit).size !== explicit.length || explicit.length !== rows.length && rows.length !== 1) continue;
    rows.forEach((row, index) => deliveries.push({ ...row, attemptN: explicit.length === 0 ? 0 : explicit[index] as number }));
  }
  const tokens = new Map<string, number>();
  for (const row of deliveries) {
    if (row.claimToken !== undefined) tokens.set(row.claimToken, (tokens.get(row.claimToken) ?? 0) + 1);
  }
  return deliveries.filter(row => row.claimToken === undefined || tokens.get(row.claimToken) === 1);
}

const V4_REBUILT_TABLES = ['square_meta', 'catch_leases'] as const;
function tableDefinition(name: typeof V4_REBUILT_TABLES[number]): string {
  const definition = SCHEMA_SQL.split(';').map((statement) => statement.trim()).find((statement) => statement.startsWith(`CREATE TABLE ${name} (`));
  if (definition === undefined) throw new Error(`Missing current table definition for ${name}.`);
  return `${definition};`;
}
function currentAdditionStatements(): string[] {
  return SCHEMA_SQL.split(';').map((statement) => statement.trim()).filter((statement) => {
    const match = /^(?:CREATE (?:UNIQUE )?TABLE|CREATE (?:UNIQUE )?INDEX)\s+([a-z_]+)/i.exec(statement);
    return match !== null && FORMAT4_ADDED_OBJECTS.has(match[1]);
  }).map((statement) => `${statement};`);
}
function importOwnershipAndEvidence(database: DatabaseSync, plan: RowMigrationPlan): void {
  for (const generation of plan.leaseGenerations) {
    database.prepare('UPDATE catch_leases SET generation_json=? WHERE owner_json=?').run(JSON.stringify(generation.generation), generation.ownerJson);
  }
  const insertSeat = database.prepare('INSERT INTO seats(participant_key_json,participant_json,channel_json,session_json,agent_json,generation_json,wake_address_json) VALUES(?,?,?,?,?,?,?)');
  for (const seat of plan.seats) {
    insertSeat.run(JSON.stringify(nameKey(seat.participant)), JSON.stringify(seat.participant), JSON.stringify(seat.body.channel), JSON.stringify(seat.body.session), seat.body.agent === undefined ? null : JSON.stringify(seat.body.agent), JSON.stringify(seat.generation), seat.wakeAddress === undefined ? null : JSON.stringify(seat.wakeAddress));
  }
  const insertDelivery = database.prepare('INSERT INTO delivery_evidence(participant_key_json,participant_json,generation_json,act_index,kind,attempt_n,outcome,at,expires_at,claim_token_json,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  for (const evidence of plan.deliveries) {
    insertDelivery.run(JSON.stringify(nameKey(evidence.participant)), JSON.stringify(evidence.participant), JSON.stringify(evidence.generation), evidence.index, evidence.kind, evidence.attemptN, evidence.outcome, evidence.at, evidence.expiresAt ?? null, evidence.claimToken === undefined ? null : JSON.stringify(evidence.claimToken), JSON.stringify(evidence.payload));
  }
}
function upgradeRowArtifact(database: DatabaseSync, location: string, plan: RowMigrationPlan): void {
  database.exec('ALTER TABLE square_meta RENAME TO square_meta_v3;');
  database.exec(tableDefinition('square_meta'));
  database.exec('INSERT INTO square_meta(id,revision,delivery_revision,next_act_index,hard_cap,throttle_per_minute,preamble_json,warmup_json) SELECT id,revision,0,next_act_index,hard_cap,throttle_per_minute,preamble_json,warmup_json FROM square_meta_v3;');
  database.exec('DROP TABLE square_meta_v3;');

  database.exec('ALTER TABLE catch_leases RENAME TO catch_leases_v3;');
  database.exec(tableDefinition('catch_leases'));
  database.exec('INSERT INTO catch_leases(owner_json,generation_json,lease_id_json,heartbeat_at,expires_at,filter_json) SELECT owner_json, \'""\', lease_id_json,heartbeat_at,expires_at,filter_json FROM catch_leases_v3;');
  database.exec('DROP TABLE catch_leases_v3;');
  currentAdditionStatements().forEach((statement) => database.exec(statement));
  importOwnershipAndEvidence(database, plan);
  database.exec('DROP TABLE routes;');
  database.exec(DELIVERY_DEFERRALS_SQL);
  database.exec(`PRAGMA user_version = ${CURRENT_USER_VERSION};`);
  validateCurrentFraming(database, location);
}

function validateMigrationSource(database: DatabaseSync, location: string): 2 | 3 | 4 | 5 | undefined {
  const before = identity(database);
  if (before.applicationId !== APPLICATION_ID) throw invalidArtifact('unrelated SQLite database.');
  if (before.userVersion === V2_USER_VERSION || before.userVersion === V3_USER_VERSION) {
    const issue = legacyRowFramingIssue(database, APPLICATION_ID, before.userVersion, location, FORMAT4_SCHEMA_SQL);
    if (issue !== undefined) throw invalidArtifact(issue);
    return before.userVersion;
  }
  if (before.userVersion === V4_USER_VERSION || before.userVersion === V5_USER_VERSION) {
    validateRowFraming(database, before.userVersion, location);
    inspectPreAttachmentSqlite(database);
    return before.userVersion;
  }
  if (before.userVersion === CURRENT_USER_VERSION) {
    validateCurrentFraming(database, location);
    return undefined;
  }
  throw invalidArtifact('unsupported SQLite format version.');
}

/**
 * Explicit conversion of the supported legacy formats. Row-backed versions 2 and 3 are
 * preflighted read-only, then receive ownership/evidence and deferral storage in one
 * format-6 transaction. Formats 4/5 gain attachment; format 4 also gains empty deferrals.
 * Legacy delivery evidence is copied from HostLedger only when its owner/session mapping is
 * unique; no source record is retired. Version 1 is not a supported source for this format transition.
 */
export async function migrateSquareFile(location: string, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<MigrationOutcome> {
  const squarePath = await canonicalPath(location);
  const database = openExistingSquareDatabase(squarePath);
  try {
    const source = await inSqliteTransaction(database, false, () => validateMigrationSource(database, squarePath), value => value, signal);
    if (source === undefined) return { status: 'already-current', standing: standing(database) };
    if (source === V4_USER_VERSION || source === V5_USER_VERSION) {
      return await inSqliteTransaction(database, true, () => {
        assertSource(validateMigrationSource(database, squarePath) === source, 'source format changed during migration preflight.');
      }, () => {
        if (source === V4_USER_VERSION) database.exec(DELIVERY_DEFERRALS_SQL);
        database.exec(SEAT_ATTACHMENT_SQL);
        database.exec(`PRAGMA user_version = ${CURRENT_USER_VERSION};`);
        validateCurrentFraming(database, squarePath);
        return { status: 'migrated' as const, standing: standing(database) };
      }, signal);
    }
    const host = await readLegacyHostData(squarePath, env, signal);
    const plan = await inSqliteTransaction(database, false, () => {
      assertSource(validateMigrationSource(database, squarePath) === source, 'source format changed during migration preflight.');
      return inspectLegacyRowArtifact(database, squarePath, host);
    }, value => value, signal);

    database.exec('PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL');
    const result: { outcome?: MigrationOutcome; plan?: RowMigrationPlan } = {};
    await inSqliteTransaction(database, true, () => {
      assertSource(validateMigrationSource(database, squarePath) === source, 'source format changed during migration preflight.');
      // Resolve the same frozen host input again against the locked artifact before any DDL.
      const lockedPlan = inspectLegacyRowArtifact(database, squarePath, host);
      assertSource(lockedPlan.sourceToken === plan.sourceToken, 'source changed during migration preflight.');
      result.plan = lockedPlan;
    }, () => {
      if (source === 2) rebuildV2Activities(database);
      const migratedPlan = result.plan!;
      upgradeRowArtifact(database, squarePath, migratedPlan);
      result.outcome = { status: 'migrated', standing: migratedPlan.standing, counts: migratedPlan.counts };
    }, signal);
    return result.outcome!;
  } finally {
    database.close();
  }
}
