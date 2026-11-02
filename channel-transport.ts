import type { WakeRoute } from './channel-values.js';
import type { MessageId } from './message.js';

/** One wake executor; final send must use the supplied custody gate. */
export interface WakeTransportPort {
  probe?(route: WakeRoute): Promise<boolean | { readonly outcome: 'not-capable'; readonly diagnostic?: string }>;
  attempt(request: WakeRequest, timeoutMs: number, beforeSend: () => Promise<boolean>): Promise<WakeOutcome>;
}
export interface WakePresentation {
  readonly payload: string;
  readonly coverage: 'full' | 'clipped';
  readonly description?: string;
}
export interface WakeProjectionContext {
  readonly location: string;
  readonly participant: string;
  readonly message: MessageId;
  readonly actor: string;
  readonly seat: { readonly participant: string; readonly owner: string; readonly generation: string };
  readonly route: WakeRoute;
}
export type WakeProjection = (context: WakeProjectionContext) => Promise<WakePresentation | undefined>;
export interface WakeRequest extends WakeProjectionContext {
  readonly claimToken?: string;
  readonly attemptN?: number;
  readonly channel: { prepare(input: { readonly correlation: { readonly harness: 'claude' | 'opencode' | 'pi'; readonly token?: string; readonly messageId?: string; readonly payloadHash?: string }; readonly coverage: 'full' | 'clipped'; readonly description?: string }, signal?: AbortSignal): Promise<boolean> };
  readonly presentation?: WakePresentation;
}
export type WakeOutcome =
  | { readonly outcome: 'accepted'; readonly signature?: string }
  | { readonly outcome: 'failed'; readonly message?: string; readonly signature?: string; readonly diagnostic?: unknown }
  | { readonly outcome: 'not-capable'; readonly diagnostic?: string }
  | { readonly outcome: 'unknown'; readonly signature?: string; readonly message?: string; readonly diagnostic?: unknown };
