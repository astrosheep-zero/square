import { homedir } from 'node:os';

import type { DirectedNotificationRoute } from './model.js';
import { formatActivityId } from './square-core.js';
import { participantCommandPrefix } from './presentation.js';

export const ATTENTION_BODY_MAX = 200;

export interface AttentionPreview {
  squarePath: string;
  actIndex: number;
  recipient: string;
  actor: string;
  route: DirectedNotificationRoute;
  body: string;
}

export function previewAttentionBody(body: string): string {
  const compact = body.replace(/\r\n/g, '\n');
  if (compact.length <= ATTENTION_BODY_MAX) return compact;
  return `${compact.slice(0, ATTENTION_BODY_MAX).trimEnd()}…`;
}

export function attentionBodyIsClipped(body: string): boolean {
  return body.replace(/\r\n/g, '\n').length > ATTENTION_BODY_MAX;
}

export function displayAttentionPath(squarePath: string): string {
  return squarePath.startsWith(homedir())
    ? `~${squarePath.slice(homedir().length)}`
    : squarePath;
}

export function renderAttentionDescription({ actor, recipient, route }: Pick<AttentionPreview, 'actor' | 'recipient' | 'route'>): string {
  switch (route) {
    case 'mention': return `${actor} spoke your name (${recipient})`;
    case 'reply': return `${actor} answered you (${recipient})`;
    case 'attention': return `${actor} spoke · you’re listening to ${actor}`;
    case 'bell': return `${actor} rang the bell · everyone’s attention`;
  }
}

export function renderAttentionPreview(attention: AttentionPreview): string {
  return [
    '<square-activity>',
    `· ${displayAttentionPath(attention.squarePath)} · ${formatActivityId(attention.actIndex)}`,
    `● ${renderAttentionDescription(attention)}`,
    '',
    previewAttentionBody(attention.body),
    '</square-activity>',
    // A clipped body ends with the full command to read it all: a labeled caption, then the
    // command bare on its own line so it can be copied and run as it is.
    ...(attentionBodyIsClipped(attention.body)
      ? ['· clipped — read it all:', `${participantCommandPrefix(attention.squarePath, attention.recipient)} catch --id ${formatActivityId(attention.actIndex)}`]
      : []),
  ].join('\n');
}
