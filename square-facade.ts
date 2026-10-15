import type { ActivityId, Perception, Reach } from './square-core.js';
import type { StoredAct } from './model.js';
import type { HostLedgerPort, WakeTransportPort, DeliveryResult } from './ports.js';
import type { DiagnoseResult } from './artifact.js';
import type { MigrationOutcome } from './square-migration.js';

export type { ActivityId, Perception, Reach } from './square-core.js';
/** The existing indexed domain event, including read and historical actorless lifecycle records. */
export type ArchiveRecord = Readonly<StoredAct>;
export interface Activity { readonly id: ActivityId; readonly at: number; readonly kind: 'join' | 'say' | 'done' | 'hold' | 'resume' | 'listen' | 'ignore'; readonly actor: string; readonly body?: string; readonly mentions: readonly string[]; readonly reach?: Reach; readonly target?: string; readonly reply?: ActivityId; }
export interface PerceivedActivity extends Activity { readonly perception: Perception; }
export interface ExpressOptions { readonly force?: boolean; readonly mentions?: readonly string[]; readonly reach?: Reach; readonly reply?: ActivityId; readonly noMention?: boolean; }
export interface ExpressResult {
  readonly activity: Activity;
  readonly delivery?: DeliveryResult;
  /** The replied-to author was not standing when the reply landed. */
  readonly replyAuthorNotHere?: string;
}
export interface ListenerChangeData { readonly activity: Activity | null; }
export type ListenerChangeResult = ListenerChangeData;
export interface CatchOptions { readonly id?: ActivityId; readonly idle?: number; readonly from?: readonly string[]; readonly mention?: boolean; readonly limit?: number; }
export interface CatchResult { readonly activities: readonly PerceivedActivity[]; readonly consumedThrough: ActivityId | null; readonly idleExpired: boolean; readonly remaining: number; }
export interface CatchWaitStart { readonly idleMs: number; readonly replacementRequested: boolean; readonly replaced: boolean; }
export type OperationProgress =
  | { readonly kind: 'waiting'; readonly reason: 'held' | 'throttled'; readonly delayMs?: number; readonly holder?: string; readonly holdReason?: string }
  | ({ readonly kind: 'catch-started'; readonly participant: string } & CatchWaitStart);
export interface OperationControl { readonly signal?: AbortSignal; readonly onProgress?: (progress: OperationProgress) => void; }
export interface HistoryQuery { readonly limit?: number; readonly order?: 'asc' | 'desc'; readonly before?: ActivityId; readonly after?: ActivityId; readonly grep?: string; readonly fixed?: string; readonly from?: readonly string[]; readonly mention?: string; }
export interface ParticipantStatus { readonly name: string; readonly state: 'joined' | 'done'; readonly consumedThrough: ActivityId | null; readonly watching: boolean; readonly listening: readonly string[]; }
export interface SquareSnapshot { readonly context: string; readonly actCount: number; readonly hardCap: number | null; readonly throttlePerMinute?: number; readonly held: { readonly by: string; readonly reason?: string } | null; readonly participants: readonly ParticipantStatus[]; delivered(name: string, id: ActivityId): boolean; }

export type SquareSource = { path: string };
export interface OpenOptions { clock?: () => number; hostLedger?: HostLedgerPort; wakeTransport?: WakeTransportPort; env?: NodeJS.ProcessEnv }
export interface SquareAtInput extends SquareSource, OpenOptions {}
export interface SquareBuildInput extends SquareSource, OpenOptions {
  markdown: string;
  hardCap?: number | null;
  throttlePerMinute?: number;
}
/** Optional fence for owner-scoped lifecycle actions. */
export interface OwnershipFenceOptions { readonly expectedEpoch?: number; }
export interface Participant {
  readonly name: string;
  express(body: string, options?: ExpressOptions, control?: OperationControl): Promise<ExpressResult>;
  listen(target: string, control?: OperationControl): Promise<ListenerChangeResult>;
  ignore(target: string, control?: OperationControl): Promise<ListenerChangeResult>;
  listening(control?: OperationControl): Promise<readonly string[]>;
  catch(options?: CatchOptions, control?: OperationControl): Promise<CatchResult>;
  history(query?: HistoryQuery, control?: OperationControl): Promise<Activity[]>;
  hold(reason?: string, control?: OperationControl): Promise<ExpressResult>;
  resume(control?: OperationControl): Promise<ExpressResult>;
  /** Leave without a message. Only an omitted or empty body is accepted. */
  done(body?: string, control?: OperationControl): Promise<ExpressResult>;
}

