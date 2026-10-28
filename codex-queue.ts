import { connect, DeliveryError, type CodexCliAgent, type CodexCliConnectOptions } from './packages/agent-delivery/src/index.js';
export { sendCodexQueue, CodexQueueSendError } from './packages/agent-delivery/src/codex-queue.js';
export type { CodexQueueRequest, CodexQueueFailureKind } from './packages/agent-delivery/src/codex-queue.js';

import { codexBoundaryStore } from './codex-boundary-state.js';
import type { WakeRequest, WakeOutcome, WakeTransportPort } from './ports.js';
import { wakePreview } from './delivery.js';
import type { WakeRoute } from './model.js';

export interface CodexQueueTransportOptions {
  env?: NodeJS.ProcessEnv;
  connect?: (options: CodexCliConnectOptions) => Promise<CodexCliAgent>;
}

export class CodexQueueTransport implements WakeTransportPort {
  constructor(private readonly opts: CodexQueueTransportOptions = {}) {}

  async attempt(request: WakeRequest, timeoutMs: number, beforeSend: () => Promise<boolean>): Promise<WakeOutcome> {
    const deadline = Date.now() + timeoutMs;
    const { address } = request.route;
    const threadId = address.threadId?.trim();
    if (!threadId) {
      return { outcome: 'failed', unavailable: true, signature: 'invalid_address', message: 'Codex route has no thread id.', routeStale: true };
    }
    const env = this.opts.env ?? process.env;
    const payload = request.artifact === undefined ? undefined
      : (await request.artifact.read((facts) => wakePreview(facts, request))).value;
    if (payload === undefined) return { outcome: 'not-capable', diagnostic: 'No pending Square activity to preview.' };
    if (!(await beforeSend())) return { outcome: 'not-capable' };
    try {
      const agent = await (this.opts.connect ?? connect)({
        harness: 'codex', transport: 'cli', sessionId: threadId, boundaries: codexBoundaryStore(env),
        env, bin: env.SQUARE_CODEX_BIN, codexHome: address.codexHome, endpoint: address.endpoint,
      });
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { outcome: 'failed', unavailable: true, signature: 'dispatch_budget_exhausted', message: 'The wake dispatch budget elapsed before queueing.', retainRoute: true };
      }
      await agent.queue(payload, { timeoutMs: remaining });
      return { outcome: 'accepted' };
    } catch (error) {
      if (error instanceof DeliveryError && error.code === 'session_inactive') {
        return { outcome: 'failed', unavailable: true, signature: 'boundary_not_stopped',
          message: 'The Codex thread has no current Stop boundary for queueing.', retainRoute: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof DeliveryError) || error.maybeDelivered) return { outcome: 'unknown', signature: 'queue_unknown', message };
      return { outcome: 'failed', signature: ['unavailable', 'timeout', 'aborted'].includes(error.code)
        ? 'queue_pre_accept_transient' : 'queue_pre_accept_rejected', message };
    }
  }
}

export type { WakeRoute };
