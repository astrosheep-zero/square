import fs from 'node:fs';
import path from 'node:path';

import { probeSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { listPresentation } from './views.js';
import { formatRelativeTime } from './time.js';
import { participantIdentity } from './presentation.js';

interface SquareListItem {
  path: string;
  lastActiveAt: number;
  context: string[];
  participants: string[];
  activities: number;
}

const DEFAULT_LIST_DEPTH = 4;
const CONTEXT_PREVIEW_LINES = 2;
const PARTICIPANT_PREVIEW_COUNT = 3;
const LIST_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);

function contextLines(lines: string[]): string[] {
  return lines.map((line) => line.trim()).filter(Boolean);
}

async function readSquareListItem(filePath: string, root: string): Promise<SquareListItem | null> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  const square = probeSquare(filePath);
  if (square === undefined) return null;
  const projection = await listPresentation(square).finally(() => closeOpenSquare(square));

  const relative = path.relative(root, filePath) || path.basename(filePath);
  return {
    path: relative,
    lastActiveAt: stat.mtimeMs,
    context: contextLines([...projection.context]),
    participants: [...projection.participants],
    activities: projection.activities,
  };
}

async function collectSquareList(root: string, maxDepth: number): Promise<SquareListItem[]> {
  const items: SquareListItem[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
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
        if (depth < maxDepth && !LIST_SKIP_DIRS.has(entry.name)) await walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const item = await readSquareListItem(fullPath, root);
      if (item) items.push(item);
    }
  }

  await walk(root, 0);
  return items.sort((a, b) => a.path.localeCompare(b.path));
}

function renderSquareList(items: SquareListItem[]): string {
  if (items.length === 0) return '(no squares found)\n';

  const now = Date.now();
  const lines = ['squares'];
  for (const item of items) {
    lines.push(`${item.activities > 0 ? '●' : '○'} ${item.path} · ${formatRelativeTime(item.lastActiveAt, now)} · ${item.participants.length} in square · ${item.activities} activities`);

    const shownContext = item.context.slice(0, CONTEXT_PREVIEW_LINES);
    if (shownContext.length === 0) {
      lines.push('  context · (none)');
    } else {
      shownContext.forEach((line, index) => lines.push(`  ${index === 0 ? 'context' : '       '} · ${line}`));
      const hiddenContext = item.context.length - shownContext.length;
      if (hiddenContext > 0) lines.push(`          · … ${hiddenContext} more ${hiddenContext === 1 ? 'line' : 'lines'}`);
    }

    const shownParticipants = item.participants.slice(0, PARTICIPANT_PREVIEW_COUNT);
    const hiddenParticipants = item.participants.length - shownParticipants.length;
    lines.push(`  participants · ${shownParticipants.length === 0 ? 'nobody' : shownParticipants.map(participantIdentity).join(' · ')}${hiddenParticipants > 0 ? ` · … ${hiddenParticipants} more` : ''}`);
  }
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

export async function cmdListSquares(args: string[], usage: () => void): Promise<void> {
  const maxDepth = parseMaxDepth(args, usage);
  process.stdout.write(renderSquareList(await collectSquareList(process.cwd(), maxDepth)));
}
