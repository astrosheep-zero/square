import type { SquareBackends } from './square-backend.js';
import type { ActivityId, Perception, Reach } from './square-core.js';
import type { Body, StoredAct, WakeAddress, ActivityMetadata, JsonValue } from './model.js';
import type { WakeTransportPort, DeliveryResult, SquareResourceOwner } from './ports.js';

export type { ActivityId, Perception, Reach } from './square-core.js';
export type { Body, WakeAddress, ActivityMetadata, JsonValue } from './model.js';
/** Indexed archive event, including read and historical actorless lifecycle records. */
export type ArchiveRecord = Readonly<StoredAct>;
export interface Activity {
  readonly id: ActivityId;
  readonly at: number;
  readonly kind: 'join' | 'say' | 'done' | 'hold' | 'resume' | 'listen' | 'ignore' | 'unlisten';
  readonly actor: string;
  readonly body?: string;
  readonly metadata?: ActivityMetadata;
  readonly mentions: readonly string[];
  readonly reach?: Reach;
  readonly target?: string;
  readonly reply?: ActivityId;
}
export interface PerceivedActivity extends Activity {
  readonly perception: Perception;
}
/** Request extra facts for rendering, without changing operation semantics. */
export interface ObservationOptions {
  readonly observe?: boolean;
}
export interface ExpressOptions extends ObservationOptions {
  readonly metadata?: ActivityMetadata;
  readonly force?: boolean;
  readonly mentions?: readonly string[];
  readonly reach?: Reach;
  readonly reply?: ActivityId;
  readonly noMention?: boolean;
  readonly noWait?: boolean;
}
export interface ExpressInput extends ExpressOptions {
  readonly body?: string;
}
export interface ActivityResult {
  readonly activity: Activity;
  readonly delivery?: DeliveryResult;
}
export interface ExpressResult extends ActivityResult {
  readonly waited: boolean;
  /** The replied-to author was not standing when the reply landed. */
  readonly replyAuthorNotHere?: string;
  /** Body @name tokens with no standing match at landing; never stored on the activity. */
  readonly unmatchedMentions?: readonly string[];
  /** Occasional participant-facing nudge; not part of the activity. */
  readonly hint?: string;
  readonly observation?: ExpressObservation;
}
export interface ListenerChangeResult {
  readonly activity: Activity | null;
  readonly observation?: ListenerObservation;
}
export interface ListeningResult {
  readonly listening: readonly string[];
  readonly observation?: SquareObservation;
}
export interface LifecycleResult extends ActivityResult {
  readonly observation?: LifecycleObservation;
}
export interface CatchOptions extends ObservationOptions {
  readonly id?: ActivityId;
  readonly idle?: number;
  readonly from?: readonly string[];
  readonly mention?: boolean;
  readonly limit?: number;
  readonly replace?: boolean;
}
export interface CatchResult {
  readonly activities: readonly PerceivedActivity[];
  readonly consumedThrough: ActivityId | null;
  readonly idleExpired: boolean;
  readonly remaining: number;
  readonly status?: CatchTerminalStatus;
  /** Occasional participant-facing nudge; not part of any activity. */
  readonly hint?: string;
  readonly observation?: CatchObservation;
}
export interface CatchWaitStart {
  readonly idleMs: number;
  readonly replacementRequested: boolean;
  readonly replaced: boolean;
}
export type OperationProgress =
  | {
      readonly kind: 'waiting';
      readonly reason: 'held' | 'throttled';
      readonly delayMs?: number;
      readonly holder?: string;
      readonly holdReason?: string;
    }
  | ({ readonly kind: 'catch-started'; readonly participant: string } & CatchWaitStart);
export interface OperationControl {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: OperationProgress) => void;
}
export interface OperationFailureDetail {
  readonly operation: 'express' | 'join' | 'catch' | 'history' | 'other';
  readonly subject?: 'caller' | 'filter' | 'recipient';
  readonly participant?: string;
  readonly expressEffect?: 'unsent' | 'landed' | 'unknown';
  readonly landedId?: ActivityId;
  readonly historyBounds?: { readonly maxLimit: number; readonly totalMatches: number };
}
export interface OperationError extends Error {
  readonly operation?: OperationFailureDetail;
}
export interface HistoryQuery extends ObservationOptions {
  /** Ten by default; null explicitly reads the full archive. */
  readonly limit?: number | null;
  readonly order?: 'asc' | 'desc';
  readonly before?: ActivityId;
  readonly after?: ActivityId;
  readonly grep?: string;
  readonly fixed?: string;
  readonly from?: readonly string[];
  readonly mention?: string;
  readonly since?: number;
  readonly at?: readonly ActivityId[];
  readonly contextBefore?: number;
  readonly contextAfter?: number;
}
export interface HistoryResult {
  readonly activities: readonly Activity[];
  readonly observation?: HistoryObservation;
}
export interface ParticipantStatus {
  readonly name: string;
  readonly state: 'joined' | 'done';
  readonly consumedThrough: ActivityId | null;
  readonly watching: boolean;
  readonly listening: readonly string[];
}
export interface SquareSnapshot {
  readonly context: string;
  readonly actCount: number;
  readonly hardCap: number | null;
  readonly throttlePerMinute?: number;
  readonly held: { readonly by: string; readonly reason?: string } | null;
  readonly participants: readonly ParticipantStatus[];
  delivered(name: string, id: ActivityId): boolean;
}

