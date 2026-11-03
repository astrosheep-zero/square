import { DeliveryError, connect } from './packages/agent-delivery/src/index.js';

export interface PaseoWakeRequest { agentId: string; prompt: string; messageId: string }

/** Steer one existing Paseo agent, without interrupting its turn. */
export async function sendPaseoWake(request: PaseoWakeRequest, opts: { timeoutMs?: number; beforeSend?: () => Promise<boolean>; signal?: AbortSignal } = {}): Promise<void> {
  const budget = opts.timeoutMs;
  const deadline = budget === undefined ? undefined : Date.now() + budget;
  if (deadline !== undefined && (!Number.isFinite(budget) || budget! <= 0)) throw new DeliveryError('unavailable');
  const agent = await connect({ harness: 'paseo', agentId: request.agentId, ...(budget === undefined ? {} : { timeoutMs: budget }), signal: opts.signal });
  if (opts.signal?.aborted || (deadline !== undefined && Date.now() >= deadline)) throw new DeliveryError('unavailable');
  const remaining = deadline === undefined ? undefined : deadline - Date.now();
  await agent.steer(request.prompt, { id: request.messageId, ...(remaining === undefined ? {} : { timeoutMs: remaining }), signal: opts.signal, beforeSend: opts.beforeSend });
}