export interface SquareApplicationContext extends Readonly<OpenOptions> {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly squarePath?: string;
  readonly participant?: string;
}
export interface ApplicationOutcome<Data, Projection> { readonly data: Data; readonly projection: Projection; }
export interface ApplicationFailureDetail {
  readonly operation: 'express' | 'join' | 'catch' | 'history' | 'other';
  readonly subject?: 'caller' | 'filter' | 'recipient';
  readonly participant?: string;
  readonly expressEffect?: 'unsent' | 'landed' | 'unknown';
  readonly landedId?: ActivityId;
  readonly historyBounds?: { readonly maxLimit: number; readonly totalMatches: number };
}
export interface ApplicationError extends Error { readonly operation?: ApplicationFailureDetail; }
export interface SquareContextProjection {
  readonly location: string;
  readonly standingCount: number;
  readonly held: boolean;
  readonly now: number;
  readonly participant?: string;
  readonly automaticDeliveryAvailable: boolean;
}
export interface BuildApplicationInput {
  readonly markdown: string;
  readonly hardCap?: number | null;
  readonly throttlePerMinute?: number;
  readonly template?: string;
  readonly force?: boolean;
}
export interface BuildApplicationData { readonly location: string; readonly hardCap: number | null; readonly throttlePerMinute?: number; }
export interface JoinApplicationOptions { readonly takeover?: boolean; readonly last?: number; }
export interface JoinApplicationData {
  readonly participant: string;
  readonly activity: Activity | null;
  readonly kind: 'joined' | 'reconnected' | 'taken-over';
  /** Known joined-or-done participants, NOT the current standing count. */
  readonly participantCount: number;
}
export interface ExpressApplicationOptions extends ExpressOptions { readonly noWait?: boolean; readonly requireExplicitReach?: boolean; }
export interface ExpressApplicationData { readonly activity: Activity; readonly waited: boolean; readonly replyAuthorNotHere?: string; }
export interface CatchApplicationOptions extends CatchOptions { readonly replace?: boolean; }
export type CatchTerminalStatus = 'already-active' | 'replaced' | 'capped' | 'quorum';
export type CatchStopStatus = CatchTerminalStatus | 'empty-now' | 'stale';
export interface CatchApplicationData extends CatchResult { readonly status?: CatchTerminalStatus; }
export interface HistoryApplicationQuery extends HistoryQuery {
  readonly since?: number;
  readonly at?: readonly ActivityId[];
  readonly contextBefore?: number;
  readonly contextAfter?: number;
}
export interface HistoryApplicationData { readonly activities: readonly Activity[]; }
export interface ListeningData { readonly listening: readonly string[]; }
export interface LifecycleData { readonly activity: Activity; }
export type ParticipantPresence = 'never-joined' | 'active' | 'watching' | 'done';
/** Canonical public participant fields; status excludes never-joined roster entries. */
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
export interface StatusApplicationData extends Pick<StatusObservation, 'hardCap' | 'activeCount' | 'doneCount' | 'participants' | 'now'> {
  readonly throttlePerMinute?: number;
  readonly hold: { readonly by?: string; readonly reason?: string; readonly at?: number } | null;
  readonly latestActivity?: Activity;
}
export interface ParticipantsApplicationData { readonly participants: readonly ParticipantSummary[]; }
export type DiagnosisApplicationData = DiagnoseResult;
export type MigrationApplicationData = MigrationOutcome;
export interface DiscoveryApplicationOptions { readonly depth?: number; readonly limit?: number; readonly after?: string; }
export interface SquareListItem {
  readonly path: string;
  readonly lastActiveAt: number;
  readonly context: readonly string[];
  readonly participants: readonly string[];
  readonly activities: number;
}
export interface DiscoveryApplicationData {
  readonly items: readonly SquareListItem[];
  readonly stopped: boolean;
  /** All discovered squares before applying the cursor or page limit. */
  readonly total: number;
  readonly remaining: number;
  readonly next?: string;
}
export interface DiscoveryProjection { readonly cwd: string; readonly now: number; readonly depth: number; readonly limit: number; }
export interface InboxApplicationOptions { readonly limit?: number; }
export interface InboxMembershipSummary { readonly name: string; readonly squarePath: string; readonly pending: number; }
export interface InboxApplicationData { readonly rows: readonly InboxMembershipSummary[]; readonly total: number; }
export interface InboxProjection { readonly sessionId: string; readonly now: number; readonly limit: number; }
export interface RecoveryApplicationData {
  readonly participant?: string;
  readonly standingCount?: number;
  readonly held?: boolean;
  readonly holdReason?: string;
  readonly ownActivityCount?: number;
  readonly hardCap?: number | null;
  readonly roster?: readonly string[];
  readonly activitySummaries?: readonly UnreadActivitySummary[];
}
export type RecoveryProjection = RecoveryApplicationData & Partial<SquareContextProjection>;
export type StreamStart = { readonly kind: 'tail'; readonly last: number } | { readonly kind: 'after'; readonly after: number };
export interface StreamApplicationOptions { readonly recipient?: string; readonly start?: StreamStart; }
export type StreamApplicationRecord = ArchiveRecord & { readonly seq: number; readonly square: string; readonly route?: string };

