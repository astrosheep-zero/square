import type { WakeRouteKind } from './model.js';
export type PresenceChannel = 'claude-code' | 'codex' | 'opencode' | 'pi' | 'paseo' | 'unknown';
export interface PresenceRecord { readonly location: string; readonly participant: string; readonly session: string; readonly channel: PresenceChannel; readonly route?: { readonly kind: WakeRouteKind; readonly address: Readonly<Record<string,string>> }; readonly updatedAt?: number; readonly epoch?: number; readonly cancelledThrough?: number }
export type PresenceKey = Pick<PresenceRecord,'location'|'participant'|'session'|'channel'>;
export interface PresenceLookup { readonly location?: string; readonly participant?: string; readonly session?: string;  readonly now?: number }
export type PresenceResult = { readonly status:'ensured'; readonly record:PresenceRecord } | { readonly status:'degraded'; readonly record:PresenceRecord; readonly error:unknown };
export type PresenceClaimResult =
  | { readonly status:'acquired'|'owned'; readonly record:PresenceRecord }
  | { readonly status:'busy'; readonly record:PresenceRecord }
  | { readonly status:'degraded'; readonly record:PresenceRecord; readonly error:unknown };
export type NativeDeliveryEvidence = { readonly payload: string; readonly epoch: number } & (
  | { readonly harness: 'claude'; readonly endpoint: string }
  | { readonly harness: 'opencode'; readonly inputId: string }
);
export interface EvidenceRecord { readonly bindingEpoch?: number; readonly nativeDelivery?: NativeDeliveryEvidence; readonly location:string; readonly participant:string; readonly session:string; readonly activity:string; readonly kind:'wake'|'presentation'|'lifecycle'; readonly outcome:string; readonly at?:number; readonly expiresAt?:number; readonly routeKind?:WakeRouteKind; readonly signature?:string; readonly attemptN?:number; readonly message?:string; readonly diagnostic?:unknown; readonly claimToken?:string; readonly ownerPid?:number }
/** Presentation and lifecycle claims only: wake attempts are acquired by claimWakeAttempt. */
export interface EvidenceClaim { readonly location:string; readonly participant:string; readonly session:string; readonly activity:string; readonly kind:'presentation'|'lifecycle'; readonly leaseMs:number; readonly now?:number }
/** Release metadata and includeReleased are diagnostic-only; default evidence reads stay behavior-safe. */
export interface EvidenceRelease { readonly location:string; readonly participant:string; readonly session:string; readonly activity:string; readonly kind:EvidenceRecord['kind']; readonly claimToken: string; readonly routeKind?: WakeRouteKind; readonly attemptN?: number; readonly signature?: string; readonly message?: string; readonly diagnostic?: unknown; readonly now?: number }
export interface EvidenceLookup { readonly location?:string; readonly participant?:string; readonly session?:string; readonly activity?:string; readonly kind?:EvidenceRecord['kind']; readonly now?:number; readonly includeReleased?:boolean }
export interface EvidenceGc { readonly before:number; readonly pendingWakeActivities?: readonly string[] }
export interface WakeAttention { readonly squarePath:string; readonly actIndex:number; readonly recipient:string }
/** One wake attempt row carries attention-wide exclusion and session-specific history. */
export interface WakeAttemptClaimInput { readonly attention:WakeAttention; readonly session:string; readonly routeKind:WakeRouteKind; readonly leaseMs:number; readonly now?:number }
export type WakeAttemptClaim =
  | { readonly status:'acquired'; readonly claimToken:string; readonly attemptN:number }
  | { readonly status:'busy'; readonly record:EvidenceRecord }
  | { readonly status:'terminal'; readonly record:EvidenceRecord }
  | { readonly status:'degraded'; readonly error:unknown };
export interface WakeAttemptTransitionInput { readonly attention:WakeAttention; readonly session:string; readonly claimToken:string; readonly leaseMs:number; readonly now?:number }
export interface WakeAttemptLookup { readonly attention?:WakeAttention; readonly session?:string; readonly now?:number }
export type ClaimResult = { readonly status:'acquired'; readonly claimToken:string } | { readonly status:'busy'|'delivered'; readonly record:EvidenceRecord } | { readonly status:'degraded'; readonly error:unknown };
export interface HostLedgerPort { claimPresence(input:PresenceRecord, signal?: AbortSignal):Promise<PresenceClaimResult>; ensurePresence(input:PresenceRecord):Promise<PresenceResult>; suppressPresence(input:PresenceRecord, through:number):Promise<boolean>; removePresence(input:PresenceKey):Promise<void>; removePresenceIfUnchanged(input:PresenceRecord):Promise<boolean>; listPresence(input:PresenceLookup):Promise<readonly PresenceRecord[]>; claimEvidence(input:EvidenceClaim):Promise<ClaimResult>; releaseEvidence(input:EvidenceRelease):Promise<void>; appendEvidence(input:EvidenceRecord & { readonly claimToken: string }):Promise<void>; listEvidence(input:EvidenceLookup):Promise<readonly EvidenceRecord[]>; listWakeAttempts(input?:WakeAttemptLookup):Promise<readonly EvidenceRecord[]>; prepareNativeWake(input:EvidenceRecord & { readonly claimToken: string; readonly routeKind: WakeRouteKind; readonly nativeDelivery: NativeDeliveryEvidence }):Promise<boolean>; confirmWakeAdmission(input:EvidenceRecord & { readonly claimToken: string }):Promise<boolean>; claimWakeAttempt(input:WakeAttemptClaimInput):Promise<WakeAttemptClaim>; transitionWakeAttempt(input:WakeAttemptTransitionInput):Promise<boolean>; gcEvidence(input:EvidenceGc):Promise<void> }
