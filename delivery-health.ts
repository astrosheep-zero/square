import { type DirectedNotificationRoute, collectPending } from './delivery.js';
import { formatActivityId } from './square-core.js';
import { participantIdentity, truncateChars } from './presentation.js';
import { formatDuration } from './time.js';
import { projectWakeEvidence } from './wake-eligibility.js';
import { decodeWakeEvidence, type WakeAttempt, type WakeReleaseDiagnostic } from './wake-evidence.js';
import { hostLedgerForEnv } from './registry.js';
import { openSquare } from './open-square.js';
import { closeOpenSquare } from './open-square.js';
import { readWakeReleaseDiagnostics } from './wake-attempts.js';

export type DeliveryHealthKind =
  | 'awaiting'
  | 'wake-accepted'
  | 'wake-unknown'
  | 'presented-not-delivered'
  | 'unreachable';

export interface DeliveryHealthItem {
  squarePath: string;
  recipient: string;
  actIndex: number;
  actor: string;
  at: number;
  ageMs: number;
  route: DirectedNotificationRoute;
  kind: DeliveryHealthKind;
  attempt?: WakeAttempt;
}

const DISPLAY_ORDER: readonly DeliveryHealthKind[] = [
  'awaiting',
  'wake-accepted',
  'wake-unknown',
  'presented-not-delivered',
  'unreachable',
];

const ACTIONABLE = new Set<DeliveryHealthKind>(['wake-unknown', 'unreachable']);
const DETAIL_LIMIT = 20;
const DISPLAY_FIELD_LIMIT = 160;

/** Purely classify current pending attention from the artifact and durable ledgers. */
export async function classifyDeliveryHealth(
  squarePath: string,
  opts: { graceMs: number; now?: number; env?: NodeJS.ProcessEnv },
): Promise<DeliveryHealthItem[]> {
  const now = opts.now ?? Date.now();
  const env = opts.env ?? process.env;
  const square = await openSquare(squarePath, { clock: () => now, env });
  try {
    const { scan, routes, pending } = await collectPending(square.artifact);
    const evidenceProjection = await projectWakeEvidence({ location: squarePath, routes, pending, hostLedger: square.hostLedger!, now });
    const items: DeliveryHealthItem[] = [];
    for (const participant of scan.roster) {
      for (const note of pending.filter((head) => head.recipient === participant.name)) {
        const ageMs = Math.max(0, now - note.at);
        const evidence = evidenceProjection.evidence(note.recipient, note.index);
        const kind: DeliveryHealthKind = evidence.presented
          ? 'presented-not-delivered'
          : evidence.terminal?.outcome === 'accepted'
            ? 'wake-accepted'
            : evidence.terminal?.outcome === 'unknown'
              ? 'wake-unknown'
              : ageMs > opts.graceMs && evidence.attemptableRoutes.length === 0
                ? 'unreachable'
                : 'awaiting';
        const attempt = evidence.terminal ?? evidence.attempts.at(-1);
        items.push({
          squarePath,
          recipient: note.recipient,
          actIndex: note.index,
          actor: note.actor,
          at: note.at,
          ageMs,
          route: note.route,
          kind,
          ...(attempt === undefined ? {} : { attempt }),
        });
      }
    }
    return items;
  } finally {
    await closeOpenSquare(square);
  }
}

function displayField(value: string): string {
  const truncated = truncateChars(value, DISPLAY_FIELD_LIMIT - 1);
  return truncated.remaining === 0 ? truncated.text : `${truncated.text}…`;
}

export function renderDeliveryHealth(items: readonly DeliveryHealthItem[], releases: readonly WakeReleaseDiagnostic[] = [], now = Date.now(), nativeAttempts: readonly WakeAttempt[] = []): string[] {
  const out = items.length === 0 ? ['✓ no pending delivery attention'] : [`· delivery attention · ${items.length} pending`];
  if (items.length > 0) {
    let displayed = 0;
    for (const kind of DISPLAY_ORDER) {
      const group = items.filter((item) => item.kind === kind);
      if (group.length === 0) continue;
      out.push(`${ACTIONABLE.has(kind) ? '✕' : '○'} ${kind}: ${group.length}`);
      const details = group.slice(0, DETAIL_LIMIT - displayed);
      out.push(...details.map((item) => {
        const evidence = item.attempt?.signature === undefined ? '' : ` · ${displayField(item.attempt.signature)}`;
        return `  · ${formatActivityId(item.actIndex)} → ${displayField(participantIdentity(item.recipient))} from ${displayField(participantIdentity(item.actor))} · ${formatDuration(item.ageMs)}${evidence}`;
      }));
      displayed += details.length;
    }
    if (items.length > DETAIL_LIMIT) out.push(`${DETAIL_LIMIT} of ${items.length} pending details shown`);
  }
  if (nativeAttempts.length > 0) {
    out.push(`· Claude native custody · ${nativeAttempts.length}`);
    out.push(...nativeAttempts.slice(0, DETAIL_LIMIT).map((attempt) => {
      const observations = [...attempt.nativeObservations ?? []].sort((a, b) => a.observedAt - b.observedAt);
      const last = observations.at(-1)!;
      const states = observations.map((observation) => `${observation.state}${observation.reason ? ` (${observation.reason})` : ''}`).join(' → ');
      return `  · ${formatActivityId(attempt.attention.actIndex)} → ${displayField(participantIdentity(attempt.attention.recipient))} · ${attempt.outcome} · native ${displayField(states)} · ${formatDuration(Math.max(0, now - last.observedAt))} · message ${displayField(last.messageId)}`;
    }));
    if (nativeAttempts.length > DETAIL_LIMIT) out.push(`${DETAIL_LIMIT} of ${nativeAttempts.length} native custody details shown`);
  }
  if (releases.length > 0) {
    out.push(`· recent wake releases · ${releases.length}`);
    out.push(...releases.slice(0, DETAIL_LIMIT).map((release) => formatRelease(release, now)));
    if (releases.length > DETAIL_LIMIT) out.push(`${DETAIL_LIMIT} of ${releases.length} wake releases shown`);
  }
  return out;
}

function formatRelease(release: WakeReleaseDiagnostic, now: number): string {
  const route = displayField(release.routeKind ?? 'unknown route');
  const reason = displayField(release.signature ?? 'reason not recorded');
  const age = formatDuration(Math.max(0, now - release.at));
  const message = release.message === undefined ? '' : ` — ${displayField(release.message)}`;
  const diagnostic = release.diagnostic === undefined ? '' : ` · ${displayField(JSON.stringify(release.diagnostic))}`;
  return `  · ${formatActivityId(release.attention.actIndex)} → ${displayField(participantIdentity(release.attention.recipient))} · ${route} · ${reason} · ${age}${message}${diagnostic}`;
}

export async function doctorDeliveryHealth(
  squarePath: string,
  graceMs: number,
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const items = await classifyDeliveryHealth(squarePath, { graceMs, now, env });
  const releases = await readWakeReleaseDiagnostics({ location: squarePath, now, env });
  const rows = await hostLedgerForEnv(env).listEvidence({ location: squarePath, kind: 'wake', includeReleased: true, now });
  const nativeAttempts = rows.flatMap((row) => {
    const decoded = decodeWakeEvidence(row, now);
    return decoded?.kind === 'attempt' && decoded.value.nativeObservations?.length ? [decoded.value] : [];
  }).sort((a, b) => Math.max(...b.nativeObservations!.map((row) => row.observedAt)) - Math.max(...a.nativeObservations!.map((row) => row.observedAt)));
  return renderDeliveryHealth(items, releases, now, nativeAttempts);
}
