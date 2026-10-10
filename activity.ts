import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SquareError, isSquareError, validateName } from './model.js';
import {
  expressHintLine,
  formatRefusal,
  renderActivityBlocked,
  renderActivityLimit,
  renderActivityUncertain,
  renderExpressNoWait,
  renderExpressWaiting,
  renderPendingFeed,
  joinRecoveryCommand,
  participantIdentity,
  participantsRecoveryCommand,
  participantCommandPrefix,
  commandPrefix,
  quoteShell,
  takeoverRecoveryLines,
  withPathOutput,
} from './presentation.js';
import { nowMs, SLEEP_MS } from './runtime.js';
import { unreadActivitySummaries } from './decisions.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { createSquareApplication } from './square-application.js';
import { activityPresentation, resolveParticipant } from './views.js';
import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { formatDuration } from './time.js';
import { style } from './tty-style.js';
import { hostLedgerForEnv } from './registry.js';
import { createDefaultWakeTransport } from './notifications.js';

export interface ActivityOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  force?: boolean;
  noWait?: boolean;
  noMention?: boolean;
  mentions?: readonly string[];
  reach?: import('./model.js').Reach;
  reply?: string;
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

/** Retry commands preserve the original reach, reply, wait and force choices. */
export function activityRetryCommand(squarePath: string, name: string, opts: ActivityOptions, force = opts.force ?? false): string {
  const reach = opts.reach === 'bell' ? ' --bell'
    : opts.mentions?.length ? opts.mentions.map((target) => ` --mention ${quoteShell(target)}`).join('')
      : opts.noMention === true ? ' --no-mention'
        : '';
  const replyIndex = opts.reply === undefined ? undefined : parseActivityId(opts.reply);
  const reply = opts.reply === undefined ? '' : ` --reply ${replyIndex === undefined ? quoteShell(opts.reply) : formatActivityId(replyIndex)}`;
  return `${participantCommandPrefix(squarePath, name)} express${force ? ' --force' : ''}${opts.noWait ? ' --no-wait' : ''}${reach}${reply} -`;
}

/**
 * A recipient conflict is the speaker's to edit: the printed recovery drops every
 * mention flag (or keeps the bell) so the retry never repeats the rejected target.
 */
function mentionRepairCommand(squarePath: string, name: string, opts: ActivityOptions, bell: boolean): string {
  const replyIndex = opts.reply === undefined ? undefined : parseActivityId(opts.reply);
  const reply = opts.reply === undefined ? '' : ` --reply ${replyIndex === undefined ? quoteShell(opts.reply) : formatActivityId(replyIndex)}`;
  const reach = bell ? ' --bell' : ' --no-mention';
  return `${participantCommandPrefix(squarePath, name)} express${opts.force ? ' --force' : ''}${opts.noWait ? ' --no-wait' : ''}${reach}${reply} -`;
}

/** A body that is nothing but *gestures* reads as an action, not as speech. */
function isGestureOnly(body: string): boolean {
  return /\*[^*]*\*/.test(body) && body.replace(/\*[^*]*\*/g, '').trim() === '';
}

