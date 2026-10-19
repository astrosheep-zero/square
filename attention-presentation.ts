import { homedir } from 'node:os';

import type { DirectedNotificationRoute } from './model.js';
import { formatActivityId } from './square-core.js';

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

export function renderAttentionDescription({ actor, route }: Pick<AttentionPreview, 'actor' | 'route'>): string {
  switch (route) {
    case 'mention': return `${actor} spoke your name`;
    case 'reply': return `${actor} answered you`;
    case 'attention': return `${actor} spoke · you’re listening`;
    case 'bell': return `${actor} rang the bell`;
  }
}

/** Full notification text for human-facing expansion, never the bounded model preview. */
export function renderAttentionFull(attention: AttentionPreview): string {
  return renderAttentionBlock(attention, attention.body);
}

function renderAttentionBlock(attention: AttentionPreview, body: string): string {
  return [
    '<square-activity>',
    `· ${displayAttentionPath(attention.squarePath)} · ${attention.recipient} · ${formatActivityId(attention.actIndex)}`,
    `● ${renderAttentionDescription(attention)}`,
    '',
    body,
    '</square-activity>',
  ].join('\n');
}

export function renderAttentionPreview(attention: AttentionPreview): string {
  return [
    renderAttentionBlock(attention, previewAttentionBody(attention.body)),
    ...(attentionBodyIsClipped(attention.body)
      ? ['· clipped — catch it to read the rest']
      : []),
  ].join('\n');
}
