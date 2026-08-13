import type { WakeAdapter, WakeDispatchResult, WakeRequest } from './delivery.js';
import type { WakeRoute, WakeRouteKind } from './routes.js';

export interface WakePortHooks {
  nextAttemptN(): number;
  beforeSend(route: WakeRoute, attemptN: number): Promise<boolean>;
  record(route: WakeRoute, attemptN: number, result: Exclude<WakeDispatchResult, { outcome: 'cancelled' }>): Promise<void>;
}

export type WakePortResult =
  | { outcome: 'accepted' | 'unknown' | 'cancelled' }
  | { outcome: 'exhausted' };

/** Select routes globally; adapters own only transport-specific live proof and dispatch. */
export class WakePort {
  private readonly adapters: Map<WakeRouteKind, WakeAdapter>;

  constructor(adapters: WakeAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
  }

  async dispatch(
    routes: readonly WakeRoute[],
    request: WakeRequest,
    hooks: WakePortHooks,
  ): Promise<WakePortResult> {
    for (const route of routes) {
      const adapter = this.adapters.get(route.kind);
      if (adapter === undefined) continue;
      const attemptN = hooks.nextAttemptN();
      const result = await adapter.dispatch(route, request, () => hooks.beforeSend(route, attemptN));
      if (result.outcome === 'cancelled') return result;
      await hooks.record(route, attemptN, result);
      if (result.outcome === 'accepted' || result.outcome === 'unknown') return { outcome: result.outcome };
    }
    return { outcome: 'exhausted' };
  }
}
