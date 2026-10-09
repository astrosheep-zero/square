import { hostLedgerRoot } from './host-ledger-root.js';
import { nameKey, type WakeRouteKind } from './model.js';
import { canonicalSquarePath } from './registry.js';
import { formatActivityId, parseActivityId } from './square-core.js';
import { createHostLedgerPort } from './host-ledger-file-adapter.js';
import type { WakeAttention } from './host-ledger.js';
import { redactDiagnostic } from './diagnostic-redaction.js';

export interface WakeReleaseDiagnostic {
  readonly at: number;
  readonly attention: WakeAttention;
  readonly routeKind?: WakeRouteKind;
  readonly attemptN?: number;
  readonly session?: string;
  readonly signature?: string;
  readonly message?: string;
  readonly diagnostic?: unknown;
}

async function wakeAttentionKey(attention: WakeAttention): Promise<string> {
  return JSON.stringify([await canonicalSquarePath(attention.squarePath), formatActivityId(attention.actIndex), nameKey(attention.recipient)]);
}

export function redactWakeDiagnostic(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  return redactDiagnostic(value, env.PASEO_PASSWORD);
}

export async function readWakeReleaseDiagnostics(opts: {
  location?: string;
  attention?: WakeAttention;
  sessionId?: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<WakeReleaseDiagnostic[]> {
  const now = opts.now ?? Date.now();
  const env = opts.env ?? process.env;
  const rows = await createHostLedgerPort({ rootPath: hostLedgerRoot(env) }).listEvidence({
    kind: 'wake',
    location: opts.location ?? opts.attention?.squarePath,
    includeReleased: true,
    now,
  });
  const expected = opts.attention === undefined ? undefined : await wakeAttentionKey(opts.attention);
  const releases: WakeReleaseDiagnostic[] = [];
  for (const row of rows) {
    if (row.outcome !== 'released') continue;
    const actIndex = parseActivityId(row.activity);
    if (actIndex === undefined || row.at === undefined) continue;
    if (opts.sessionId !== undefined && row.session !== opts.sessionId) continue;
    const attention = { squarePath: row.location, recipient: row.participant, actIndex };
    if (expected !== undefined && JSON.stringify([row.location, formatActivityId(actIndex), nameKey(row.participant)]) !== expected) continue;
    releases.push({
      at: row.at,
      attention,
      ...(row.routeKind === undefined ? {} : { routeKind: row.routeKind }),
      ...(row.attemptN === undefined ? {} : { attemptN: row.attemptN }),
      ...(row.session === undefined ? {} : { session: row.session }),
      ...(row.signature === undefined ? {} : { signature: row.signature }),
      ...(row.message === undefined ? {} : { message: redactWakeDiagnostic(row.message, env) as string }),
      ...(row.diagnostic === undefined ? {} : { diagnostic: redactWakeDiagnostic(row.diagnostic, env) }),
    });
  }
  return releases.sort((left, right) => right.at - left.at);
}
