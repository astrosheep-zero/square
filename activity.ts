import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { SquareError, isSquareError, validateName } from './model.js';
import {
  expressHintLine,
  renderActivityBlocked,
  renderActivityLimit,
  renderExpressNoWait,
  renderExpressWaiting,
  renderPendingFeed,
  withPathOutput,
} from './presentation.js';
import { nowMs, SLEEP_MS } from './runtime.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { Square } from './square-wiring.js';
import { activityPresentation, resolveParticipant } from './views.js';
import { formatActivityId } from './square-core.js';
import { formatTimestamp } from './time.js';

export interface ActivityOptions {
  force?: boolean;
  forceCommand: string;
  noWait?: boolean;
  reach?: import('./model.js').Reach;
  reply?: number;
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

  const reader = await openSquare(squarePath, { clock: nowMs });
  let knownName: string;
  try {
    knownName = (await resolveParticipant(reader, name)).name;
  } catch (err) {
    await closeOpenSquare(reader);
    if (isSquareError(err)) {
      if (err.code === 'unknown_participant' || err.code === 'invalid_args') {
        const draftPath = saveActivityDraft(squarePath, name, rawInput);
        process.stderr.write(err.message + '\n');
        process.stderr.write(`draft kept: ${draftPath}\n`);
        process.exit(2);
      }
      process.stderr.write(err.message + '\n');
      process.exit(err.code === 'not_found' ? 1 : 2);
    }
    throw err;
  }
  await closeOpenSquare(reader);
  const body = rawInput.trim();
  const force = opts.force ?? false;
  const noWait = opts.noWait ?? false;
  const reach = opts.reach === 'bell' ? 'bell' : undefined;
  let announcedWait: 'throttled' | 'held' | undefined;
  const square = await Square.at({ path: squarePath, clock: nowMs });
  try {
    const participant = await square.join(name);
    while (true) {
      const beforeSquare = await openSquare(squarePath, { clock: nowMs });
      const before = await activityPresentation(beforeSquare, knownName).finally(() => closeOpenSquare(beforeSquare));
      const pendingPublic = before.pendingPublic;
      const pendingRoomChanges = before.pendingRoomChanges;
      try {
        const result = await participant.express(body, {
          force,
          ...(reach === undefined ? {} : { reach }),
          ...(opts.reply === undefined ? {} : { reply: formatActivityId(opts.reply) }),
        });
        try {
        } catch {
          // Compatibility wake is post-commit and cannot undo the activity.
        }
        const freshSquare = await openSquare(squarePath, { clock: nowMs });
        const fresh = await activityPresentation(freshSquare, knownName).finally(() => closeOpenSquare(freshSquare));
        const headerCount = fresh.participantCount;
        const held = fresh.held;
        const ownActCount = fresh.ownActivityCount;
        const hasPending = pendingPublic.length > 0 || pendingRoomChanges.length > 0;
        const pending = hasPending ? `\n\n${renderPendingFeed([...fresh.activities], [...pendingPublic], [...pendingRoomChanges], knownName, fresh.state)}` : '';
        const hint = expressHintLine(ownActCount);
        const confirmation = `● heads turn your way — #${ownActCount}`;
        const withHint = hint ? `${confirmation}\n${hint}` : confirmation;
        process.stdout.write(withPathOutput(squarePath, withHint + pending, { participantCount: headerCount, held }));
        return;
      } catch (error) {
        if (!(error instanceof SquareError)) throw error;
        const freshSquare = await openSquare(squarePath, { clock: nowMs });
        const fresh = await activityPresentation(freshSquare, knownName).finally(() => closeOpenSquare(freshSquare));
        const headerCount = fresh.participantCount;
        const held = fresh.held;

        if (error.code === 'behind') {
        const draftPath = saveActivityDraft(squarePath, name, rawInput);
        process.stdout.write(
          renderActivityBlocked({
            squarePath,
            name: knownName,
            forceCommand: opts.forceCommand,
            activitySummaries: [],
            unreadRoomChanges: [...pendingRoomChanges],
            draftPath,
            participantCount: headerCount,
            held,
          })
        );
        process.exit(1);
        return;
        }
        if (error.code === 'capped') {
        process.stdout.write(
          renderActivityLimit({
            squarePath,
            name: knownName,
            count: fresh.ownActivityCount,
            ...(fresh.hardCap === null ? {} : { hardCap: fresh.hardCap }),
            draftPath: saveActivityDraft(squarePath, name, rawInput),
            participantCount: headerCount,
            held,
          })
        );
        process.exit(1);
        return;
        }
        if (error.code === 'throttled') {
          const delayMs = error.facts?.retryAfterMs ?? SLEEP_MS;
        if (noWait) {
          const draftPath = saveActivityDraft(squarePath, name, rawInput);
          process.stdout.write(renderExpressNoWait({ squarePath, name: knownName, reason: 'throttled', delayMs, draftPath, participantCount: headerCount, held }));
          process.exit(1);
        }
        if (announcedWait !== 'throttled') {
          process.stdout.write(renderExpressWaiting({ reason: 'throttled', delayMs }) + '\n');
          announcedWait = 'throttled';
        }
        await sleep(delayMs);
        continue;
        }
        if (error.code === 'held') {
          const holdReason = fresh.holdReason;
        if (noWait) {
          const draftPath = saveActivityDraft(squarePath, name, rawInput);
          process.stdout.write(renderExpressNoWait({ squarePath, name: knownName, reason: 'held', holdReason, draftPath, participantCount: headerCount, held }));
          process.exit(1);
        }
        if (announcedWait !== 'held') {
          process.stdout.write(renderExpressWaiting({ reason: 'held' }) + '\n');
          announcedWait = 'held';
        }
        await sleep(SLEEP_MS);
        continue;
        }
        if (error.code === 'bell_quota') {
          const nextAt = nowMs() + (error.facts?.retryAfterMs ?? 1);
        process.stdout.write(
          withPathOutput(
            squarePath,
            [`✕ the bell stays quiet for now`, `  · you can ring it again at ${formatTimestamp(nextAt)}`].join('\n'),
            { participantCount: headerCount, held }
          )
        );
        process.exit(1);
        return;
        }
        throw error;
      }
    }
  } finally {
    await square.close();
  }
}
