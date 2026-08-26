import { spawnSync } from 'node:child_process';

import { codexQueueEligible } from './codex-boundary-state.js';
import type { WakeAdapter, WakeDispatchResult } from './delivery.js';
import { type WakeRoute } from './model.js';

export interface CodexQueueRequest {
  threadId: string;
  message: string;
}

export type CodexQueueFailureKind = 'transient' | 'rejected' | 'unknown';

export class CodexQueueSendError extends Error {
  constructor(message: string, public readonly kind: CodexQueueFailureKind) {
    super(message);
    this.name = 'CodexQueueSendError';
  }
}

function classifyFailure(message: string): CodexQueueFailureKind {
  if (/ENOENT|not found.*executable|ECONNREFUSED|timed out|timeout/i.test(message)) return 'transient';
  if (/invalid|unknown thread|not found|rejected|permission|auth/i.test(message)) return 'rejected';
  return 'unknown';
}

export function sendCodexQueue(
  { threadId, message }: CodexQueueRequest,
  opts: { bin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): void {
  const result = spawnSync(
    opts.bin ?? process.env.SQUARE_CODEX_BIN ?? 'codex',
    ['queue', '--thread', threadId, '--message', message],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeoutMs ?? 5000, env: opts.env ?? process.env },
  );
  if (result.error) {
    const messageText = result.error.message;
    throw new CodexQueueSendError(messageText, classifyFailure(messageText));
  }
  if (result.status === 0) return;
  const output = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
  const messageText = output || `codex queue exited with ${result.status ?? 'no status'}`;
  throw new CodexQueueSendError(messageText, classifyFailure(messageText));
}

export interface CodexQueueAdapterOptions {
  env?: NodeJS.ProcessEnv;
  sendQueue?: typeof sendCodexQueue;
}

export class CodexQueueAdapter implements WakeAdapter {
  readonly kind = 'codex-queue' as const;

  constructor(private readonly opts: CodexQueueAdapterOptions = {}) {}

  async dispatch(
    address: Readonly<Record<string, string>>,
    payload: string,
    beforeSend: () => Promise<boolean>,
  ): Promise<WakeDispatchResult> {
    const threadId = address.threadId?.trim();
    if (!threadId) {
      return { outcome: 'unavailable', signature: 'invalid_address', message: 'Codex route has no thread id.' };
    }
    const env = this.opts.env ?? process.env;
    if (!await codexQueueEligible(threadId, env)) {
      return {
        outcome: 'unavailable',
        signature: 'boundary_not_stopped',
        message: 'The Codex thread has not reached a current Stop boundary.',
        retainRoute: true,
      };
    }
    if (!(await beforeSend())) return { outcome: 'cancelled' };
    if (!await codexQueueEligible(threadId, env)) {
      return {
        outcome: 'unavailable',
        signature: 'boundary_not_stopped',
        message: 'The Codex thread left its Stop boundary before queueing.',
        retainRoute: true,
      };
    }
    try {
      (this.opts.sendQueue ?? sendCodexQueue)({ threadId, message: payload }, { env });
      return { outcome: 'accepted' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = error instanceof CodexQueueSendError ? error.kind : 'unknown';
      if (kind === 'unknown') return { outcome: 'unknown', signature: 'queue_unknown', message };
      return {
        outcome: 'failed',
        signature: kind === 'transient' ? 'queue_pre_accept_transient' : 'queue_pre_accept_rejected',
        message,
      };
    }
  }
}

export type { WakeRoute };
