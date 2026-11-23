import { sameName } from '../core/model.js';
import { truncateChars } from '../core/neutral.js';
import { participantIdentity } from '../core/square-values.js';
import { MAX_IDENTITY_SET_SIZE, type Perception } from '../core/square-core.js';
import { formatRelativeTime } from '../core/time.js';
import type { Activity, UnreadActivitySummary, ParticipantSummary } from '../api/types.js';
import { style } from './tty-style.js';
import { displayPath } from './operations.js';

export { displayPath, quoteShell, spellAction, spellField, type PresentationSurface } from './operations.js';

interface HeaderOptions {
  participantCount?: number;
  /** Refusal bodies go to stderr, which stays literal even when it is a TTY. */
  plain?: boolean;
}

export function withPathOutput(squarePath: string, body = '', opts: HeaderOptions = {}): string {
  const count = opts.participantCount ?? 0;
  const line = `· ${displayPath(squarePath)} — ${count} in the square`;
  return [opts.plain === true ? line : style('dim', line), ...(body === '' ? [] : ['', body])].join('\n') + '\n';
}

/** The same header/blank/body layout as withPathOutput, for refusal bodies written to stderr. */
export function formatRefusal(
  squarePath: string,
  bodyLines: string[],
  opts: { participantCount?: number } = {}
): string {
  const body = bodyLines.join('\n');
  // A refusal with no known count stays bare rather than claiming "0 in the square".
  if (opts.participantCount === undefined) return body === '' ? '' : `${body}\n`;
  return withPathOutput(squarePath, body, { ...opts, plain: true });
}

function formatAge(ms: number | undefined): string {
  if (ms === undefined) return '(none)';
  if (ms < 1000) return `${Math.max(0, ms)}ms`;
  return `${Math.floor(ms / 1000)}s`;
}

export function renderPresenceLines(recent: readonly ParticipantSummary[], now: number, limit = 5): string[] {

  const shown = recent.slice(0, limit);
  if (shown.length === 0) return [style('dim', '  ○ nobody nearby')];

  const lines = shown.map((p) => {
    const glyph = p.presence === 'done' || p.presence === 'away' ? '○' : p.presence === 'watching' ? '◎' : p.lastActiveAt !== undefined ? '●' : '○';
    const text = p.presence === 'done'
      ? (p.lastActiveAt === undefined ? 'stepped out of the square' : `stepped out of the square · ${formatRelativeTime(p.lastActiveAt, now)}`)
      : p.presence === 'away' ? 'is away'
      : p.presence === 'watching'
        ? (p.lastActiveAt === undefined ? 'is nearby · perceiving' : `is nearby · perceiving · ${formatRelativeTime(p.lastActiveAt, now)}`)
        : p.lastActiveAt === undefined ? 'is nearby · quiet'
          : p.activityCount > 0 ? `is nearby · ${formatRelativeTime(p.lastActiveAt, now)}` : `is nearby · quiet · ${formatRelativeTime(p.lastActiveAt, now)}`;
    return `  ${glyph === '○' ? style('dim', glyph) : glyph} ${participantIdentity(p.name)}${style('dim', ` ${text}`)}`;
  });
  const remaining = recent.length - shown.length;
  if (remaining > 0) lines.push(style('dim', `  ○ … ${remaining} more nearby`));
  return lines;
}

const BODY_PREVIEW_LENGTH = 200;

export function previewBodyFacts(body: string, maxLen = BODY_PREVIEW_LENGTH): { text: string; clipped: boolean } {
  const preview = truncateChars(body, maxLen);
  return {
    text: preview.remaining === 0 ? preview.text : `${preview.text}\n${style('dim', `… ${preview.remaining} more chars`)}`,
    clipped: preview.remaining > 0,
  };
}

const UNREAD_PREVIEW_CHARS = 120;

function renderedBody(body: string | undefined, maxChars: number | undefined): { text: string; clipped: boolean } {
  if (!body) return { text: '', clipped: false };
  return maxChars === undefined ? { text: body, clipped: false } : previewBodyFacts(body, maxChars);
}

function bodySuffix(body: string): string {
  if (body === '') return '';
  return `\n${body.split('\n').map((line) => `  ${line}`).join('\n')}`;
}

interface RenderedEvent {
  text: string;
  /** The rendered body was cut short by `preview`. */
  bodyClipped: boolean;
}

