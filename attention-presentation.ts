import { homedir } from 'node:os';

import type { ActivityDelivery, DirectedNotificationRoute } from './model.js';
import { formatActivityId } from './square-core.js';

export const ATTENTION_BODY_MAX = 200;

export interface AttentionPreview {
  squarePath: string;
  actIndex: number;
  recipient: string;
  actor: string;
  route: DirectedNotificationRoute;
  body: string;
  delivery?: ActivityDelivery;
}

export function previewAttentionBody(body: string, delivery?: ActivityDelivery): string {
  const compact = body.replace(/\r\n/g, '\n');
  if (delivery?.mode === 'direct') return compact;
  if (compact.length <= ATTENTION_BODY_MAX) return compact;
  return `${compact.slice(0, ATTENTION_BODY_MAX).trimEnd()}…`;
}

export function attentionBodyIsClipped(body: string, delivery?: ActivityDelivery): boolean {
  return delivery?.mode !== 'direct' && body.replace(/\r\n/g, '\n').length > ATTENTION_BODY_MAX;
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
  return attention.delivery?.mode === 'direct' ? renderDirectBlock(attention) : renderAttentionBlock(attention, attention.body);
}

/** Attribute values keep their quotes; the stored body and the human card stay unescaped. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** A body may quote the envelope's own tags; in the preview they must never read as one. */
function escapeSquareTags(text: string): string {
  return text.replace(/<(\/?)(square-|system-reminder)/gi, '<\\$1$2');
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

function renderDirectBlock(attention: AttentionPreview): string {
  return [
    `<square-activity id="${formatActivityId(attention.actIndex)}" from="${escapeAttribute(attention.actor)}" to="${escapeAttribute(attention.recipient)}">`,
    escapeSquareTags(attention.body.replace(/\r\n/g, '\n')),
    '</square-activity>',
  ].join('\n');
}

/** Shared model-facing envelope; transport correlation and human cards stay outside it. */
export function renderSquareReminder(previews: readonly string[], deliveries: readonly (ActivityDelivery | undefined)[] = []): string {
  if (previews.length === 0) return '';
  const header = deliveries.some(item => item?.mode === 'direct')
    ? 'This is an external notification, not a direct message from the user.'
    : 'This is an external reminder from Square, not a direct message from the user.';
  return [
    '',
    '<system-reminder>',
    header,
    '',
    previews.join('\n\n'),
    '</system-reminder>',
    '',
  ].join('\n');
}

export function renderAttentionPreview(attention: AttentionPreview): string {
  if (attention.delivery?.mode === 'direct') return renderDirectBlock(attention);
  const remaining = attention.body.replace(/\r\n/g, '\n').length - ATTENTION_BODY_MAX;
  const attributes = [
    `square="${escapeAttribute(displayAttentionPath(attention.squarePath))}"`,
    `as="${escapeAttribute(attention.recipient)}"`,
    `id="${escapeAttribute(formatActivityId(attention.actIndex))}"`,
    `from="${escapeAttribute(attention.actor)}"`,
    ...(remaining > 0 ? [`truncated="${remaining} more chars"`] : []),
  ];
  return [
    `<square-activity ${attributes.join(' ')}>`,
    `${renderAttentionDescription(attention)}.`,
    '',
    escapeSquareTags(previewAttentionBody(attention.body)),
    '</square-activity>',
  ].join('\n');
}