export interface UnreadActivityPreview { readonly number: number; readonly act: Extract<ArchiveRecord, { kind: 'say' }>; readonly perception: Perception; }
export interface UnreadActivitySummary { readonly name: string; readonly count: number; readonly latestActivityAgeMs: number; readonly previews: readonly UnreadActivityPreview[]; }
/** Selected-row observations. participantCount in these existing concern DTOs is a standing count. */
export interface RecoveryObservation {
  readonly name: string; readonly roster: readonly string[];
  readonly activitySummaries: readonly UnreadActivitySummary[];
  readonly participantCount: number; readonly held: boolean; readonly holdReason?: string;
  readonly ownActivityCount: number; readonly hardCap: number | null;
}
export interface EntryPresentation {
  readonly joined: boolean; readonly joinedBefore: boolean; readonly scene: string; readonly context: string; readonly joinContext: string;
  readonly recentActivities: readonly ArchiveRecord[]; readonly perceptions: Readonly<Record<number, Perception>>;
  readonly sayNumbers: Readonly<Record<number, number>>; readonly participantCount: number; readonly held: boolean;
}
export interface HistoryContinuation { readonly direction: 'before' | 'after'; readonly cursor: ActivityId; readonly limit: number; }
export interface HistoryBounds { readonly limit: number | null; readonly maxLimit: number; readonly contextWindow: boolean; }
export interface HistoryPresentation {
  readonly activities: readonly ArchiveRecord[]; readonly sayNumbers: Readonly<Record<number, number>>;
  readonly presenceAnchors: Readonly<Record<number, readonly string[]>>; readonly participantCount: number; readonly held: boolean;
  readonly totalMatches: number; readonly publicBefore: boolean; readonly publicAfter: boolean;
  /** Ordinary terminal history visibility and stable continuation are owner policy. */
  readonly visibleActivities: readonly ArchiveRecord[];
  readonly continuation?: HistoryContinuation;
  readonly bounds: HistoryBounds;
}
export interface ListPresentation { readonly context: readonly string[]; readonly participants: readonly string[]; readonly activities: number; }
export interface StatusObservation {
  readonly hardCap: number | null; readonly throttlePerMinute: number | undefined;
  readonly activeCount: number; readonly doneCount: number; readonly holdActive: boolean;
  readonly holdReason: string | undefined; readonly holdActor: string | undefined; readonly holdAt: number | undefined;
  readonly participants: readonly ParticipantSummary[]; readonly latestAct: ArchiveRecord | undefined; readonly now: number;
}
export interface PresenceClassification {
  /** Active participants, watching first, then recent signs of life; no presentation clipping. */
  readonly orderedHere: readonly ParticipantSummary[];
  readonly lingeringCount: number;
  readonly classificationByName: Readonly<Record<string, 'here' | 'lingering' | 'done' | 'not-joined'>>;
}
export interface ParticipantsPresentation extends ParticipantsApplicationData, PresenceClassification {
  readonly now: number;
  readonly standingCount: number;
  readonly held: boolean;
}
export interface StatusPresentation extends PresenceClassification {
  readonly status: StatusObservation; readonly latestActNumber?: number; readonly latestPerception?: Perception;
  readonly joins: readonly { readonly activity: ArchiveRecord; readonly rejoined: boolean }[]; readonly joinCount: number;
  readonly attentionNames: readonly string[];
  readonly viewer: string;
}
export interface CatchPresence {
  readonly participants: readonly ParticipantSummary[];
  readonly now: number;
}
export interface StreamProjection { readonly activities: readonly { readonly activity: ArchiveRecord; readonly route?: string }[]; readonly cursor: number; readonly hasMore: boolean; }
export interface EntryProjection extends SquareContextProjection, EntryPresentation {}
export interface ExpressionObservation extends Pick<SquareContextProjection, 'standingCount' | 'held' | 'now'> {
  readonly ownActivityCount: number;
  readonly hardCap: number | null;
}
export interface ExpressProjection extends SquareContextProjection, ExpressionObservation {
  readonly participant: string;
  readonly pendingPublic: readonly ArchiveRecord[];
  readonly sayNumbers: Readonly<Record<number, number>>;
  readonly perceptions: Readonly<Record<number, Perception>>;
  readonly reentry?: Activity;
  readonly delivery?: DeliveryResult;
}
export interface CatchProjection extends SquareContextProjection, ExpressionObservation {
  readonly participant: string;
  readonly sayNumbers: Readonly<Record<number, number>>;
  /** Optional nearby presence is not a commit-time selection fact. */
  readonly presence?: CatchPresence;
  readonly stop?: CatchStopStatus;
  readonly waitStarted?: boolean;
  readonly replaced?: boolean;
  readonly enrichmentUnavailable?: true;
}
export interface HistoryProjection extends SquareContextProjection, HistoryPresentation {}
export interface ListenerProjection extends SquareContextProjection { readonly participant: string; readonly target: string; readonly requestedTarget: string; }
export interface EventPresentation { readonly activity: ArchiveRecord; readonly participantCount: number; readonly held: boolean; }
export interface LifecycleProjection extends SquareContextProjection, EventPresentation { readonly delivery?: DeliveryResult; }
export interface StatusProjection extends SquareContextProjection, StatusPresentation {}
export interface ParticipantsProjection extends SquareContextProjection, ParticipantsPresentation {}

