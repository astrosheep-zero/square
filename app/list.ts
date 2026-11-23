import fs from 'node:fs';
import path from 'node:path';
import { squareLocation, type OperationControl, type SquareLocation } from '../core/neutral.js';
import { deliveryLedgerLocation } from '../ledger/delivery-ledger.js';

import { createArtifactPort } from '../artifact/artifact.js';
import { nameKey, type Seat } from '../core/model.js';
import { listPresentation } from '../core/observations.js';
import { DEFAULT_LIST_DEPTH, DEFAULT_LIST_LIMIT } from '../core/square-core.js';
import { canonicalPath } from '../storage/canonical-path.js';
import { parseOperation, type DiscoveryOptions } from '../core/operation-inputs.js';
import { readLedgerMutedUntil, readSquareSeatMutes, seatMuteKey } from './square-notification-mute.js';

export interface SquareListItem {
  readonly joined?: readonly { readonly name: string; readonly pending: number; readonly mutedUntil?: number }[];
  readonly path: string;
  readonly lastActiveAt: number;
  readonly context: readonly string[];
  readonly participants: readonly string[];
  readonly activities: number;
}
export interface DiscoveryResult {
  readonly items: readonly SquareListItem[];
  readonly stopped: boolean;
  readonly total: number;
  readonly remaining: number;
  readonly next?: string;
  /** Active all-owner delivery hold, when an explicit ledger was read. */
  readonly ledgerMutedUntil?: number;
}
const LIST_DISCOVERY_BUDGET = 10_000;
const LIST_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);

async function readSquareListItem(filePath: string, root: string, options: DiscoveryOptions, control?: OperationControl): Promise<SquareListItem | null> {
  if (!filePath.endsWith('.square')) return null;
  try {
    control?.signal?.throwIfAborted();
    const stat = await fs.promises.stat(filePath);
    const artifact = createArtifactPort(filePath, undefined, control?.signal);
    try {
      const projection = (await artifact.read(facts => listPresentation(facts, options.owner), control?.signal)).value;
      const joined = projection.joined;
      let current = new Map<string, Seat | undefined>(), mutes = new Map<string, number>();
      if (joined?.length && options.ledgerLocation !== undefined) {
        const location = await canonicalPath(filePath);
        const captured: Seat[] = joined.map(item => ({ participant: item.name, owner: item.seat.owner,
          generation: item.seat.generation, attachment: 'attached' }));
        mutes = new Map(await readSquareSeatMutes(location, captured, options.clock ?? Date.now, control?.signal, options.ledgerLocation));
        current = (await artifact.read(facts => new Map(captured.map(seat =>
          [nameKey(seat.participant), facts.seat(seat.participant)] as const)), control?.signal)).value;
      }
      return {
        path: path.relative(root, filePath) || path.basename(filePath),
        lastActiveAt: stat.mtimeMs,
        context: [...projection.context].map((line) => line.trim()).filter(Boolean),
        participants: [...projection.participants],
        activities: projection.activities,
        ...(joined === undefined ? {} : { joined: joined.map(item => {
          const seat = current.get(nameKey(item.name));
          const mutedUntil = seat?.owner === item.seat.owner && seat.generation === item.seat.generation
            ? mutes.get(seatMuteKey(seat)) : undefined;
          return { name: item.name, pending: item.pending, ...(mutedUntil === undefined ? {} : { mutedUntil }) };
        }) }),
      };
    } finally { await artifact.close(); }
  } catch (error) {
    control?.signal?.throwIfAborted();
    // A vanished, unreadable or undecodable candidate does not abort discovery.
    return null;
  }
}

/** Bounded deterministic discovery for the public resource API. */
export async function discoverSquares(root: string, options: DiscoveryOptions = {}, control?: OperationControl): Promise<DiscoveryResult> {
  const depth = options.depth ?? DEFAULT_LIST_DEPTH;
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const items: SquareListItem[] = [];
  let examined = 0;
  let stopped = false;
  const ledgerMutedUntil = options.ledgerLocation === undefined ? undefined
    : await readLedgerMutedUntil(options.ledgerLocation, options.clock ?? Date.now, control?.signal);

  async function walk(dir: string, level: number): Promise<void> {
    control?.signal?.throwIfAborted();
    if (stopped) return;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { control?.signal?.throwIfAborted(); return; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      control?.signal?.throwIfAborted();
      if (stopped) return;
      if (++examined === LIST_DISCOVERY_BUDGET) stopped = true;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!stopped && level < depth && !LIST_SKIP_DIRS.has(entry.name)) await walk(fullPath, level + 1);
      } else if (entry.isFile()) {
        const item = await readSquareListItem(fullPath, root, options, control);
        if (item !== null) items.push(item);
      }
    }
  }

  await walk(root, 0);
  const page = items.sort((a, b) => a.path.localeCompare(b.path))
    .filter((item) => options.after === undefined || item.path.localeCompare(options.after) > 0);
  const selected = page.slice(0, limit);
  const remaining = page.length - selected.length;
  return { items: selected, total: items.length, stopped, remaining,
    ...(remaining > 0 ? { next: selected.at(-1)!.path } : {}),
    ...(ledgerMutedUntil === undefined ? {} : { ledgerMutedUntil }) };
}

export async function discover(input: SquareLocation, options: DiscoveryOptions = {}, control?: OperationControl) {
  options = parseOperation('list', options);
  if (input.path !== undefined) squareLocation(input);
  return discoverSquares(input.cwd ?? process.cwd(), {
    ...options,
    ledgerLocation: options.ledgerLocation ?? deliveryLedgerLocation(),
    clock: options.clock ?? Date.now,
  }, control);
}
