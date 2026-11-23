import { truncateExternalDiagnostic } from '../hosts/boundary-presentation.js';
import { formatDuration } from '../core/time.js';
import { style } from '../surfaces/tty-style.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSquareError, SquareError } from '../core/model.js';
import { selectOwnSeat, type Square } from '../api/square-api.js';
import type { ActivityId, OperationError, OperationControl, ExpressOptions, Owner } from '../api/types.js';
import { formatRefusal, spellAction, quoteShell, withPathOutput } from '../surfaces/presentation.js';
import { isExpressGate, renderExpression, renderFailureLines } from '../surfaces/operation-presentation.js';
import type { ExpressFromCli } from '../surfaces/operations.js';
import { readStdin } from './context.js';

export interface ActivityOptions extends Omit<ExpressOptions, 'reply'> {
  readonly recoveryOwner?: Owner;
  readonly reply?: string;
  readonly metadataJson?: string;
  readonly bodyProvided?: boolean;
}

export function saveActivityDraft(squarePath: string, name: string, body: string, now = Date.now()): string {
  const draftDir = path.join(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(squarePath) ? process.cwd() : path.dirname(squarePath), 'drafts');
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

export function activityRetryCommand(squarePath: string, name: string, opts: ActivityOptions): string {
  return spellAction({ operation: 'express', owner: opts.recoveryOwner, args: { location: squarePath, as: name,
    force: opts.force, noWait: opts.noWait, mentions: opts.mentions, metadata: opts.metadataJson,
    reply: opts.reply, body: opts.bodyProvided === false ? undefined : '-' } });
}

export const expressFromCli: ExpressFromCli = async (open, { location, as, body, metadata, ...options }, identity, recoveryOwner, invalidReply) =>
  executeExpression(open, location!, as, body === '-' ? await readStdin() : body, {
    ...options, metadata: metadata === undefined ? undefined : JSON.parse(metadata), metadataJson: metadata,
    bodyProvided: body !== undefined, recoveryOwner,
  }, () => identity().owner, invalidReply);

/** Terminal IO and drafts only; Participant owns every attempt and wait. */
export async function executeExpression(open: (control?: OperationControl) => Promise<Square>, squarePath: string, requestedName: string | undefined, rawInput: string | undefined, opts: ActivityOptions, resolveOwner: () => Owner | undefined, invalidReply?: string): Promise<string> {
  let owner: Owner | undefined;
  let square: Square | undefined;
  let attempted = false;
  let announcedWait: 'throttled' | undefined;
  let landedId: ActivityId | undefined;
  let name = requestedName;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  try {
    owner = resolveOwner();
    if (invalidReply !== undefined) throw new SquareError('invalid_args', invalidReply, { reason: 'invalid_reply', activityUnsent: true });
    square = await open({ signal: controller.signal });
    const participant = await selectOwnSeat(square, owner, requestedName);
    name = participant.name;
    attempted = true;
    const { metadataJson: _metadataJson, bodyProvided: _bodyProvided, recoveryOwner: _owner, reply, ...expressOptions } = opts;
    const outcome = await participant.express(rawInput?.replace(/\r\n/g, '\n').trim(), {
      ...expressOptions, reply: reply as ActivityId | undefined,
    }, {
      signal: controller.signal,
      onProgress(progress) {
        if (progress.kind !== 'waiting' || announcedWait === progress.reason) return;
        process.stdout.write(renderExpressWaiting(progress) + '\n');
        announcedWait = progress.reason;
      },
    });
    landedId = outcome.activity.id;
    return renderExpression(outcome, opts.recoveryOwner);
  } catch (error) {
    const detail = (error as OperationError | undefined)?.operation;
    name = detail?.participant ?? name ?? 'participant';
    // This MUST precede recovery: even an unreadable artifact cannot eat the raw body.
    const draftPath = saveActivityDraft(squarePath, name, rawInput ?? '');
    if (square === undefined) square = await open().catch(() => undefined);
    const selected = square === undefined ? undefined : await selectOwnSeat(square, owner, name).catch(() => undefined);
    const fresh = await square?.recovery(selected?.name ?? name).catch(() => undefined);
    name = fresh?.participant ?? name;
    const output = { squarePath, name, owner: opts.recoveryOwner, draftPath, participantCount: fresh?.standingCount };
    const confirmedUnsent = landedId === undefined && detail?.landedId === undefined
      && detail?.expressEffect !== 'landed' && detail?.expressEffect !== 'unknown'
      && (!attempted || detail?.expressEffect === 'unsent' || (isSquareError(error) && error.facts?.activityUnsent === true));
    const retryCommand = activityRetryCommand(squarePath, name, opts);
    const retryInput = opts.bodyProvided === false ? retryCommand : `${retryCommand} < ${quoteShell(draftPath)}`;
    const exitCode = (code: number) => { process.exitCode = controller.signal.aborted ? 130 : code; };
    if (!confirmedUnsent) {
      process.stderr.write(renderActivityUncertain({ ...output, landedId: landedId ?? detail?.landedId,
        detail: error instanceof Error ? error.message : String(error) }));
      exitCode(1);
      return '';
    }
    if (isSquareError(error) && isExpressGate(error.code)) {
      exitCode(1);
      return withPathOutput(squarePath, renderFailureLines(error,
        { squarePath, name, owner: opts.recoveryOwner, draftPath, retry: retryInput }).join('\n'), output);
    }
    const facts = isSquareError(error) ? error.facts : undefined;
    const reason = facts?.reason;
    const lines = renderFailureLines({ code: isSquareError(error) ? error.code : '', message: error instanceof Error ? error.message : String(error), facts, operation: detail },
      { squarePath, name, owner: opts.recoveryOwner, reply: opts.reply });
    const headlineLines = reason !== 'needs_seat' && isSquareError(error) && error.code === 'already_joined' ? 2 : (reason === 'never_joined' || reason === 'not_standing') ? (error instanceof Error ? error.message : String(error)).split('\n').length : 1;
    lines.splice(headlineLines, 0, `· draft kept: ${draftPath}`);
    if (reason === 'needs_seat') {
      process.stderr.write(formatRefusal(squarePath, lines, output));
      exitCode(2); return '';
    }
    if (isSquareError(error) && (error.code === 'invalid_args' || error.code === 'invalid_name')) {
      if (opts.mentions?.length) lines.push(spellAction({ operation: 'status', args: { location: squarePath } }));
      if (opts.reply !== undefined && reason !== 'invalid_reply') lines.push(spellAction({ operation: 'history', args: { location: squarePath, limit: 10 } }));
    }
    if (invalidReply !== undefined) lines.unshift(invalidReply);
    if (reason === 'invalid_reply') {
      const withoutReply = { ...opts, reply: undefined };
      lines.push(
        '  · choose a valid --reply from history, or send without a reply using this repair:',
        `${activityRetryCommand(squarePath, name, withoutReply)}${withoutReply.bodyProvided === false ? '' : ` < ${quoteShell(draftPath)}`}`,
      );
    } else {
      lines.push(
        '  · correct the problem above before retrying; keep your intended recipients and reply:',
        `${retryInput}`,
      );
    }
    process.stderr.write(formatRefusal(squarePath, lines, output));
    exitCode(2);
    return '';
  } finally { process.off('SIGINT', interrupt); await square?.close(); }
}

/** An indeterminate or already-committed send only points to inspection, never resend. */
export function renderActivityUncertain(opts: { squarePath: string; name: string; owner?: string; participantCount?: number; draftPath: string; landedId?: string; detail?: string }): string {
  return formatRefusal(opts.squarePath, [
    opts.landedId === undefined
      ? '✕ your activity may have landed — check history before sending again'
      : `✕ your activity landed · ${opts.landedId} — the confirmation could not finish`,
    ...(opts.detail === undefined ? [] : [`  · ${truncateExternalDiagnostic(opts.detail)}`]),
    style('dim', `· draft kept: ${opts.draftPath}`),
    '  · the draft is a saved copy; sending it again could repeat your activity',
    spellAction({ operation: 'history', args: { location: opts.squarePath,
      ...(opts.landedId === undefined ? { limit: 10 } : { ids: [opts.landedId] }) } }),
  ], opts);
}

export function renderExpressWaiting(opts: { reason: 'throttled'; delayMs?: number }): string {
  return [
    '· the square is packed — your activity is waiting',
    `  · a lull opens in ${formatDuration(opts.delayMs)}`,
    '  · --no-wait saves a draft and returns now',
  ].join('\n');
}
