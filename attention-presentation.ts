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
  const route = attention.route === 'bell'
    ? `${attention.actor} rang the bell for ${attention.recipient}`
    : `${attention.actor} called ${attention.recipient}'s name`;
  const lines = [
    `· ${displayAttentionPath(attention.squarePath)} · ${formatActivityId(attention.actIndex)}`,
    `● ${route}`,
    '',
    previewAttentionBody(attention.body),
    // A clipped body ends with the full command to read it all: the command keeps its own
    // bare line inside the fence so it stays attached to the block it belongs to.
    ...(attentionBodyIsClipped(attention.body)
      ? ['', '· clipped — read it all:', `${participantCommandPrefix(attention.squarePath, attention.recipient)} catch --id ${formatActivityId(attention.actIndex)}`]
      : []),
  ];
  // The fence is what keeps the body from being re-rendered by Markdown. It grows past any
  // backtick run in the content so a body or quoted path containing a fence cannot break out.
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(lines.join('\n')) + 1));
  return [`${fence}square-activity`, ...lines, fence].join('\n');
}

function longestBacktickRun(value: string): number {
  return value.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;
}
