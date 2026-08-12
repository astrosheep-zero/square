import { spawnSync } from 'node:child_process';

export interface PaseoWakeRequest { agentId: string; prompt: string; }

export type PaseoWakeFailureKind = 'retryable' | 'permanent' | 'unknown';

export class PaseoWakeSendError extends Error {
  constructor(message: string, public readonly kind: PaseoWakeFailureKind) {
    super(message);
    this.name = 'PaseoWakeSendError';
  }
}

interface PaseoCommandError {
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

function commandError(output: string): { code?: string; message: string } | undefined {
  try {
    const parsed = JSON.parse(output) as PaseoCommandError;
    if (parsed.error === undefined) return undefined;
    return {
      ...(typeof parsed.error.code === 'string' ? { code: parsed.error.code } : {}),
      message: typeof parsed.error.message === 'string' ? parsed.error.message : output.trim(),
    };
  } catch {
    return undefined;
  }
}

function classifyCommandFailure(code: string | undefined, message: string): PaseoWakeFailureKind {
  if (code === 'DAEMON_NOT_RUNNING' || /ECONNREFUSED|ENOENT|not found.*executable/i.test(message)) return 'retryable';
  if (/password|auth|unauthori[sz]ed|agent not found|rejected/i.test(message)) return 'permanent';
  return 'unknown';
}

function redactUriPassword(value: string): string {
  return value.replace(/([?&]password=)[^&\s]+/gi, '$1[redacted]');
}

export function sendPaseoWake(
  { agentId, prompt }: PaseoWakeRequest,
  opts: { timeoutMs?: number } = {}
): void {
  const result = spawnSync(
    process.env.SQUARE_PASEO_BIN || 'paseo',
    ['send', agentId, '--prompt', prompt, '--no-wait', '--json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeoutMs ?? 5000, env: process.env }
  );
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const kind: PaseoWakeFailureKind = code === 'ENOENT' || code === 'ECONNREFUSED' ? 'retryable' : 'unknown';
    throw new PaseoWakeSendError(result.error.message, kind);
  }
  if (result.status === 0) return;

  const output = `${result.stderr ?? ''}${result.stdout ?? ''}`;
  const failure = commandError(output);
  const message = redactUriPassword(failure?.message || output.trim() || `paseo send exited with ${result.status ?? 'no status'}`);
  throw new PaseoWakeSendError(message, classifyCommandFailure(failure?.code, message));
}
