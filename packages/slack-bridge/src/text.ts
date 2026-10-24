import { NAME_SOURCE } from './names.js';

/** Slack message text becomes a Square body; only the transport's own markup is translated. */
export interface SquareMentionSource {
  /** The Square participant name for a Slack user, when the bridge knows it. */
  squareNameForSlackUser(userId: string): string | undefined;
}

/** A Square body becomes Slack mrkdwn; only natively addressable participants become Slack IDs. */
export interface SlackMentionSource {
  /** The Slack user ID for a Square participant, when it can be mentioned natively. */
  slackUserForSquareName(name: string): string | undefined;
}

const SLACK_TOKEN = /<([^<>]+?)(?:\|([^<>]*))?>/g;
const MENTION = new RegExp(String.raw`(?<![A-Za-z0-9_\-\/@])@(${NAME_SOURCE})(?![A-Za-z0-9_\-\/])`, 'gv');

export function squareBody(text: string, names: SquareMentionSource): string {
  const translated = text.replace(SLACK_TOKEN, (_token, target: string, label: string | undefined) => {
    if (target.startsWith('@')) return `@${names.squareNameForSlackUser(target.slice(1)) ?? target.slice(1)}`;
    if (target.startsWith('#')) return `#${label ?? target.slice(1)}`;
    if (target.startsWith('!')) return `@${label ?? target.slice(1)}`;
    return label === undefined ? target : `${label} (${target})`;
  });
  return translated.replace(/&(amp|lt|gt);/g, (_entity, name: string) => name === 'amp' ? '&' : name === 'lt' ? '<' : '>');
}

export function slackText(body: string, names: SlackMentionSource): string {
  const escaped = body.replace(/[&<>]/g, (character) => character === '&' ? '&amp;' : character === '<' ? '&lt;' : '&gt;');
  return escaped.replace(MENTION, (token, name: string) => {
    const userId = names.slackUserForSquareName(name);
    return userId === undefined ? token : `<@${userId}>`;
  });
}