export async function cmdActivity(
  squarePath: string,
  name: string,
  activity: string,
  resolveBody: (arg: string) => string,
  opts: ActivityOptions
): Promise<void> {
  const rawInput = String(resolveBody(activity));
  const env = { ...(opts.env ?? process.env) };
  const hostLedger = hostLedgerForEnv(env);
  const retryCommand = activityRetryCommand(squarePath, name, opts);
  const forceCommand = activityRetryCommand(squarePath, name, opts, true);
  let knownName = name;
  let callerMissing = false;
  let expressAttempted = false;
  let landedId: ActivityId | undefined;
  let announcedWait: 'throttled' | 'held' | undefined;

  async function presentation() {
    const square = await openSquare(squarePath, { clock: nowMs, env, hostLedger });
    try { return await activityPresentation(square, knownName); }
    finally { await closeOpenSquare(square); }
  }

  try {
    validateName(name);
    for (const target of opts.mentions ?? []) validateName(target);
    if (opts.reply !== undefined && parseActivityId(opts.reply) === undefined) {
      throw new SquareError('invalid_args', 'Invalid --reply: expected an activity id like act/12');
    }
    const reader = await openSquare(squarePath, { clock: nowMs, env, hostLedger });
    try { knownName = (await resolveParticipant(reader, name)).name; }
    catch (error) {
      // The caller name was validated above; invalid_args here means it is absent
      // from the roster. Keep the join recovery distinct from recipient validation.
      callerMissing = isSquareError(error) && error.code === 'invalid_args';
      throw error;
    }
    finally { await closeOpenSquare(reader); }
    const application = createSquareApplication({ cwd: opts.cwd ?? process.cwd(), env, squarePath, clock: nowMs, hostLedger, wakeTransport: await createDefaultWakeTransport(hostLedger, nowMs), participant: name });
    // The caller is roster-known at this point, so a landed join act is always a
    // re-entry after done — never a first arrival. Announce it; a silent return
    // would make `done` a fake exit.
    const entry = await application.join();
    const reentered = entry.kind === 'joined' && entry.activity !== null;
    const before = await presentation();
    const pendingPublic = before.pendingPublic;
    expressAttempted = true;
    const landed = await application.express(rawInput.replace(/\r\n/g, '\n').trim(), {
      force: opts.force ?? false,
      noWait: opts.noWait ?? false,
      ...(opts.mentions === undefined ? {} : { mentions: opts.mentions }),
      ...(opts.noMention === undefined ? {} : { noMention: opts.noMention }),
      ...(opts.reach === undefined ? {} : { reach: opts.reach }),
      // The action boundary validates the raw id before attempting a commit.
      ...(opts.reply === undefined ? {} : { reply: opts.reply as ActivityId }),
    }, {
      onProgress: (progress) => {
        if (announcedWait === progress.reason) return;
        const delayMs = progress.delayMs ?? SLEEP_MS;
        process.stdout.write(renderExpressWaiting({
          reason: progress.reason,
          ...(progress.reason === 'throttled' ? { delayMs } : {}),
          ...(progress.holder === undefined ? {} : { holder: progress.holder }),
          ...(progress.holdReason === undefined ? {} : { holdReason: progress.holdReason }),
        }) + '\n');
        announcedWait = progress.reason;
      },
    });
    landedId = landed.activity.id;
    const fresh = await presentation();
    const headerCount = fresh.participantCount;
    const held = fresh.held;
    const ownActCount = fresh.ownActivityCount;
    const hasPending = pendingPublic.length > 0;
    const pendingSpeaker = pendingPublic[0]?.actor;
    const pendingLead = pendingSpeaker === undefined
      ? ''
      : `▲ while you spoke, ${participantIdentity(pendingSpeaker)} said something behind you\n\n`;
    const pending = hasPending ? `\n\n${pendingLead}${renderPendingFeed([...fresh.activities], [...pendingPublic], knownName, fresh.state)}` : '';
    const hint = expressHintLine(ownActCount);
    const receiptId = landed.activity.id;
    const capCount = fresh.hardCap === null ? '' : ` · ${ownActCount}/${fresh.hardCap}`;
    const confirmation = landed.activity.reach === 'bell'
      ? `● you ring the bell — everyone turns · ${receiptId}${style('dim', capCount)}`
      : `● ${landed.activity.mentions.length > 0
          ? `you walk over to ${landed.activity.mentions.map((target) => participantIdentity(target)).join(', ')}`
          : isGestureOnly(landed.activity.body ?? '')
            ? 'your gesture lands'
            : 'your words land'} — ${receiptId}${style('dim', capCount)}`;
    const withHint = hint ? `${confirmation}\n${style('dim', hint)}` : confirmation;
    const reentry = reentered ? '● you stepped back into the square\n' : '';
    process.stdout.write(withPathOutput(squarePath, reentry + withHint + pending, { participantCount: headerCount, held }));
  } catch (error) {
    // Save before any recovery read: even a broken artifact must not eat the body.
    const draftPath = saveActivityDraft(squarePath, name, rawInput);
    const confirmedUnsent = landedId === undefined && (!expressAttempted || (isSquareError(error) && error.facts?.activityUnsent === true));
    const fresh = await presentation().catch(() => undefined);
    const output = { squarePath, name: knownName, draftPath, participantCount: fresh?.participantCount, held: fresh?.held };
    if (!confirmedUnsent) {
      process.stderr.write(renderActivityUncertain({ ...output, landedId, detail: error instanceof Error ? error.message : String(error) }));
      process.exit(1);
      return;
    }
    if (isSquareError(error) && fresh !== undefined) {
      if (error.code === 'behind') {
        process.stdout.write(renderActivityBlocked({
          ...output,
          retryCommand,
          forceCommand,
          activitySummaries: unreadActivitySummaries(fresh.state, knownName, nowMs()),
        }));
        process.exit(1);
        return;
      }
      if (error.code === 'capped') {
        process.stdout.write(renderActivityLimit({
          ...output,
          count: fresh.ownActivityCount,
          ...(fresh.hardCap === null ? {} : { hardCap: fresh.hardCap }),
        }));
        process.exit(1);
        return;
      }
      if (error.code === 'throttled' || error.code === 'held') {
        process.stdout.write(renderExpressNoWait({
          ...output,
          reason: error.code,
          delayMs: error.facts?.retryAfterMs ?? SLEEP_MS,
          ...(error.facts?.holder === undefined ? {} : { holder: error.facts.holder }),
          ...(error.facts?.holdReason === undefined ? {} : { holdReason: error.facts.holdReason }),
          retryCommand,
        }));
        process.exit(1);
        return;
      }
      if (error.code === 'bell_quota') {
        process.stdout.write(withPathOutput(squarePath, [
          '✕ the bell stays quiet for now',
          `  · you can ring it again in ${formatDuration(error.facts?.retryAfterMs ?? 1)}`,
          `· draft kept: ${draftPath}`,
          `  · retry when the bell is ready:`,
          `${retryCommand} < ${quoteShell(draftPath)}`,
        ].join('\n'), output));
        process.exit(1);
        return;
      }
    }
    const lines = [error instanceof Error ? error.message : String(error), `· draft kept: ${draftPath}`];
    const reason = isSquareError(error) ? error.facts?.reason : undefined;
    // `not_standing` is a flag mention; the body-scan and bell conflicts carry an @name in the draft.
    const mentionRepair = reason === 'bell_mention_conflict' ? { bell: true, fromBody: true }
      : reason === 'unmatched_mention' ? { bell: false, fromBody: true }
        : reason === 'not_standing' ? { bell: false, fromBody: false }
          : undefined;
    if (isSquareError(error)) {
      if (callerMissing || error.code === 'unknown_participant' || error.code === 'not_joined') lines.push(joinRecoveryCommand(squarePath, name));
      if (error.code === 'already_joined') lines.push(...takeoverRecoveryLines(squarePath, name));
      if (mentionRepair !== undefined) {
        // The draft stays, but the retry no longer carries the target that was refused.
        lines.push(participantsRecoveryCommand(squarePath));
        lines.push(mentionRepair.fromBody
          ? "  · edit the draft first — the body's @name must be removed or wrapped in backticks:"
          : '  · pick someone standing here, or land it bare:');
        lines.push(`${mentionRepairCommand(squarePath, name, opts, mentionRepair.bell)} < ${quoteShell(draftPath)}`);
      } else if (error.code === 'invalid_args' || error.code === 'invalid_name') {
        if (opts.mentions?.length) lines.push(participantsRecoveryCommand(squarePath));
        if (opts.reply !== undefined) lines.push(`${commandPrefix(squarePath)} history --limit 10`);
      }
    }
    if (mentionRepair === undefined) {
      lines.push('  · correct the problem above before retrying; keep your intended recipients and reply:', `${retryCommand} < ${quoteShell(draftPath)}`);
    }
    process.stderr.write(formatRefusal(squarePath, lines, output));
    process.exit(2);
  }
}