export interface SquareApplication {
  now(): number;
  build(input: BuildApplicationInput, control?: OperationControl): Promise<ApplicationOutcome<BuildApplicationData, SquareContextProjection>>;
  join(options?: JoinApplicationOptions, control?: OperationControl): Promise<ApplicationOutcome<JoinApplicationData, EntryProjection>>;
  express(body: string, options?: ExpressApplicationOptions, control?: OperationControl): Promise<ApplicationOutcome<ExpressApplicationData, ExpressProjection>>;
  catch(options?: CatchApplicationOptions, control?: OperationControl): Promise<ApplicationOutcome<CatchApplicationData, CatchProjection>>;
  history(query?: HistoryApplicationQuery, control?: OperationControl): Promise<ApplicationOutcome<HistoryApplicationData, HistoryProjection>>;
  listen(target: string, control?: OperationControl): Promise<ApplicationOutcome<ListenerChangeData, ListenerProjection>>;
  ignore(target: string, control?: OperationControl): Promise<ApplicationOutcome<ListenerChangeData, ListenerProjection>>;
  listening(control?: OperationControl): Promise<ApplicationOutcome<ListeningData, SquareContextProjection>>;
  hold(reason?: string, control?: OperationControl): Promise<ApplicationOutcome<LifecycleData, LifecycleProjection>>;
  resume(control?: OperationControl): Promise<ApplicationOutcome<LifecycleData, LifecycleProjection>>;
  done(body?: string, control?: OperationControl): Promise<ApplicationOutcome<LifecycleData, LifecycleProjection>>;
  status(viewer?: string, control?: OperationControl): Promise<ApplicationOutcome<StatusApplicationData, StatusProjection>>;
  participants(control?: OperationControl): Promise<ApplicationOutcome<ParticipantsApplicationData, ParticipantsProjection>>;
  diagnose(control?: OperationControl): Promise<ApplicationOutcome<DiagnosisApplicationData, Partial<SquareContextProjection>>>;
  migrate(control?: OperationControl): Promise<ApplicationOutcome<MigrationApplicationData, Partial<SquareContextProjection>>>;
  discover(options: DiscoveryApplicationOptions, control?: OperationControl): Promise<ApplicationOutcome<DiscoveryApplicationData, DiscoveryProjection>>;
  inbox(sessionId: string, options?: InboxApplicationOptions, control?: OperationControl): Promise<ApplicationOutcome<InboxApplicationData, InboxProjection>>;
  recovery(control?: OperationControl): Promise<ApplicationOutcome<RecoveryApplicationData, RecoveryProjection>>;
  stream(options: StreamApplicationOptions, control?: OperationControl): AsyncIterable<StreamApplicationRecord>;
}

// Supported named application exports now refer to explicit contracts, never private return types.
export type JoinApplicationResult = JoinApplicationData;
export type ExpressApplicationResult = ExpressApplicationData;
export type ApplicationStatus = StatusApplicationData;
export type ApplicationStatusProjection = StatusProjection;
export type ApplicationParticipants = ParticipantsApplicationData;
