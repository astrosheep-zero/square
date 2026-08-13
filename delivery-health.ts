import { loadSquare } from './artifact.js';
import { deriveDeliveryModel, wakeGraceMs, type DirectedNotificationRoute } from './delivery.js';
import { hasPresentedAttention } from './presented.js';
import { lookupParticipant } from './registry.js';
import { readWakeRoutes } from './routes.js';
import { isCurrentlyJoined } from './runtime.js';
import { formatDuration } from './time.js';
import {
  hasAttemptableWakeRoute,
  readWakeAttempts,
  terminalWakeEvidence,
  type WakeAttempt,
} from './wake-attempts.js';
import { IMPLEMENTED_WAKE_ROUTE_KINDS } from './wake-port.js';

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

function currentWakeRoutes(
  squarePath: string,
  recipient: string,
  now: number,
  env: NodeJS.ProcessEnv,
) {
  const implemented = new Set(IMPLEMENTED_WAKE_ROUTE_KINDS);
  const owners = new Set(
    lookupParticipant(squarePath, recipient, now).map((binding) => binding.ownerId),
  );
  return readWakeRoutes({ freshOnly: true, now, env })
    .filter((route) => owners.has(route.ownerId) && implemented.has(route.kind));
}

/** Purely classify current pending attention from the artifact and durable ledgers. */
export function classifyDeliveryHealth(
  squarePath: string,
  opts: { now?: number; env?: NodeJS.ProcessEnv } = {},
): DeliveryHealthItem[] {
  const now = opts.now ?? Date.now();
  const env = opts.env ?? process.env;
  const doc = loadSquare(squarePath);
  const model = deriveDeliveryModel(doc);
  const recipients = [...new Set(doc.acts.filter((act) => act.kind === 'join').map((act) => act.actor))]
    .filter((name) => isCurrentlyJoined(doc.acts, name));

  return recipients.flatMap((recipient) => model.pendingFor(recipient).map((note) => {
    const attention = { squarePath, actIndex: note.item.index, recipient: note.recipient };
    const ageMs = Math.max(0, now - note.item.at);
    const presented = hasPresentedAttention(squarePath, note.recipient, note.item.index, env, now);
    const attempts = readWakeAttempts({ attention, env, now });
    const terminal = terminalWakeEvidence(attempts);
    const routes = currentWakeRoutes(squarePath, note.recipient, now, env);
    const kind: DeliveryHealthKind = presented
      ? 'presented-not-delivered'
      : terminal?.outcome === 'accepted'
        ? 'wake-accepted'
        : terminal?.outcome === 'unknown'
          ? 'wake-unknown'
          : ageMs > wakeGraceMs(env) && !hasAttemptableWakeRoute(routes, attempts)
            ? 'unreachable'
            : 'awaiting';
    const attempt = terminal ?? attempts.at(-1);
    return {
      squarePath,
      recipient: note.recipient,
      actIndex: note.item.index,
      actor: note.item.actor,
      at: note.item.at,
      ageMs,
      route: note.route,
      kind,
      ...(attempt === undefined ? {} : { attempt }),
    };
  }));
}

function formatItem(item: DeliveryHealthItem): string {
  const evidence = item.attempt?.signature === undefined ? '' : ` · ${item.attempt.signature}`;
  return `  · act_${item.actIndex} → @${item.recipient} from @${item.actor} · ${formatDuration(item.ageMs)}${evidence}`;
}

export function doctorDeliveryHealth(
  squarePath: string,
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const items = classifyDeliveryHealth(squarePath, { now, env });
  if (items.length === 0) return ['✓ no pending delivery attention'];

  const out = [`· delivery attention · ${items.length} pending`];
  for (const kind of DISPLAY_ORDER) {
    const group = items.filter((item) => item.kind === kind);
    if (group.length === 0) continue;
    out.push(`${ACTIONABLE.has(kind) ? '✕' : '○'} ${kind}: ${group.length}`);
    out.push(...group.map(formatItem));
  }
  return out;
}
