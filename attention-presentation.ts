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

export function renderAttentionPreview(attention: AttentionPreview): string {
  const attentionKind = attention.route === 'bell' ? 'bell' : 'attention';
  const attributes = {
    location: displayAttentionPath(attention.squarePath),
    id: formatActivityId(attention.actIndex),
    from: attention.actor,
    to: attention.recipient,
    kind: attentionKind,
  };
  const entries = Object.entries(attributes);
  const [lastKey, lastValue] = entries[entries.length - 1];
  return [
    '<square-activity',
    // The opening tag must never emit a standalone `>` line: Markdown renders it as a blockquote.
    ...entries.slice(0, -1).map(([key, value]) => `  ${key}="${escapeAttribute(value)}"`),
    `  ${lastKey}="${escapeAttribute(lastValue)}">`,
    previewAttentionBody(attention.body),
    '</square-activity>',
    ...(attentionBodyIsClipped(attention.body)
      ? [`» ${participantCommandPrefix(attention.squarePath, attention.recipient)} catch --id ${formatActivityId(attention.actIndex)}`]
      : []),
  ].join('\n');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}
