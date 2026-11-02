import type { WakeRouteKind } from './channel-values.js';
import type { WakeTransportPort } from './channel-transport.js';
export type WakeTransports = Readonly<Partial<Record<WakeRouteKind, WakeTransportPort>>>;

/** Concrete transports use wall time; semantic state time belongs to Square operations. */
export async function createDefaultWakeTransport(
  env: NodeJS.ProcessEnv = process.env,
  suppliedTransports?: WakeTransports,
): Promise<WakeTransportPort> {
  if (suppliedTransports !== undefined) return createWakeTransport(suppliedTransports);
  const transports: Partial<Record<WakeRouteKind, WakeTransportPort>> = {};
  try {
    const { CodexQueueTransport } = await import('./codex-queue.js');
    transports['codex-queue'] = new CodexQueueTransport({ env });
  } catch { /* core-only builds may omit Codex */ }
  if (env.SQUARE_DISABLE_PASEO_WAKE !== '1') {
    try {
      const { PaseoWakeTransport } = await import('./paseo-delivery.js');
      transports.paseo = new PaseoWakeTransport();
    } catch { /* Paseo is optional */ }
  }
  const { createClaudeWakeTransport } = await import('./claude-transport.js');
  transports['claude-native'] = createClaudeWakeTransport(env);
  const { HttpWakeTransport } = await import('./http-delivery.js');
  transports.http = new HttpWakeTransport({ env });
  return createWakeTransport(transports);
}

/** Route selection only: all implementations receive the same request and final gate. */
export function createWakeTransport(transports: WakeTransports): WakeTransportPort {
  const missing = (kind: WakeRouteKind) => ({ outcome: 'not-capable' as const, diagnostic: `no transport for ${kind}` });
  return {
    async probe(route) {
      const transport = transports[route.kind];
      if (transport === undefined) return missing(route.kind);
      try { return await transport.probe?.(route) ?? true; }
      catch (error) { return { outcome: 'not-capable', diagnostic: error instanceof Error ? error.message : String(error) }; }
    },
    attempt: (request, timeoutMs, beforeSend) => transports[request.route.kind]?.attempt(request, timeoutMs, beforeSend)
      ?? Promise.resolve(missing(request.route.kind)),
  };
}

