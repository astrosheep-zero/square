import type { WakeRouteKind } from './model.js';
export type HostLedgerScope = 'user' | 'local';
export type PresenceChannel = 'claude-code' | 'codex' | 'opencode' | 'pi' | 'paseo' | 'unknown';
export interface PresenceRecord { readonly location: string; readonly participant: string; readonly session: string; readonly channel: PresenceChannel; readonly route?: { readonly kind: WakeRouteKind; readonly address: Readonly<Record<string,string>> }; readonly updatedAt?: number }
export type PresenceKey = Pick<PresenceRecord,'location'|'participant'|'session'|'channel'>;
export interface PresenceLookup { readonly location?: string; readonly participant?: string; readonly session?: string; readonly scopes?: readonly HostLedgerScope[]; readonly now?: number }
export type PresenceResult = { readonly status:'ensured'; readonly record:PresenceRecord } | { readonly status:'degraded'; readonly record:PresenceRecord; readonly error:unknown };
export type PresenceClaimResult =
  | { readonly status:'acquired'|'owned'; readonly record:PresenceRecord }
  | { readonly status:'busy'; readonly record:PresenceRecord }
  | { readonly status:'degraded'; readonly record:PresenceRecord; readonly error:unknown };
export interface EvidenceRecord { readonly location:string; readonly participant:string; readonly session:string; readonly activity:string; readonly kind:'wake'|'presentation'; readonly outcome:string; readonly at?:number; readonly expiresAt?:number; readonly routeKind?:WakeRouteKind; readonly signature?:string; readonly attemptN?:number; readonly message?:string; readonly diagnostic?:unknown }
export interface EvidenceClaim { readonly location:string; readonly participant:string; readonly session:string; readonly activity:string; readonly kind:EvidenceRecord['kind']; readonly leaseMs:number; readonly now?:number }
export type EvidenceRelease = Omit<EvidenceClaim,'leaseMs'>;
export interface EvidenceLookup { readonly location?:string; readonly participant?:string; readonly session?:string; readonly activity?:string; readonly kind?:EvidenceRecord['kind']; readonly now?:number }
export interface EvidenceGc { readonly before:number }
export interface WakeAttention { readonly squarePath:string; readonly actIndex:number; readonly recipient:string }
export interface WakeDispatchLease { readonly leaseId:string; readonly expiresAt:number; readonly phase:'claimed'|'dispatching'; readonly routeKind?:WakeRouteKind; readonly attemptN?:number; readonly session?:string }
export type WakeDispatchClaim = { readonly type:'acquired'; readonly leaseId:string } | { readonly type:'busy' } | { readonly type:'ambiguous'; readonly lease:WakeDispatchLease };
export interface WakeDispatchClaimInput { readonly attention:WakeAttention; readonly leaseId:string; readonly leaseMs:number; readonly session?:string; readonly at?:number }
export interface WakeDispatchTransitionInput { readonly attention:WakeAttention; readonly leaseId:string; readonly phase:WakeDispatchLease['phase']; readonly leaseMs:number; readonly routeKind?:WakeRouteKind; readonly attemptN?:number; readonly session?:string; readonly at?:number }
export interface WakeDispatchReleaseInput { readonly attention:WakeAttention; readonly leaseId:string; readonly session?:string; readonly at?:number }
export interface WakeAttemptLookup { readonly attention?:WakeAttention; readonly session?:string; readonly now?:number }
export type ClaimResult = { readonly status:'acquired' } | { readonly status:'busy'|'delivered'; readonly record:EvidenceRecord } | { readonly status:'degraded'; readonly error:unknown };
export interface ReconcileBindingInput { readonly scopes?:readonly HostLedgerScope[]; readonly now?:number; readonly artifact?:{ read():Promise<{state:{acts:readonly {kind:string;actor?:string}[]}}>} }
export type ReconcileBindingResult = { readonly status:'reconciled'|'degraded'; readonly bindings:readonly PresenceRecord[]; readonly error?:unknown };
export interface HostLedgerPort { claimPresence(input:PresenceRecord, scope?:HostLedgerScope):Promise<PresenceClaimResult>; ensurePresence(input:PresenceRecord, scope?:HostLedgerScope):Promise<PresenceResult>; removePresence(input:PresenceKey):Promise<void>; listPresence(input:PresenceLookup):Promise<readonly PresenceRecord[]>; claimEvidence(input:EvidenceClaim):Promise<ClaimResult>; releaseEvidence(input:EvidenceRelease):Promise<void>; appendEvidence(input:EvidenceRecord):Promise<void>; listEvidence(input:EvidenceLookup):Promise<readonly EvidenceRecord[]>; listWakeAttempts(input?:WakeAttemptLookup):Promise<readonly EvidenceRecord[]>; appendWakeAttempt(input:EvidenceRecord):Promise<void>; claimWakeDispatch(input:WakeDispatchClaimInput):Promise<WakeDispatchClaim>; transitionWakeDispatch(input:WakeDispatchTransitionInput):Promise<boolean>; releaseWakeDispatch(input:WakeDispatchReleaseInput):Promise<void>; gcEvidence(input:EvidenceGc):Promise<void>; reconcileBinding(input:ReconcileBindingInput):Promise<ReconcileBindingResult> }
