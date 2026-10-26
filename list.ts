import fs from 'node:fs';
import path from 'node:path';

import { createArtifactPort } from './artifact.js';
import { listPresentation } from './views.js';
import { SquareError } from './model.js';
import type { DiscoveryResult, DiscoveryOptions, OpenOptions, OperationControl, SquareListItem } from './square-facade.js';

export const DEFAULT_LIST_DEPTH = 4;
export const MAX_LIST_DEPTH = 16;
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;
const LIST_DISCOVERY_BUDGET = 10_000;
const LIST_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);

async function readSquareListItem(filePath: string, root: string, options: OpenOptions, control?: OperationControl): Promise<SquareListItem | null> {
  if (!filePath.endsWith('.square')) return null;
  try {
    control?.signal?.throwIfAborted();
    const stat = await fs.promises.stat(filePath);
    const artifact = createArtifactPort(filePath, undefined, control?.signal);
    let projection;
    try { projection = (await artifact.read(listPresentation, control?.signal)).value; }
    finally { await artifact.close(); }
    return {
      path: path.relative(root, filePath) || path.basename(filePath),
      lastActiveAt: stat.mtimeMs,
      context: [...projection.context].map((line) => line.trim()).filter(Boolean),
      participants: [...projection.participants],
      activities: projection.activities,
    };
  } catch (error) {
    control?.signal?.throwIfAborted();
    // A vanished, unreadable or undecodable candidate does not abort discovery.
    return null;
  }
}

/** Bounded deterministic discovery for the public resource API. */
export async function discoverSquares(root: string, options: DiscoveryOptions = {}, control?: OperationControl, openOptions: OpenOptions = {}): Promise<DiscoveryResult> {
  const depth = options.depth ?? DEFAULT_LIST_DEPTH;
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > MAX_LIST_DEPTH
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT
    || (options.after !== undefined && (options.after.length === 0 || path.isAbsolute(options.after)))) {
    throw new SquareError('invalid_args', 'Invalid discovery depth, limit or relative cursor');
  }
  const items: SquareListItem[] = [];
  let examined = 0;
  let stopped = false;

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
        const item = await readSquareListItem(fullPath, root, openOptions, control);
        if (item !== null) items.push(item);
      }
    }
  }

  await walk(root, 0);
  const page = items.sort((a, b) => a.path.localeCompare(b.path))
    .filter((item) => options.after === undefined || item.path.localeCompare(options.after) > 0);
  const selected = page.slice(0, limit);
  const remaining = page.length - selected.length;
  return { items: selected, total: items.length, stopped, remaining, ...(remaining > 0 ? { next: selected.at(-1)!.path } : {}) };
}
