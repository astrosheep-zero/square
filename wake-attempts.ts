import { hostLedgerRoot } from './host-ledger-root.js';
import { nameKey } from './model.js';
import { canonicalPath } from './canonical-path.js';
import { formatActivityId } from './square-core.js';
import { createHostLedgerPort } from './host-ledger-file-adapter.js';
import type { WakeAttention } from './host-ledger.js';
import { redactDiagnostic } from './diagnostic-redaction.js';
import { decodeWakeEvidence, type WakeReleaseDiagnostic } from './wake-evidence.js';

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
  const expected = opts.attention === undefined ? undefined : JSON.stringify([await canonicalPath(opts.attention.squarePath), formatActivityId(opts.attention.actIndex), nameKey(opts.attention.recipient)]);
  const releases: WakeReleaseDiagnostic[] = [];
  for (const row of rows) {
    const decoded = decodeWakeEvidence(row, now);
    if (decoded?.kind !== 'release') continue;
    const release = decoded.value;
    if (opts.sessionId !== undefined && release.session !== opts.sessionId) continue;
    const { attention } = release;
    if (expected !== undefined && JSON.stringify([attention.squarePath, formatActivityId(attention.actIndex), nameKey(attention.recipient)]) !== expected) continue;
    releases.push({
      ...release,
      ...(release.message === undefined ? {} : { message: redactWakeDiagnostic(release.message, env) as string }),
      ...(release.diagnostic === undefined ? {} : { diagnostic: redactWakeDiagnostic(release.diagnostic, env) }),
    });
  }
  return releases.sort((left, right) => right.at - left.at);
}
