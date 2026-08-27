import type { WakeRouteKind } from './model.js';
export type HostLedgerScope = 'user' | 'local';
export type PresenceChannel = 'claude-code' | 'codex' | 'opencode' | 'pi' | 'paseo' | 'unknown';
export interface PresenceRecord { readonly location: string; readonly participant: string; readonly session: string; readonly channel: PresenceChannel; readonly route?: { readonly kind: WakeRouteKind; readonly address: Readonly<Record<string,string>> }; readonly updatedAt?: number }
export type PresenceKey = Pick<PresenceRecord,'location'|'participant'|'session'|'channel'>;
export interface PresenceLookup { readonly location?: string; readonly participant?: string; readonly session?: string; readonly scopes?: readonly HostLedgerScope[]; readonly now?: number }
export type PresenceResult = { readonly status:'ensured'; readonly record:PresenceRecord } | { readonly status:'degraded'; readonly record:PresenceRecord; readonly error:unknown };
export interface EvidenceRecord { readonly location:string; readonly participant:string; readonly session:string; readonly activity:string; readonly kind:'wake'|'presentation'; readonly outcome:string; readonly at?:number; readonly routeKind?:WakeRouteKind; readonly signature?:string; readonly attemptN?:number; readonly message?:string; readonly diagnostic?:unknown }
export interface EvidenceClaim { readonly location:string; readonly participant:string; readonly session:string; readonly activity:string; readonly kind:EvidenceRecord['kind']; readonly now?:number }
export interface EvidenceLookup { readonly location?:string; readonly participant?:string; readonly session?:string; readonly activity?:string; readonly kind?:EvidenceRecord['kind']; readonly now?:number }
export interface EvidenceGc { readonly before:number }
export type ClaimResult = { readonly status:'acquired' } | { readonly status:'busy'|'delivered'; readonly record:EvidenceRecord } | { readonly status:'degraded'; readonly error:unknown };
export interface ReconcileBindingInput { readonly scopes?:readonly HostLedgerScope[]; readonly now?:number; readonly artifact?:{ read():Promise<{state:{acts:readonly {kind:string;actor?:string}[]}}>} }
export type ReconcileBindingResult = { readonly status:'reconciled'|'degraded'; readonly bindings:readonly PresenceRecord[]; readonly error?:unknown };
export interface HostLedgerPort { ensurePresence(input:PresenceRecord):Promise<PresenceResult>; removePresence(input:PresenceKey):Promise<void>; listPresence(input:PresenceLookup):Promise<readonly PresenceRecord[]>; claimEvidence(input:EvidenceClaim):Promise<ClaimResult>; appendEvidence(input:EvidenceRecord):Promise<void>; listEvidence(input:EvidenceLookup):Promise<readonly EvidenceRecord[]>; gcEvidence(input:EvidenceGc):Promise<void>; reconcileBinding(input:ReconcileBindingInput):Promise<ReconcileBindingResult> }