export interface OpenOptions {
  readonly clock?: () => number;
  readonly wakeTransport?: WakeTransportPort;
  /** Explicit execution coordinate resolved by an adapter. */
  readonly body?: Body;
  /** Optional wake address attached to this body. */
  readonly wakeAddress?: WakeAddress;
}
export interface SquareLocation {
  readonly path?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}
export interface SquareAtInput extends SquareLocation, OpenOptions {
  readonly backends?: SquareBackends;
  readonly participant?: string;
  /** A caller-owned connection; closing this Square never closes its owner. */
  readonly resources?: SquareResourceOwner;
}
export interface SquareBuildInput extends SquareAtInput {
  readonly markdown: string;
  readonly hardCap?: number | null;
  readonly throttlePerMinute?: number;
  readonly template?: string;
  readonly force?: boolean;
}
export interface JoinOptions extends ObservationOptions {
  readonly takeover?: boolean;
  readonly last?: number;
}
export interface JoinResult {
  readonly participant: Participant;
  readonly activity: Activity | null;
  readonly kind: 'joined' | 'reconnected' | 'taken-over';
  /** Known joined-or-done participants, not the current standing count. */
  readonly participantCount: number;
  readonly observation?: JoinObservation;
}
export interface Participant {
  readonly name: string;
  express(body: string | undefined, options?: ExpressOptions, control?: OperationControl): Promise<ExpressResult>;
  express(input: ExpressInput, control?: OperationControl): Promise<ExpressResult>;
  listen(target: string, options?: ObservationOptions, control?: OperationControl): Promise<ListenerChangeResult>;
  ignore(target: string, options?: ObservationOptions, control?: OperationControl): Promise<ListenerChangeResult>;
  unlisten(target: string, options?: ObservationOptions, control?: OperationControl): Promise<ListenerChangeResult>;
  listening(options?: ObservationOptions, control?: OperationControl): Promise<ListeningResult>;
  catch(options?: CatchOptions, control?: OperationControl): Promise<CatchResult>;
  history(query?: HistoryQuery, control?: OperationControl): Promise<HistoryResult>;
  hold(reason?: string, options?: ObservationOptions, control?: OperationControl): Promise<LifecycleResult>;
  resume(options?: ObservationOptions, control?: OperationControl): Promise<LifecycleResult>;
  /** Leave without a message. Only an omitted or empty body is accepted. */
  done(body?: string, options?: ObservationOptions, control?: OperationControl): Promise<LifecycleResult>;
}
export type CatchTerminalStatus = 'already-active' | 'replaced' | 'capped' | 'quorum';
export type CatchStopStatus = CatchTerminalStatus | 'empty-now' | 'stale';
export type ParticipantPresence = 'never-joined' | 'active' | 'watching' | 'done';
export interface ParticipantSummary {
  readonly name: string;
  readonly state: 'active' | 'done' | 'not joined';
  readonly listening: readonly string[];
  readonly activityCount: number;
  readonly lastActiveAt?: number;
  readonly presence: ParticipantPresence;
  readonly unreadActivityCount: number;
  readonly pendingMentionCount: number;
}
export interface StatusOptions extends ObservationOptions {
  readonly viewer?: string;
}
export interface StatusResult {
  readonly hardCap: number | null;
  readonly activeCount: number;
  readonly doneCount: number;
  readonly participants: readonly ParticipantSummary[];
  readonly now: number;
  readonly throttlePerMinute?: number;
  readonly hold: { readonly by?: string; readonly reason?: string; readonly at?: number } | null;
  readonly latestActivity?: Activity;
  readonly observation?: StatusObservation;
}
export interface ParticipantsResult {
  readonly participants: readonly ParticipantSummary[];
  readonly observation?: ParticipantsObservation;
}
export interface DiscoveryOptions {
  readonly depth?: number;
  readonly limit?: number;
  readonly after?: string;
}
export interface SquareListItem {
  readonly path: string;
  readonly lastActiveAt: number;
  readonly context: readonly string[];
  readonly participants: readonly string[];
  readonly activities: number;
}
export interface DiscoveryResult {
  readonly items: readonly SquareListItem[];
  readonly stopped: boolean;
  readonly total: number;
  readonly remaining: number;
  readonly next?: string;
}
export interface InboxOptions {
  readonly limit?: number;
}
export interface InboxMembershipSummary {
  readonly name: string;
  readonly squarePath: string;
  readonly pending: number;
}
export interface InboxResult {
  readonly rows: readonly InboxMembershipSummary[];
  readonly total: number;
}
export interface RecoveryResult {
  readonly participant?: string;
  readonly standingCount?: number;
  readonly held?: boolean;
  readonly holdReason?: string;
  readonly ownActivityCount?: number;
  readonly hardCap?: number | null;
  readonly roster?: readonly string[];
  readonly activitySummaries?: readonly UnreadActivitySummary[];
}
export type StreamStart =
  | { readonly kind: 'tail'; readonly last: number }
  | { readonly kind: 'after'; readonly after: number };
