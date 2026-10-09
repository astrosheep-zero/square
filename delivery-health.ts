import { type DirectedNotificationRoute, deriveDeliveryModel } from './delivery.js';
import { formatActivityId } from './square-core.js';
import { participantIdentity, truncateChars } from './presentation.js';
import { formatDuration } from './time.js';
import { projectWakeEvidenceFromState } from './square-projections.js';
import type { WakeAttempt, WakeReleaseDiagnostic } from './wake-evidence.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { pendingDeliveriesFromState } from './views.js';
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
    const { state } = await square.artifact.read();
    const delivery = deriveDeliveryModel(state);
    const pending = pendingDeliveriesFromState(state, delivery);
    const evidenceProjection = await projectWakeEvidenceFromState({
      location: squarePath,
      state,
      hostLedger: square.hostLedger!,
      now,
      delivery,
    });
    const items: DeliveryHealthItem[] = [];
    for (const pendingDelivery of pending) {
      for (const note of pendingDelivery.notifications) {
        const ageMs = Math.max(0, now - note.item.at);
        const evidence = evidenceProjection.evidence(pendingDelivery.recipient, note.item.index);
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
          recipient: pendingDelivery.recipient,
          actIndex: note.item.index,
          actor: note.item.actor,
          at: note.item.at,
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

function formatItem(item: DeliveryHealthItem): string {
  const evidence = item.attempt?.signature === undefined ? '' : ` · ${displayField(item.attempt.signature)}`;
  return `  · ${formatActivityId(item.actIndex)} → ${displayField(participantIdentity(item.recipient))} from ${displayField(participantIdentity(item.actor))} · ${formatDuration(item.ageMs)}${evidence}`;
}

export function renderDeliveryHealth(items: readonly DeliveryHealthItem[], releases: readonly WakeReleaseDiagnostic[] = [], now = Date.now()): string[] {
  const out = items.length === 0 ? ['✓ no pending delivery attention'] : [`· delivery attention · ${items.length} pending`];
  if (items.length > 0) {
    let displayed = 0;
    for (const kind of DISPLAY_ORDER) {
      const group = items.filter((item) => item.kind === kind);
      if (group.length === 0) continue;
      out.push(`${ACTIONABLE.has(kind) ? '✕' : '○'} ${kind}: ${group.length}`);
      const details = group.slice(0, DETAIL_LIMIT - displayed);
      out.push(...details.map(formatItem));
      displayed += details.length;
    }
    if (items.length > DETAIL_LIMIT) out.push(`${DETAIL_LIMIT} of ${items.length} pending details shown`);
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
  return renderDeliveryHealth(items, releases, now);
}
