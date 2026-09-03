import { homedir } from 'node:os';

import { notificationMessageId } from './delivery.js';
import type { DirectedNotificationRoute } from './model.js';
import { participantIdentity } from './presentation.js';
import { formatActivityId } from './square-core.js';

export const ATTENTION_BODY_MAX = 200;

export interface AttentionPreview {
  squarePath: string;
  actIndex: number;
  recipient: string;
  actor: string;
  route: DirectedNotificationRoute;
  body: string;
  compact?: boolean;
}

export function previewAttentionBody(body: string): string {
  const compact = body.replace(/\r\n/g, '\n');
  if (compact.length <= ATTENTION_BODY_MAX) return compact;
  return `${compact.slice(0, ATTENTION_BODY_MAX).trimEnd()}…`;
}

export function displayAttentionPath(squarePath: string): string {
  return squarePath.startsWith(homedir())
    ? `~${squarePath.slice(homedir().length)}`
    : squarePath;
}

export function renderAttentionPreview(attention: AttentionPreview): string {
  const attentionKind = attention.route === 'bell' ? 'bell' : 'attention';
  const id = attention.compact
    ? formatActivityId(attention.actIndex)
    : `${notificationMessageId(attention.squarePath, attention.actIndex)} · ${displayAttentionPath(attention.squarePath)}`;
  const normalizedBody = attention.body.replace(/\r\n/g, '\n');
  return [
    `${id}: ${participantIdentity(attention.recipient)} from ${participantIdentity(attention.actor)} (${attentionKind})`,
    previewAttentionBody(normalizedBody),
  ].join('\n');
}