function renderEventCliFacts(
  event: Activity,
  opts: { now?: number; preview?: number; mention?: string } = {}
): RenderedEvent {
  const now = opts.now;
  const maxBody = opts.preview;
  switch (event.kind) {
    case 'read':
      return { text: `· ${participantIdentity(event.actor)} looked through ${event.through} · ${event.id}`, bodyClipped: false };
    case 'join':
    case 'listen':
    case 'ignore':
    case 'unlisten': {
      const actor = event.actor ?? 'someone';
      const identity = actor === 'someone' ? actor : participantIdentity(actor);
      const action = event.kind === 'join' ? 'stepped into the square'
        : event.kind === 'listen' ? `turned an ear toward ${participantIdentity(event.target ?? 'someone')}`
          : event.kind === 'ignore' ? `turned away from ${participantIdentity(event.target ?? 'someone')}`
            : `returned to direct attention from ${participantIdentity(event.target ?? 'someone')}`;
      return { text: `· ${identity} ${action}`, bodyClipped: false };
    }
    case 'say': {
      const body = renderedBody(event.body, maxBody);
      const visibleBody = body.text === '' && event.metadata !== undefined
        ? { text: '(structured activity)', clipped: false }
        : body;
      const mention = opts.mention;
      const mentionSuffix =
        mention !== undefined && (event.reach === 'bell' || event.mentions.some((name) => sameName(name, mention)))
          ? ` · calls your name across the square — ${participantIdentity(mention)}`
          : '';
      const replySuffix = event.reply === undefined ? '' : ` · replies to ${event.reply}`;
      const meta = ` · ${event.id} · ${formatRelativeTime(event.at, now)}${mentionSuffix}${replySuffix}`;
      return { text: `● ${participantIdentity(event.actor)}${style('dim', meta)}${bodySuffix(visibleBody.text)}`, bodyClipped: visibleBody.clipped };
    }
    case 'done': {
      const body = renderedBody(event.body, maxBody);
      return {
        text: `${style('dim', '○')} ${participantIdentity(event.actor)} stepped out of the square — done${style('dim', ` · ${event.id} · ${formatRelativeTime(event.at, now)}`)}${bodySuffix(body.text)}`,
        bodyClipped: body.clipped,
      };
    }
  }
}

export function renderEventCli(
  event: Activity,
  opts: { now?: number; preview?: number; mention?: string } = {}
): string {
  return renderEventCliFacts(event, opts).text;
}

function renderPresenceOnlySay(
  event: Activity,
  opts: { now?: number } = {}
): string {
  const targets = event.reach === 'bell' ? [] : event.mentions;
  const meta = style('dim', ` · ${event.id} · ${formatRelativeTime(event.at, opts.now)}`);
  if (targets.length === 0) {
    return `● ${participantIdentity(event.actor)}${meta}`;
  }
  const visibleTargets = targets.slice(0, MAX_IDENTITY_SET_SIZE).map((name) => participantIdentity(name));
  const remainingTargets = targets.length - visibleTargets.length;
  const dest = ` ${[
    ...visibleTargets,
    ...(remainingTargets === 0 ? [] : [`${remainingTargets} ${remainingTargets === 1 ? 'other' : 'others'}`]),
  ].join(' and ')}`;
  return `● ${participantIdentity(event.actor)}${meta}\n${style('dim', `  talked to${dest}`)}`;
}

export function renderAmbientEventFacts(
  event: Activity,
  opts: { now?: number; preview?: number; mention?: string; perception?: Perception } = {}
): RenderedEvent {
  if (event.kind !== 'say') return renderEventCliFacts(event, opts);
  if (opts.perception === undefined) throw new Error('Ambient say rendering requires a settled perception');
  if (opts.perception === 'presence') return { text: renderPresenceOnlySay(event, opts), bodyClipped: false };
  return renderEventCliFacts(event, opts);
}

export function renderUnreadSummary(activitySummaries: readonly UnreadActivitySummary[]): string[] {
  const visibleSummaries = activitySummaries.slice(0, MAX_IDENTITY_SET_SIZE);
  const remainingSummaries = activitySummaries.length - visibleSummaries.length;
  return [
    ...visibleSummaries.map((item) => {
      const compact = (item.preview.body ?? '').replace(/\s+/g, ' ').trim();
      const bodyPreview = compact === ''
        ? { text: item.preview.structured ? '(structured activity)' : '(empty)', remaining: 0 }
        : truncateChars(compact, UNREAD_PREVIEW_CHARS);
      const bodyText = bodyPreview.remaining === 0 ? bodyPreview.text : `${bodyPreview.text}${style('dim', `… (+${bodyPreview.remaining} chars)`)}`;
      return style('dim', `  · ${participantIdentity(item.name)} spoke — ${formatAge(item.latestActivityAgeMs)} ago · "${bodyText}"`);
    }),
    ...(remainingSummaries === 0 ? [] : [style('dim', `  · ${remainingSummaries} more participants have unread activity`)]),
  ];
}


export function renderPresenceAnchor(names: readonly string[]): string {
  const visibleNames = names.slice(0, MAX_IDENTITY_SET_SIZE);
  const participants = visibleNames.map((name) => participantIdentity(name)).join(', ');
  const remaining = names.length - visibleNames.length;
  const suffix = remaining === 0 ? '' : ` and ${remaining} more`;
  return style('dim', names.length === 1 ? `→ ${participants} was here` : `→ ${participants}${suffix} were here`);
}
