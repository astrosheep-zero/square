import { setTimeout as sleep } from 'node:timers/promises';

import type { WakeAdapter, WakeDispatchResult, WakeRequest } from './delivery.js';
import { readWakeRoutes, type WakeRoute, type WakeRouteKind } from './routes.js';

const ROUTE_PRIORITY: readonly WakeRouteKind[] = [
  'codex-app-server',
  'claude-native',
  'opencode-server',
  'pi-extension',
  'paseo',
];

export interface WakePortHooks {
  nextAttemptN(): number;
  beforeSend(route: WakeRoute, attemptN: number): Promise<boolean>;
  record(route: WakeRoute, attemptN: number, result: Exclude<WakeDispatchResult, { outcome: 'cancelled' }>): Promise<void>;
}

export type WakePortResult =
  | { outcome: 'accepted' | 'unknown' | 'cancelled' }
  | { outcome: 'exhausted'; attemptedRoutes: number };

/** Select routes globally; adapters own only transport-specific live proof and dispatch. */
export class WakePort {
  private readonly adapters: Map<WakeRouteKind, WakeAdapter>;

  constructor(adapters: WakeAdapter[], private readonly env: NodeJS.ProcessEnv = process.env) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
  }

  private routes(ownerIds: Set<string>, now = Date.now()): WakeRoute[] {
    const priority = new Map(ROUTE_PRIORITY.map((kind, index) => [kind, index]));
    return readWakeRoutes({ freshOnly: true, now, env: this.env })
      .filter((route) => ownerIds.has(route.ownerId) && this.adapters.has(route.kind))
      .sort((a, b) =>
        (priority.get(a.kind) ?? Number.MAX_SAFE_INTEGER) - (priority.get(b.kind) ?? Number.MAX_SAFE_INTEGER) ||
        b.updatedAt - a.updatedAt
      );
  }

  async dispatch(
    ownerIds: Set<string>,
    request: WakeRequest,
    hooks: WakePortHooks,
    opts: { retryDelaysMs?: number[]; delay?: (ms: number) => Promise<void> } = {}
  ): Promise<WakePortResult> {
    const retryDelays = opts.retryDelaysMs ?? [];
    const delay = opts.delay ?? ((ms: number) => sleep(ms));
    let attemptedRoutes = 0;

    for (const route of this.routes(ownerIds)) {
      const adapter = this.adapters.get(route.kind)!;
      attemptedRoutes += 1;
      for (let retry = 0; ; retry += 1) {
        const attemptN = hooks.nextAttemptN();
        const result = await adapter.dispatch(route, request, () => hooks.beforeSend(route, attemptN));
        if (result.outcome === 'cancelled') return result;
        await hooks.record(route, attemptN, result);
        if (result.outcome === 'accepted' || result.outcome === 'unknown') return { outcome: result.outcome };
        const retryDelay = result.retryable ? retryDelays[retry] : undefined;
        if (retryDelay === undefined) break;
        await delay(retryDelay);
      }
    }
    return { outcome: 'exhausted', attemptedRoutes };
  }
}
