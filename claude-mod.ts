import { observeClaudeDelivery, type ClaudeBinding } from './claude-delivery.js';
import { beginClaudeMcpCall, endClaudeMcpCall } from './claude-mcp-context.js';
import { DeliveryLedger, type DeliveryHandoffRef, type DeliveryRoute } from './delivery-ledger.js';
import { attachDeliverySessionRoutes, detachDeliverySession } from './session-lifecycle.js';
import { harnessOwner } from './owner.js';

export interface ClaudeCoordinate { readonly sessionId: string; readonly cwd: string; readonly version: string; readonly endpoint?: string }
interface ClaudeBridgeInput extends ClaudeCoordinate {
  readonly operation: 'start' | 'reconcile' | 'end' | 'cancel' | 'guard' | 'admitted' | 'stored' | 'tool-begin' | 'tool-end';
  readonly toolUseId?: string;
  readonly agentId?: string;
  readonly token?: string;
  readonly bindings?: readonly ClaudeBinding[];
  readonly text?: string;
  readonly refs?: readonly DeliveryHandoffRef[];
}

/** JSON stdin bridge. Identity is explicit per operation; process.env is never rewritten. */
export async function runClaudeMod(inputText: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (inputText.length > 512_000) throw new Error('Claude bridge input exceeds its bound.');
  const input = JSON.parse(inputText) as ClaudeBridgeInput;
  if (!input || typeof input.sessionId !== 'string' || !input.sessionId || typeof input.cwd !== 'string') throw new Error('Claude bridge coordinate missing.');
  if (input.operation === 'tool-begin') {
    return `${JSON.stringify(await beginClaudeMcpCall({ toolUseId: input.toolUseId!, sessionId: input.sessionId, cwd: input.cwd, agentId: input.agentId }, env))}\n`;
  }
  if (input.operation === 'tool-end') {
    await endClaudeMcpCall(input.toolUseId!, input.token!, env);
    return '{}\n';
  }
  const owner = harnessOwner({ channel: 'claude-code', session: input.sessionId, ...(input.agentId === undefined ? {} : { agent: input.agentId }) });
  const supported = process.platform === 'darwin' && typeof input.endpoint === 'string' && input.endpoint.startsWith('/');
  const routes: DeliveryRoute[] = supported ? [{ kind: 'claude-native', address: { sessionId: input.sessionId, endpoint: input.endpoint!, version: input.version, platform: 'darwin', loaded: 'true' } }] : [];
  const captured = input.bindings?.find(binding => binding.session === input.sessionId)?.generation;
  if (input.operation === 'start') {
    const session = await attachDeliverySessionRoutes(owner, env, routes, AbortSignal.timeout(2500));
    if (session && !supported && session.routes.some(route => route.kind === 'claude-native')) {
      const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
      try { await ledger.updateRoutes({ owner, generation: session.generation, routes: session.routes.filter(route => route.kind !== 'claude-native') }); }
      finally { await ledger.close(); }
    }
    return `${JSON.stringify({ available: supported, diagnostic: supported ? undefined : 'Native inbox unavailable: requires macOS Claude with an interactive loaded mod and its real endpoint.', bindings: session ? [{ session: input.sessionId, generation: session.generation }] : [] })}\n`;
  }
  if (input.operation === 'end') {
    const retired = captured && await detachDeliverySession(owner, captured, env);
    return `${JSON.stringify({ retired: retired ? input.bindings : [] })}\n`;
  }
  if (input.operation === 'reconcile' || input.operation === 'cancel') {
    const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
    try {
      const session = await ledger.session(owner);
      if (captured && session?.generation === captured && session.state === 'attached') {
        if (input.operation === 'cancel') await ledger.cancel({ owner, generation: captured });
        else await ledger.updateRoutes({ owner, generation: captured, routes: [...session.routes.filter(route => route.kind !== 'claude-native'), ...routes] });
      }
      return `${JSON.stringify({ available: supported, diagnostic: supported ? undefined : 'Native inbox unavailable: requires macOS Claude with an interactive loaded mod and its real endpoint.', bindings: input.bindings ?? [], cancelledBindings: input.bindings ?? [] })}\n`;
    } finally { await ledger.close(); }
  }
  if (!['guard', 'admitted', 'stored'].includes(input.operation) || typeof input.text !== 'string') throw new Error('Unknown Claude bridge operation.');
  return `${JSON.stringify(await observeClaudeDelivery(input.sessionId, input.text, input.operation as 'guard' | 'admitted' | 'stored', env, input.refs))}\n`;
}
