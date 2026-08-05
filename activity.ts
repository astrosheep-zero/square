import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { loadSquare } from './artifact.js';
import { SquareError, validateName } from './model.js';
import {
  expressHintLine,
  renderActivityBlocked,
  renderActivityLimit,
  renderExpressNoWait,
  renderExpressWaiting,
  renderPendingFeed,
  withPathOutput,
} from './presentation.js';
import { currentHold, inSquareCount, nowMs, SLEEP_MS, resolveRosterName } from './runtime.js';
import { decideAct, resolveKnownName } from './decisions.js';
import { execute } from './square-application.js';
import { formatTimestamp } from './time.js';

export interface ActivityOptions {
  force?: boolean;
  forceCommand: string;
  noWait?: boolean;
  reach?: import('./model.js').Reach;
}

function draftDirFor(squarePath: string): string {
  return path.join(path.dirname(squarePath), 'drafts');
}

function draftTimestamp(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:.]/g, '-');
}

function draftNamePart(name: string): string {
  return name.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'participant';
}

export function saveActivityDraft(squarePath: string, name: string, body: string): string {
  const draftDir = draftDirFor(squarePath);
  fs.mkdirSync(draftDir, { recursive: true });
  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 8);
  const base = `${draftTimestamp(nowMs())}-${draftNamePart(name)}-${hash}`;
  for (let i = 0; ; i++) {
    const filename = `${base}${i === 0 ? '' : `-${i}`}.md`;
    const target = path.join(draftDir, filename);
    try {
      fs.writeFileSync(target, body, { flag: 'wx' });
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

export async function cmdActivity(
  squarePath: string,
  name: string,
  activity: string,
  resolveBody: (arg: string) => string,
  opts: ActivityOptions
): Promise<void> {
  validateName(name);
  const rawInput = String(resolveBody(activity)).replace(/\r\n/g, '\n');

  let doc;
  try {
    doc = loadSquare(squarePath);
  } catch (err) {
    if (err instanceof SquareError) {
      process.stderr.write(err.message + '\n');
      process.exit(err.code === 'not_found' ? 1 : 2);
    }
    throw err;
  }
  const knownName = resolveRosterName(doc, name);
  if (knownName === undefined) {
    const draftPath = saveActivityDraft(squarePath, name, rawInput);
    const expected = doc.acts.filter((act) => act.kind === 'join').map((act) => act.actor);
    process.stderr.write(`Unknown participant "${name}". Expected one of: ${expected.join(', ')}.\n`);
    process.stderr.write(`draft kept: ${draftPath}\n`);
    process.exit(2);
  }

  const body = rawInput.trim();
  const force = opts.force ?? false;
  const noWait = opts.noWait ?? false;
  const reach =
    opts.reach === undefined
      ? undefined
      : opts.reach === 'bell'
        ? 'bell'
        : { beside: resolveKnownName(doc, opts.reach.beside) };
  let announcedWait: 'throttled' | 'held' | undefined;

  while (true) {
    const committed = await execute<ReturnType<typeof decideAct>>(squarePath, {
      type: 'say',
      name,
      body,
      force,
      now: nowMs(),
      ...(reach === undefined ? {} : { reach }),
    });
    const decision = committed.result;
    const freshDoc = loadSquare(squarePath);
    const headerCount = inSquareCount(freshDoc);
    const held = currentHold(freshDoc.acts).active;

    switch (decision.type) {
      case 'sent': {
        const hasPending = decision.pendingPublic.length > 0 || decision.pendingRoomChanges.length > 0;
        const pending = hasPending ? `\n\n${renderPendingFeed(freshDoc.acts, decision.pendingPublic, decision.pendingRoomChanges)}` : '';
        const hint = expressHintLine(decision.ownActCount);
        const withHint = hint ? `${decision.confirmation}\n${hint}` : decision.confirmation;
        process.stdout.write(withPathOutput(squarePath, withHint + pending, { participantCount: headerCount, held }));
        return;
      }
      case 'blocked': {
        const draftPath = saveActivityDraft(squarePath, name, rawInput);
        process.stdout.write(
          renderActivityBlocked({
            squarePath,
            name: knownName,
            forceCommand: opts.forceCommand,
            activitySummaries: decision.activitySummaries,
            unreadRoomChanges: decision.unreadRoomChanges,
            draftPath,
            participantCount: headerCount,
            held,
          })
        );
        process.exit(1);
        break;
      }
      case 'capped': {
        process.stdout.write(
          renderActivityLimit({
            squarePath,
            name: knownName,
            count: decision.count,
            hardCap: decision.hardCap,
            draftPath: saveActivityDraft(squarePath, name, rawInput),
            participantCount: headerCount,
            held,
          })
        );
        process.exit(1);
        break;
      }
      case 'throttled': {
        if (noWait) {
          const draftPath = saveActivityDraft(squarePath, name, rawInput);
          process.stdout.write(renderExpressNoWait({ squarePath, name: knownName, reason: 'throttled', delayMs: decision.delayMs, draftPath, participantCount: headerCount, held }));
          process.exit(1);
        }
        if (announcedWait !== 'throttled') {
          process.stdout.write(renderExpressWaiting({ reason: 'throttled', delayMs: decision.delayMs }) + '\n');
          announcedWait = 'throttled';
        }
        await sleep(decision.delayMs);
        break;
      }
      case 'held': {
        if (noWait) {
          const draftPath = saveActivityDraft(squarePath, name, rawInput);
          process.stdout.write(renderExpressNoWait({ squarePath, name: knownName, reason: 'held', holdReason: decision.reason, draftPath, participantCount: headerCount, held }));
          process.exit(1);
        }
        if (announcedWait !== 'held') {
          process.stdout.write(renderExpressWaiting({ reason: 'held' }) + '\n');
          announcedWait = 'held';
        }
        await sleep(SLEEP_MS);
        break;
      }
      case 'bell_quota': {
        process.stdout.write(
          withPathOutput(
            squarePath,
            [`✕ the bell stays quiet for now`, `  · you can ring it again at ${formatTimestamp(decision.nextAt)}`].join('\n'),
            { participantCount: headerCount, held }
          )
        );
        process.exit(1);
      }
    }
  }
}
