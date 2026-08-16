import fs from 'node:fs';
import path from 'node:path';

import { probeSquare } from './artifact.js';
import { inSquareCount, publicActs } from './runtime.js';
import { formatRelativeTime } from './time.js';

interface SquareListItem {
  path: string;
  lastActiveAt: number;
  participants: number;
  activities: number;
}

const DEFAULT_LIST_DEPTH = 4;
const LIST_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);

function readSquareListItem(filePath: string, root: string): SquareListItem | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  const doc = probeSquare(filePath);
  if (doc === undefined) return null;

  const relative = path.relative(root, filePath) || path.basename(filePath);
  return {
    path: relative,
    lastActiveAt: stat.mtimeMs,
    participants: inSquareCount(doc),
    activities: publicActs(doc.acts).filter((act) => act.kind === 'say').length,
  };
}

function collectSquareList(root: string, maxDepth: number): SquareListItem[] {
  const items: SquareListItem[] = [];

  function walk(dir: string, depth: number): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Directory vanished or became unreadable mid-walk — skip it, don't abort the scan.
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !LIST_SKIP_DIRS.has(entry.name)) walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const item = readSquareListItem(fullPath, root);
      if (item) items.push(item);
    }
  }

  walk(root, 0);
  return items.sort((a, b) => a.path.localeCompare(b.path));
}

function renderSquareList(items: SquareListItem[]): string {
  if (items.length === 0) return '(no squares found)\n';

  const now = Date.now();
  const lines = [
    'squares',
    ...items.map((item) => `${item.activities > 0 ? '●' : '○'} ${item.path} · ${formatRelativeTime(item.lastActiveAt, now)} · ${item.participants} in square · ${item.activities} activities`),
  ];
  return lines.join('\n') + '\n';
}

function parseMaxDepth(args: string[], usage: () => void): number {
  if (args.length === 0) return DEFAULT_LIST_DEPTH;
  if (args.length !== 2 || args[0] !== '--depth' || !/^\d+$/.test(args[1])) {
    usage();
    return DEFAULT_LIST_DEPTH;
  }

  const depth = Number(args[1]);
  if (!Number.isSafeInteger(depth)) {
    usage();
    return DEFAULT_LIST_DEPTH;
  }
  return depth;
}

export function cmdListSquares(args: string[], usage: () => void): void {
  const maxDepth = parseMaxDepth(args, usage);
  process.stdout.write(renderSquareList(collectSquareList(process.cwd(), maxDepth)));
}