export interface StreamOptions {
  readonly recipient?: string;
  readonly start?: StreamStart;
}
export type StreamRecord = ArchiveRecord & { readonly seq: number; readonly square: string; readonly route?: string };

export interface UnreadActivityPreview {
  readonly number: number;
  readonly act: Extract<ArchiveRecord, { kind: 'say' }>;
  readonly perception: Perception;
}
export interface UnreadActivitySummary {
  readonly name: string;
  readonly count: number;
  readonly latestActivityAgeMs: number;
  readonly previews: readonly UnreadActivityPreview[];
}
export interface EntryPresentation {
  readonly joinedBefore: boolean;
  readonly scene: string;
  readonly joinContext: string;
  readonly recentActivities: readonly ArchiveRecord[];
  readonly perceptions: Readonly<Record<number, Perception>>;
  readonly sayNumbers: Readonly<Record<number, number>>;
}
export interface ListPresentation {
  readonly context: readonly string[];
  readonly participants: readonly string[];
  readonly activities: number;
}
export interface PresenceClassification {
  readonly orderedHereNames: readonly string[];
  readonly lingeringCount: number;
  readonly classificationByName: Readonly<Record<string, 'here' | 'lingering' | 'done' | 'not-joined'>>;
}
export interface CatchPresence {
  readonly participants: readonly ParticipantSummary[];
  readonly now: number;
}
export interface StreamProjection {
  readonly activities: readonly { readonly activity: ArchiveRecord; readonly route?: string }[];
  readonly cursor: number;
  readonly hasMore: boolean;
}
export interface SquareObservation {
  readonly location: string;
  readonly standingCount: number;
  readonly held: boolean;
  readonly now: number;
  readonly participant?: string;
  readonly automaticDeliveryAvailable: boolean;
}
export interface JoinObservation extends SquareObservation {
  readonly entry?: EntryPresentation;
  /** The receipt succeeded, but optional recent-history/context enrichment was unavailable. */
  readonly enrichmentUnavailable?: true;
}
export interface ExpressionObservation extends Pick<SquareObservation, 'standingCount' | 'held' | 'now'> {
  readonly ownActivityCount: number;
  readonly hardCap: number | null;
}
export interface ExpressObservation extends SquareObservation, ExpressionObservation {
  readonly participant: string;
  readonly pendingPublic: readonly ArchiveRecord[];
  readonly sayNumbers: Readonly<Record<number, number>>;
  readonly perceptions: Readonly<Record<number, Perception>>;
}
export interface CatchObservation extends SquareObservation, ExpressionObservation {
  readonly participant: string;
  readonly sayNumbers: Readonly<Record<number, number>>;
  readonly presence?: CatchPresence;
  readonly stop?: CatchStopStatus;
  readonly waitStarted?: boolean;
  readonly replaced?: boolean;
  readonly enrichmentUnavailable?: true;
}
export interface HistoryContinuation {
  readonly direction: 'before' | 'after';
  readonly cursor: ActivityId;
  readonly limit: number;
}
export interface HistoryObservation extends SquareObservation {
  readonly activities: readonly ArchiveRecord[];
  readonly sayNumbers: Readonly<Record<number, number>>;
  readonly presenceAnchors: Readonly<Record<number, readonly string[]>>;
  readonly totalMatches: number;
  readonly visibleActivities: readonly ArchiveRecord[];
  readonly continuation?: HistoryContinuation;
}
export interface ListenerObservation extends SquareObservation {
  readonly participant: string;
  readonly target: string;
  readonly requestedTarget: string;
}
export interface LifecycleObservation extends SquareObservation {
  readonly activity: ArchiveRecord;
}
export interface StatusObservation extends SquareObservation, PresenceClassification {
  readonly knownParticipantCount: number;
  readonly latestActNumber?: number;
  readonly latestPerception?: Perception;
  readonly joins: readonly { readonly activity: ArchiveRecord; readonly rejoined: boolean }[];
  readonly joinCount: number;
  readonly attentionNames: readonly string[];
  readonly viewer: string;
}
export interface ParticipantsObservation extends SquareObservation, PresenceClassification {}
