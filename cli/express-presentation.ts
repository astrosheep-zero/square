import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSquareError } from '../model.js';
import { type Square, formatActivityId, parseActivityId } from '../square-api.js';
import type { ActivityId, OperationError, OperationControl, ExpressResult, ExpressOptions } from '../square-facade.js';
import {
  formatRefusal, refusalText, renderActivityBlocked, renderActivityLimit,
  renderActivityUncertain, renderExpressNoWait, renderExpressWaiting, renderPendingFeed,
  joinRecoveryCommand, participantIdentity, participantsRecoveryCommand,
  participantCommandPrefix, commandPrefix, quoteShell, takeoverRecoveryLines, withPathOutput,
} from '../presentation.js';
import { formatDuration } from '../time.js';
import { style } from '../tty-style.js';

export interface ActivityOptions extends Omit<ExpressOptions, 'reply'> { readonly reply?: string; }

export function saveActivityDraft(squarePath: string, name: string, body: string, now = Date.now()): string {
  const draftDir = path.join(path.dirname(squarePath), 'drafts');
  fs.mkdirSync(draftDir, { recursive: true });
  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 8);
  const stamp = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:.]/g, '-');
  const namePart = name.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'participant';
  const base = `${stamp}-${namePart}-${hash}`;
  for (let index = 0; ; index++) {
    const target = path.join(draftDir, `${base}${index === 0 ? '' : `-${index}`}.md`);
    try { fs.writeFileSync(target, body, { flag: 'wx' }); return target; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}

function replyArgument(reply: string | undefined): string {
  if (reply === undefined) return '';
  const index = parseActivityId(reply);
  return ` --reply ${index === undefined ? quoteShell(reply) : formatActivityId(index)}`;
}

/** Retry choices are transport syntax, never a second admission decision. */
export function activityRetryCommand(squarePath: string, name: string, opts: ActivityOptions, force = opts.force ?? false): string {
  const reach = (opts.reach === 'bell' ? ' --bell' : '')
    + (opts.mentions ?? []).map((target) => ` --mention ${quoteShell(target)}`).join('')
    + (opts.noMention === true ? ' --no-mention' : '');
  return `${participantCommandPrefix(squarePath, name)} express${force ? ' --force' : ''}${opts.noWait ? ' --no-wait' : ''}${reach}${replyArgument(opts.reply)} -`;
}

function isGestureOnly(body: string): boolean {
  return /\*[^*]*\*/.test(body) && body.replace(/\*[^*]*\*/g, '').trim() === '';
}

export function renderExpression(squarePath: string, data: ExpressResult): string {
  const projection = data.observation!;
  const name = projection.participant;
  const pendingSpeaker = projection.pendingPublic[0]?.actor;
  const pendingLead = pendingSpeaker === undefined ? ''
    : `▲ while you spoke, ${participantIdentity(pendingSpeaker)} said something behind you\n\n`;
  const pending = projection.pendingPublic.length === 0 ? ''
    : `\n\n${pendingLead}${renderPendingFeed(projection.pendingPublic, projection.sayNumbers, projection.perceptions, name)}`;
  const ownCount = projection.ownActivityCount;
  const capCount = projection.hardCap === null ? '' : ` · ${ownCount}/${projection.hardCap}`;
  const activity = data.activity;
  const confirmation = activity.reach === 'bell'
    ? `● you ring the bell — everyone turns · ${activity.id}${style('dim', capCount)}`
    : `● ${activity.mentions.length > 0
      ? `you walk over to ${activity.mentions.map((target) => participantIdentity(target)).join(', ')}`
      : isGestureOnly(activity.body ?? '') ? 'your gesture lands' : 'your words land'} — ${activity.id}${style('dim', capCount)}`;
  const replyNotice = data.replyAuthorNotHere === undefined ? ''
    : `\n○ ${participantIdentity(data.replyAuthorNotHere)} isn't in the square right now — the reply landed without reaching them`;
  const unmatchedNotice = data.unmatchedMentions?.length
    ? `\n  · ${data.unmatchedMentions.map((token) => `@${token} isn't standing here`).join('; ')} — ${activity.mentions.length === 0 && activity.reply === undefined ? 'activity landed bare' : 'left as literal text'}` : '';
  return withPathOutput(projection.location ?? squarePath,
    (projection.reentry === undefined ? '' : '● you stepped back into the square\n')
      + confirmation + (data.hint ? `\n${style('dim', `· ${data.hint}`)}` : '') + replyNotice + unmatchedNotice + pending,
    { participantCount: projection.standingCount, held: projection.held });
}

/** Body adaptation, terminal IO and drafts only; Participant owns every attempt and wait. */
export async function executeExpression(open: (control?: OperationControl) => Promise<Square>, squarePath: string, requestedName: string | undefined, rawInput: string, opts: ActivityOptions): Promise<void> {
  let square: Square | undefined;
  let attempted = false;
  let announcedWait: 'held' | 'throttled' | undefined;
  let landedId: ActivityId | undefined;
  let name = requestedName;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  try {
    square = await open({ signal: controller.signal });
    const participant = await square.participant(requestedName);
    name = participant.name;
    attempted = true;
    const outcome = await participant.express(rawInput.replace(/\r\n/g, '\n').trim(), {
      ...opts, reply: opts.reply as ActivityId | undefined, observe: true,
    }, {
      signal: controller.signal,
      onProgress(progress) {
        if (progress.kind !== 'waiting' || announcedWait === progress.reason) return;
        process.stdout.write(renderExpressWaiting(progress) + '\n');
        announcedWait = progress.reason;
      },
    });
    landedId = outcome.activity.id;
    name = outcome.observation!.participant;
    process.stdout.write(renderExpression(squarePath, outcome));
  } catch (error) {
    const detail = (error as OperationError | undefined)?.operation;
    name = detail?.participant ?? name ?? 'participant';
    // This MUST precede recovery: even an unreadable artifact cannot eat the raw body.
    const draftPath = saveActivityDraft(squarePath, name, rawInput);
    if (square === undefined) square = await open().catch(() => undefined);
    const fresh = await square?.recovery(name).catch(() => undefined);
    name = fresh?.participant ?? name;
    const output = { squarePath, name, draftPath, participantCount: fresh?.standingCount, held: fresh?.held };
    const confirmedUnsent = landedId === undefined && detail?.landedId === undefined
      && detail?.expressEffect !== 'landed' && detail?.expressEffect !== 'unknown'
      && (!attempted || detail?.expressEffect === 'unsent' || (isSquareError(error) && error.facts?.activityUnsent === true));
    const retryCommand = activityRetryCommand(squarePath, name, opts);
    const exitCode = (code: number) => { process.exitCode = controller.signal.aborted ? 130 : code; };
    if (!confirmedUnsent) {
      process.stderr.write(renderActivityUncertain({ ...output, landedId: landedId ?? detail?.landedId,
        detail: error instanceof Error ? error.message : String(error) }));
      exitCode(1);
      return;
    }
    if (isSquareError(error)) {
      if (error.code === 'behind' && fresh?.activitySummaries !== undefined) {
        process.stdout.write(renderActivityBlocked({ ...output, retryCommand,
          forceCommand: activityRetryCommand(squarePath, name, opts, true),
          activitySummaries: fresh.activitySummaries.map((summary) => ({ ...summary, previews: [...summary.previews] })),
        }));
        exitCode(1); return;
      }
      if (error.code === 'capped') {
        process.stdout.write(renderActivityLimit({ ...output, count: fresh?.ownActivityCount,
          ...(fresh?.hardCap == null ? {} : { hardCap: fresh.hardCap }),
        }));
        exitCode(1); return;
      }
      if (error.code === 'held' || error.code === 'throttled') {
        process.stdout.write(renderExpressNoWait({ ...output, reason: error.code, retryCommand,
          delayMs: error.facts?.retryAfterMs ?? 1, holder: error.facts?.holder, holdReason: error.facts?.holdReason,
        }));
        exitCode(1); return;
      }
      if (error.code === 'bell_quota') {
        process.stdout.write(withPathOutput(squarePath, [
          '✕ the bell stays quiet for now', `  · you can ring it again in ${formatDuration(error.facts?.retryAfterMs ?? 1)}`,
          `· draft kept: ${draftPath}`, '  · retry when the bell is ready:', `${retryCommand} < ${quoteShell(draftPath)}`,
        ].join('\n'), output));
        exitCode(1); return;
      }
    }
    const facts = isSquareError(error) ? error.facts : undefined;
    const reason = facts?.reason;
    const message = reason === 'bell_mention_conflict'
      ? '✕ a bell cannot be combined with a mention'
      : reason === 'invalid_reply'
        ? facts?.activityExists === false
          ? `Invalid --reply: ${facts.activityId ?? opts.reply ?? 'that activity'} is not in this square's history`
          : 'Invalid --reply: expected an activity id like act/12'
        : refusalText(error);
    const lines = [message, `· draft kept: ${draftPath}`];
    const repair = reason === 'bell_mention_conflict' || (reason === 'not_standing' && detail?.subject === 'recipient');
    if (isSquareError(error)) {
      if ((reason === 'never_joined' && detail?.subject === 'caller') || error.code === 'unknown_participant' || error.code === 'not_joined') {
        lines.push(joinRecoveryCommand(squarePath, name));
      }
      if (error.code === 'already_joined') lines.push(...takeoverRecoveryLines(squarePath, name));
      if (repair) {
        lines.push(participantsRecoveryCommand(squarePath), reason === 'bell_mention_conflict'
          ? '  · ring the bell without explicit mentions:'
          : '  · retry without explicit recipients:',
        `${activityRetryCommand(squarePath, name, { ...opts, mentions: [] })} < ${quoteShell(draftPath)}`);
      } else if (error.code === 'invalid_args' || error.code === 'invalid_name') {
        if (opts.mentions?.length) lines.push(participantsRecoveryCommand(squarePath));
        if (opts.reply !== undefined && reason !== 'invalid_reply') lines.push(`${commandPrefix(squarePath)} history --limit 10`);
      }
    }
    if (reason === 'invalid_reply') {
      const withoutReply = { ...opts, reply: undefined };
      lines.push(
        `${commandPrefix(squarePath)} history --limit 10`,
        '  · choose a valid --reply from history, or send without a reply using this repair:',
        `${activityRetryCommand(squarePath, name, withoutReply)} < ${quoteShell(draftPath)}`,
      );
    } else if (!repair) {
      lines.push(
        '  · correct the problem above before retrying; keep your intended recipients and reply:',
        `${retryCommand} < ${quoteShell(draftPath)}`,
      );
    }
    process.stderr.write(formatRefusal(squarePath, lines, output));
    exitCode(2);
  } finally { process.off('SIGINT', interrupt); await square?.close(); }
}
