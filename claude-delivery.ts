import { DeliveryLedger, type DeliveryHandoffRef } from './delivery-ledger.js';
import { harnessOwner } from './owner.js';
import { hashPayload, nativeTokens } from './claude-transport.js';

export { createClaudeWakeTransport, nativeTokens, nativePayload } from './claude-transport.js';

export type ClaudeBinding = { readonly session: string; readonly generation: string };

/** Extract complete frames and hash the exact bytes observed by the native host. */
export function claudeFrames(text: string): readonly { token: string; payloadHash: string }[] {
  return [...text.matchAll(/(?:^|\n)(\[square-inbox:([a-zA-Z0-9-]+)\]\n[\s\S]*?\n\[\/square-inbox:\2\])(?=\n|$)/g)]
    .map(frame => ({ token: frame[2]!, payloadHash: hashPayload(frame[1]!) }));
}

/** Guard pre-effect; admit and observe only the exact captured handoff after each native effect. */
export async function observeClaudeDelivery(sessionId: string, text: string, operation: 'guard' | 'admitted' | 'stored',
  env: NodeJS.ProcessEnv = process.env, captured?: readonly DeliveryHandoffRef[]): Promise<{ recognized: boolean; current: boolean; refs?: readonly DeliveryHandoffRef[] }> {
  const tokens = nativeTokens(text);
  if (!tokens.length) return { recognized: false, current: false };
  const frames = claudeFrames(text);
  const owner = harnessOwner({ channel: 'claude-code', session: sessionId });
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  try {
    const found = await Promise.all(tokens.map(token => ledger.handoff(token)));
    const recognized = found.some(Boolean);
    if (!recognized) return { recognized: false, current: false };
    if (frames.length !== tokens.length || new Set(tokens).size !== tokens.length || found.some(ref => !ref)) return { recognized, current: false };
    const refs = found as DeliveryHandoffRef[];
    if (refs.some((ref, i) => ref.owner !== owner || ref.routeKind !== 'claude-native' || ref.token !== frames[i]!.token || ref.payloadHash !== frames[i]!.payloadHash)) return { recognized, current: false };
    if (operation === 'admitted' && (!Array.isArray(captured) || captured.length !== refs.length || refs.some((ref, i) => {
      const old = captured[i];
      return !old || old.token !== ref.token || old.owner !== ref.owner || old.generation !== ref.generation || old.payloadHash !== ref.payloadHash || old.routeKind !== ref.routeKind;
    }))) return { recognized, current: false };
    if (operation === 'guard') {
      for (const ref of refs) if (!await ledger.guardHandoff(ref)) return { recognized, current: false };
      return { recognized, current: true, refs };
    }
    for (const ref of refs) {
      const recorded = operation === 'admitted' ? await ledger.acceptHandoff(ref) : await ledger.observePresentation(ref);
      if (!recorded) return { recognized, current: false };
    }
    return { recognized, current: true };
  } finally { await ledger.close(); }
}
