import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { withFileLockSync } from './file-lock.js';
import { canonicalSquarePath, lookupParticipant, lookupSessionBindings } from './registry.js';
import { sameName, type InboxMembership } from './model.js';

interface PresentedRow {
  v: 2;
  ts: number;
  owner_id: string;
  square_path: string;
  name: string;
  act_index: number;
}

interface SelectedMembership {
  membership: InboxMembership;
  ownerId: string;
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_RETRY_MS = 10;

export function presentedPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SQUARE_PRESENTED || path.join(os.homedir(), '.square', 'presented.ndjsonl');
}

function rowKey(row: Pick<PresentedRow, 'owner_id' | 'square_path' | 'name' | 'act_index'>): string {
  return `${row.owner_id}\u0000${canonicalSquarePath(row.square_path)}\u0000${row.name.toLocaleLowerCase()}\u0000${row.act_index}`;
}

function readRows(filePath: string, now = Date.now()): PresentedRow[] {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const cutoff = now - RETENTION_MS;
  const rows: PresentedRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<PresentedRow>;
      if (
        parsed.v !== 2 ||
        typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts) ||
        typeof parsed.owner_id !== 'string' ||
        typeof parsed.square_path !== 'string' ||
        typeof parsed.name !== 'string' ||
        typeof parsed.act_index !== 'number' ||
        parsed.ts < cutoff
      ) {
        continue;
      }
      rows.push(parsed as PresentedRow);
    } catch {
      // The presented ledger is a disposable cache; malformed rows are ignored.
    }
  }
  return rows;
}

function writeRows(filePath: string, rows: PresentedRow[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), {
    mode: 0o600,
  });
  fs.renameSync(temp, filePath);
}

function membershipKey(membership: Pick<InboxMembership, 'squarePath' | 'name'>): string {
  return `${canonicalSquarePath(membership.squarePath)}\u0000${membership.name.toLocaleLowerCase()}`;
}

function attentionLockPath(filePath: string, membership: InboxMembership): string {
  const digest = createHash('sha256').update(membershipKey(membership)).digest('hex');
  return `${filePath}.${digest}.lock`;
}

function withAttentionLocks<T>(filePath: string, inbox: InboxMembership[], fn: () => T): T {
  const lockPaths = [...new Set(inbox.map((membership) => attentionLockPath(filePath, membership)))].sort();
  function acquire(index: number): T {
    if (index >= lockPaths.length) return fn();
    return withFileLockSync(
      lockPaths[index],
      { retryMs: LOCK_RETRY_MS, staleMs: LOCK_STALE_MS },
      () => acquire(index + 1),
    );
  }
  return acquire(0);
}

function ownerFor(sessionId: string, membership: InboxMembership): string {
  const squarePath = canonicalSquarePath(membership.squarePath);
  const binding = lookupSessionBindings(sessionId).find(
    (candidate) => candidate.squarePath === squarePath && sameName(candidate.name, membership.name)
  );
  return binding?.ownerId ?? `session:${sessionId}`;
}

function selectUnpresented(
  sessionId: string,
  inbox: InboxMembership[],
  rows: PresentedRow[]
): SelectedMembership[] {
  const known = new Set(rows.map(rowKey));
  return inbox.flatMap((membership) => {
    const ownerId = ownerFor(sessionId, membership);
    const notifications = membership.notifications.filter(
      (notification) =>
        !known.has(
          rowKey({
            owner_id: ownerId,
            square_path: membership.squarePath,
            name: membership.name,
            act_index: notification.actIndex,
          })
        )
    );
    return notifications.length === 0
      ? []
      : [{ membership: { ...membership, notifications }, ownerId }];
  });
}

export function hasPresentedForOwner(
  ownerId: string,
  squarePath: string,
  name: string,
  actIndex: number,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): boolean {
  const resolved = canonicalSquarePath(squarePath);
  return readRows(presentedPath(env), now).some(
    (row) =>
      row.owner_id === ownerId &&
      canonicalSquarePath(row.square_path) === resolved &&
      sameName(row.name, name) &&
      row.act_index === actIndex
  );
}

/** True when any current participant owner has already received this attention. */
export function hasPresentedAttention(
  squarePath: string,
  name: string,
  actIndex: number,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): boolean {
  const ownerIds = new Set(lookupParticipant(squarePath, name, now).map((binding) => binding.ownerId));
  if (ownerIds.size === 0) return false;
  return [...ownerIds].some((ownerId) => hasPresentedForOwner(ownerId, squarePath, name, actIndex, env, now));
}

/**
 * Serialize presentation only for the affected participants. Delivery runs
 * outside the short ledger-write lock, so unrelated owners never wait on an
 * adapter. A throwing callback leaves no row and remains unpresented.
 */
export function presentOnce<T>(
  sessionId: string,
  lookup: (sessionId: string) => InboxMembership[],
  deliver: (inbox: InboxMembership[]) => T,
  env: NodeJS.ProcessEnv = process.env,
  at = Date.now()
): T | undefined {
  const filePath = presentedPath(env);
  const initial = lookup(sessionId).filter((membership) => membership.notifications.length > 0);
  if (initial.length === 0) return undefined;
  const lockedMemberships = new Set(initial.map(membershipKey));

  return withAttentionLocks(filePath, initial, () => {
    const current = lookup(sessionId).filter((membership) => lockedMemberships.has(membershipKey(membership)));
    const selected = selectUnpresented(sessionId, current, readRows(filePath, at));
    if (selected.length === 0) return undefined;

    const result = deliver(selected.map(({ membership }) => membership));
    withFileLockSync(`${filePath}.lock`, { retryMs: LOCK_RETRY_MS, staleMs: LOCK_STALE_MS }, () => {
      const rows = readRows(filePath, at);
      const known = new Set(rows.map(rowKey));
      for (const { membership, ownerId } of selected) {
        for (const notification of membership.notifications) {
          const row: PresentedRow = {
            v: 2,
            ts: at,
            owner_id: ownerId,
            square_path: canonicalSquarePath(membership.squarePath),
            name: membership.name,
            act_index: notification.actIndex,
          };
          const key = rowKey(row);
          if (known.has(key)) continue;
          rows.push(row);
          known.add(key);
        }
      }
      writeRows(filePath, rows);
    });
    return result;
  });
}
