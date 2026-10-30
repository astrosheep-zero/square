import { type DirectedNotificationRoute, collectPending } from './delivery.js';
import { formatActivityId } from './square-core.js';
import { participantIdentity, truncateChars } from './presentation.js';
import { formatDuration } from './time.js';
import type { DeliveryEvidence } from './ports.js';
import { InternalSquareError, SquareError } from './model.js';
import { createArtifactPort } from './artifact.js';

export interface WakeAttempt {
  readonly nativeObservations?: readonly NonNullable<DeliveryEvidence['nativeObservations']>[number][];
  readonly at: number;
  readonly attention: { readonly squarePath: string; readonly recipient: string; readonly actIndex: number };
  readonly routeKind: import('./model.js').WakeRouteKind;
  readonly outcome: 'accepted' | 'unknown' | 'failed';
  readonly signature?: string;
  readonly attemptN: number;
  readonly message?: string;
  readonly diagnostic?: unknown;
}
export interface WakeReleaseDiagnostic {
  readonly at: number;
  readonly attention: { readonly squarePath: string; readonly recipient: string; readonly actIndex: number };
  readonly routeKind?: import('./model.js').WakeRouteKind;
  readonly attemptN?: number;
  readonly session?: string;
  readonly signature?: string;
  readonly message?: string;
  readonly diagnostic?: unknown;
}
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

/** Classify current pending attention from the artifact's seats and delivery evidence. */
export async function classifyDeliveryHealth(
  squarePath: string,
  opts: { graceMs: number; now?: number; env?: NodeJS.ProcessEnv },
): Promise<DeliveryHealthItem[]> {
  const now = opts.now ?? Date.now();
  const artifact = createArtifactPort(squarePath);
  try {
    const { pending } = await collectPending(artifact);
    const current = (await artifact.read((facts) => pending.map((note) => {
      const seat = facts.seat(note.recipient);
      const evidence = seat === undefined ? [] : facts.deliveryEvidence(
        seat.participant, seat.generation, formatActivityId(note.index),
      );
      return { note, seat, evidence };
    }))).value;
    const items: DeliveryHealthItem[] = [];
    for (const { note, seat, evidence } of current) {
      const ageMs = Math.max(0, now - note.at);
      const presentation = evidence.some((row) => row.kind === 'presentation' && (
        row.outcome === 'presented' || row.outcome === 'clipped' || row.outcome === 'unknown'
        || row.outcome === 'dispatching' && (row.expiresAt === undefined || row.expiresAt > now)
      ));
      const terminal = evidence.findLast((row) => row.kind === 'wake' && (row.outcome === 'accepted' || row.outcome === 'unknown'));
      const attemptRow = evidence.findLast((row) => row.kind === 'wake' && (
        row.outcome === 'accepted' || row.outcome === 'unknown' || row.outcome === 'failed'
      ));
      const attempt = attemptRow === undefined || seat === undefined ? undefined : deliveryAttempt(squarePath, attemptRow,
        { squarePath, recipient: seat.participant, actIndex: note.index });
      const kind: DeliveryHealthKind = presentation
        ? 'presented-not-delivered'
        : terminal?.outcome === 'accepted'
          ? 'wake-accepted'
          : terminal?.outcome === 'unknown'
            ? 'wake-unknown'
            : ageMs > opts.graceMs && seat?.wakeAddress === undefined
              ? 'unreachable'
              : 'awaiting';
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
    // The captured pending set is the ownership boundary: a candidate that was
    // not pending at the scan cannot become a health item during this read.
    return items;
  } catch (error) {
    if (error instanceof InternalSquareError && error.code === 'not_found')
      throw new SquareError('unavailable', `Square is unavailable at ${squarePath}`);
    throw error;
  } finally {
    await artifact.close();
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

function deliveryAttempt(squarePath: string, row: DeliveryEvidence,
  attention: WakeAttempt['attention'] = { squarePath, recipient: row.participant, actIndex: Number(row.activity.slice(4)) }): WakeAttempt | undefined {
  if (row.route?.kind === undefined || row.outcome === 'released' || row.outcome === 'dispatching') return undefined;
  return {
    at: row.at,
    attention,
    routeKind: row.route.kind,
    outcome: row.outcome as 'accepted' | 'unknown' | 'failed',
    attemptN: row.attemptN,
    ...(row.signature === undefined ? {} : { signature: row.signature }),
    ...(row.message === undefined ? {} : { message: row.message }),
    ...(row.diagnostic === undefined ? {} : { diagnostic: row.diagnostic }),
    ...(row.nativeObservations === undefined ? {} : { nativeObservations: row.nativeObservations }),
  };
}

function deliveryRelease(squarePath: string, row: DeliveryEvidence): WakeReleaseDiagnostic {
  return {
    at: row.at,
    attention: { squarePath, recipient: row.participant, actIndex: Number(row.activity.slice(4)) },
    routeKind: row.route?.kind,
    attemptN: row.attemptN,
    ...(row.signature === undefined ? {} : { signature: row.signature }),
    ...(row.message === undefined ? {} : { message: row.message }),
    ...(row.diagnostic === undefined ? {} : { diagnostic: row.diagnostic }),
  };
}

export async function doctorDeliveryHealth(
  squarePath: string,
  graceMs: number,
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const items = await classifyDeliveryHealth(squarePath, { graceMs, now, env });
  const artifact = createArtifactPort(squarePath);
  try {
    const { value: rows } = await artifact.read((facts) => facts.roster().flatMap((participant) => {
      const seat = facts.seat(participant.name);
      return seat === undefined ? [] : facts.deliveryEvidence(seat.participant, seat.generation);
    }));
    const releases = rows.filter((row) => row.kind === 'wake' && row.outcome === 'released')
      .map((row) => deliveryRelease(squarePath, row))
      .sort((left, right) => right.at - left.at);
    const nativeAttempts = rows.flatMap((row) => {
      if (row.kind !== 'wake' || row.nativeObservations?.length === 0) return [];
      const attempt = deliveryAttempt(squarePath, row);
      return attempt?.nativeObservations?.length ? [attempt] : [];
    }).sort((a, b) => Math.max(...b.nativeObservations!.map((row) => row.observedAt)) - Math.max(...a.nativeObservations!.map((row) => row.observedAt)));
    return renderDeliveryHealth(items, releases, now, nativeAttempts);
  } catch (error) {
    if (error instanceof InternalSquareError && error.code === 'not_found')
      throw new SquareError('unavailable', `Square is unavailable at ${squarePath}`);
    throw error;
  } finally {
    await artifact.close();
  }
}
