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
  metadataOnly?: boolean;
}

export function previewAttentionBody(body: string): string {
  const compact = body.replace(/\r\n/g, '\n');
  return compact.length <= ATTENTION_BODY_MAX ? compact : `${compact.slice(0, ATTENTION_BODY_MAX).trimEnd()}…`;
}
export function attentionBodyIsClipped(body: string): boolean {
  return body.replace(/\r\n/g, '\n').length > ATTENTION_BODY_MAX;
}
export function displayAttentionPath(squarePath: string): string {
  return squarePath.startsWith(homedir()) ? `~${squarePath.slice(homedir().length)}` : squarePath;
}
export function renderAttentionDescription({ actor, route }: Pick<AttentionPreview, 'actor' | 'route'>): string {
  switch (route) {
    case 'mention': return `${actor} spoke your name`;
    case 'reply': return `${actor} answered you`;
    case 'attention': return `${actor} spoke · you’re listening`;
    case 'bell': return `${actor} rang the bell`;
  }
}
function escapeSquareTags(text: string): string {
  return text.replace(/<(\/?)(square-|channel-|system-reminder)/gi, '<\\$1$2');
}
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** The sole source adapter: transports and cards consume this projection, not delivery modes. */
export function projectNotification(attention: AttentionPreview) {
  const body = attention.metadataOnly ? '(structured activity)' : attention.body.replace(/\r\n/g, '\n');
  const description = renderAttentionDescription(attention);
  const remaining = body.length - ATTENTION_BODY_MAX;
  const isFull = !attention.metadataOnly && remaining <= 0;
  const preview = previewAttentionBody(body);
  const attributes = [
    `square="${escapeAttribute(displayAttentionPath(attention.squarePath))}"`,
    `as="${escapeAttribute(attention.recipient)}"`,
    `id="${escapeAttribute(formatActivityId(attention.actIndex))}"`,
    `from="${escapeAttribute(attention.actor)}"`,
    ...(remaining > 0 ? [`truncated="${remaining} more chars"`] : []),
  ];
  return {
    text: [`<square-activity ${attributes.join(' ')}>`, `${description}.`, '', escapeSquareTags(preview),
      ...(!isFull ? ['', escapeSquareTags(`Use square_perceive with location=${JSON.stringify(attention.squarePath)}, as=${JSON.stringify(attention.recipient)}, id=${JSON.stringify(formatActivityId(attention.actIndex))} for the full activity.`)] : []),
      '</square-activity>'].join('\n'),
    full: ['<square-activity>', `· ${displayAttentionPath(attention.squarePath)} · ${attention.recipient} · ${formatActivityId(attention.actIndex)}`,
      `● ${description}`, '', body, '</square-activity>'].join('\n'),
    preview, description, isFull,
  };
}
/** Full human expansion never substitutes a sender-owned preview for the stored body. */
export function renderAttentionFull(attention: AttentionPreview): string { return projectNotification(attention).full; }
export function renderAttentionPreview(attention: AttentionPreview): string { return projectNotification(attention).text; }
