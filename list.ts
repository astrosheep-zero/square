import fs from 'node:fs';
import path from 'node:path';

import { probeSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { listPresentation } from './views.js';
import { formatRelativeTime } from './time.js';
import { participantIdentity, quoteShell } from './presentation.js';

interface SquareListItem {
  path: string;
  lastActiveAt: number;
  context: string[];
  participants: string[];
  activities: number;
}

const DEFAULT_LIST_DEPTH = 4;
const MAX_LIST_DEPTH = 16;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const LIST_DISCOVERY_BUDGET = 10_000;
const CONTEXT_PREVIEW_LINES = 2;
const PARTICIPANT_PREVIEW_COUNT = 3;
const DISPLAY_CHARACTER_LIMIT = 160;
const LIST_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);

function contextLines(lines: string[]): string[] {
  return lines.map((line) => line.trim()).filter(Boolean);
}

async function readSquareListItem(filePath: string, root: string): Promise<SquareListItem | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return null;
  }

  const square = await probeSquare(filePath);
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

interface SquareListDiscovery {
  items: SquareListItem[];
  stopped: boolean;
}

async function collectSquareList(root: string, maxDepth: number): Promise<SquareListDiscovery> {
  const items: SquareListItem[] = [];
  let examined = 0;
  let stopped = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (stopped) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      // Directory vanished or became unreadable mid-walk — skip it, don't abort the scan.
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (stopped) return;
      examined += 1;
      if (examined === LIST_DISCOVERY_BUDGET) stopped = true;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!stopped && depth < maxDepth && !LIST_SKIP_DIRS.has(entry.name)) await walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const item = await readSquareListItem(fullPath, root);
      if (item) items.push(item);
    }
  }

  await walk(root, 0);
  return { items: items.sort((a, b) => a.path.localeCompare(b.path)), stopped };
}

function characterPreview(value: string): string {
  const characters = Array.from(value);
  return characters.length <= DISPLAY_CHARACTER_LIMIT ? value : `${characters.slice(0, DISPLAY_CHARACTER_LIMIT - 1).join('')}…`;
}

function renderSquareList(items: SquareListItem[], stopped: boolean, depth: number, limit: number, after?: string): string {
  const page = after === undefined ? items : items.filter((item) => item.path.localeCompare(after) > 0);
  const shownItems = page.slice(0, limit);
  if (items.length === 0) {
    return [`(no squares found)`, ...(stopped ? [`○ discovery stopped after examining ${LIST_DISCOVERY_BUDGET} filesystem entries; results may be incomplete`] : [])].join('\n') + '\n';
  }

  const now = Date.now();
  const lines = ['squares'];
  for (const item of shownItems) {
    lines.push(`${item.activities > 0 ? '●' : '○'} ${characterPreview(item.path)} · ${formatRelativeTime(item.lastActiveAt, now)} · ${item.participants.length} in square · ${item.activities} activities`);

    const shownContext = item.context.slice(0, CONTEXT_PREVIEW_LINES);
    if (shownContext.length === 0) {
      lines.push('  context · (none)');
    } else {
      shownContext.forEach((line, index) => lines.push(`  ${index === 0 ? 'context' : '       '} · ${characterPreview(line)}`));
      const hiddenContext = item.context.length - shownContext.length;
      if (hiddenContext > 0) lines.push(`          · … ${hiddenContext} more ${hiddenContext === 1 ? 'line' : 'lines'}`);
    }

    const shownParticipants = item.participants.slice(0, PARTICIPANT_PREVIEW_COUNT);
    const hiddenParticipants = item.participants.length - shownParticipants.length;
    lines.push(`  participants · ${shownParticipants.length === 0 ? 'nobody' : shownParticipants.map((participant) => participantIdentity(characterPreview(participant))).join(' · ')}${hiddenParticipants > 0 ? ` · … ${hiddenParticipants} more` : ''}`);
  }
  const hiddenItems = page.length - shownItems.length;
  if (hiddenItems > 0) {
    const cursor = shownItems.at(-1)?.path;
    lines.push(stopped ? '  … more squares' : `  … ${hiddenItems} more ${hiddenItems === 1 ? 'square' : 'squares'}`);
    if (cursor !== undefined) lines.push(`» square list --depth ${depth} --limit ${limit} --after ${quoteShell(cursor)}`);
  }
  if (stopped) lines.push(`○ discovery stopped after examining ${LIST_DISCOVERY_BUDGET} filesystem entries; results may be incomplete`);
  return lines.join('\n') + '\n';
}

interface ListOptions {
  depth: number;
  limit: number;
  after?: string;
}

function parseListOptions(args: string[], usage: () => void): ListOptions {
  let depth = DEFAULT_LIST_DEPTH;
  let limit = DEFAULT_LIST_LIMIT;
  let after: string | undefined;

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (value === undefined || (option !== '--depth' && option !== '--limit' && option !== '--after')) {
      usage();
      return { depth, limit };
    }
    if (option === '--after') {
      if (after !== undefined || value.length === 0 || path.isAbsolute(value)) {
        usage();
        return { depth, limit };
      }
      after = value;
      continue;
    }
    if (!/^\d+$/.test(value)) {
      usage();
      return { depth, limit };
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || (option === '--depth' ? parsed > MAX_LIST_DEPTH : parsed === 0 || parsed > MAX_LIST_LIMIT)) {
      usage();
      return { depth, limit };
    }
    if (option === '--depth') depth = parsed;
    else limit = parsed;
  }
  return { depth, limit, after };
}

export async function cmdListSquares(args: string[], usage: () => void): Promise<void> {
  const options = parseListOptions(args, usage);
  const discovery = await collectSquareList(process.cwd(), options.depth);
  process.stdout.write(renderSquareList(discovery.items, discovery.stopped, options.depth, options.limit, options.after));
}
