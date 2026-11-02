import { escapeSquareTags, projectChannelNotification } from './channel-presentation.js';
export { projectChannelNotification, renderSquareReminder } from './channel-presentation.js';
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
  preview?: string;
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
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** The sole source adapter: transports and cards consume this projection, not delivery modes. */
export function projectNotification(attention: AttentionPreview) {
  const body = attention.body.replace(/\r\n/g, '\n');
  const description = renderAttentionDescription(attention);
  const remaining = body.length - ATTENTION_BODY_MAX;
  const preview = previewAttentionBody(body);
  const attributes = [
    `square="${escapeAttribute(displayAttentionPath(attention.squarePath))}"`,
    `as="${escapeAttribute(attention.recipient)}"`,
    `id="${escapeAttribute(formatActivityId(attention.actIndex))}"`,
    `from="${escapeAttribute(attention.actor)}"`,
    ...(remaining > 0 ? [`truncated="${remaining} more chars"`] : []),
  ];
  return {
    text: [`<square-activity ${attributes.join(' ')}>`, `${description}.`, '', escapeSquareTags(preview), '</square-activity>'].join('\n'),
    full: ['<square-activity>', `· ${displayAttentionPath(attention.squarePath)} · ${attention.recipient} · ${formatActivityId(attention.actIndex)}`,
      `● ${description}`, '', body, '</square-activity>'].join('\n'),
    preview, description, clipped: remaining > 0, agora: true,
  };
}
/** One stored message: Agora framing when an upper say owns it, Channel's raw frame otherwise. */
export function projectMessageNotification(input: {
  squarePath: string;
  recipient: string;
  actor: string;
  body: string;
  preview?: string;
  agora?: { readonly actIndex: number; readonly route: DirectedNotificationRoute };
}) {
  if (input.agora === undefined) return projectChannelNotification(input);
  return projectNotification({ squarePath: input.squarePath, recipient: input.recipient, actor: input.actor,
    route: input.agora.route, actIndex: input.agora.actIndex, body: input.body });
}

/** Full human expansion never substitutes a sender-owned preview for the stored body. */
export function renderAttentionFull(attention: AttentionPreview): string { return projectNotification(attention).full; }
export function renderAttentionPreview(attention: AttentionPreview): string { return projectNotification(attention).text; }
