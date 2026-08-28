import type { WakeAdapter, WakeDispatchResult } from './delivery.js';
import type { WakeRoute, WakeRouteKind } from './model.js';

export interface WakePortHooks {
  nextAttemptN(): number | Promise<number>;
  beforeSend(route: WakeRoute, attemptN: number): Promise<boolean>;
  record(route: WakeRoute, attemptN: number, result: Exclude<WakeDispatchResult, { outcome: 'cancelled' | 'unavailable' }>): Promise<void>;
  invalidate?(route: WakeRoute, result: Extract<WakeDispatchResult, { outcome: 'unavailable' }>): Promise<void>;
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
    payload: string | ((route: WakeRoute) => string),
    hooks: WakePortHooks,
  ): Promise<WakePortResult> {
    for (const route of routes) {
      const adapter = this.adapters.get(route.kind);
      if (adapter === undefined) continue;
      const attemptN = await hooks.nextAttemptN();
      const result = await adapter.dispatch(
        route.address,
        typeof payload === 'function' ? payload(route) : payload,
        () => hooks.beforeSend(route, attemptN),
      );
      if (result.outcome === 'cancelled') return result;
      if (result.outcome === 'unavailable') {
        if (result.routeStale === true) await hooks.invalidate?.(route, result);
        continue;
      }
      await hooks.record(route, attemptN, result);
      if (result.outcome === 'accepted' || result.outcome === 'unknown') return { outcome: result.outcome };
    }
    return { outcome: 'exhausted' };
  }
}
