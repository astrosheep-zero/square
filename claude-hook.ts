import { leaseOwnsNotification } from './delivery.js';
import { notificationMessageId } from './delivery.js';
import { sessionInbox, type InboxMembership } from './inbox.js';
import { participantCommandPrefix } from './presentation.js';
import { presentOnce } from './presented.js';

export interface ClaudeHookInput {
  session_id?: unknown;
  hook_event_name?: unknown;
  stop_hook_active?: unknown;
}

function pendingCount(inbox: InboxMembership[]): number {
  return inbox.reduce((total, membership) => total + membership.notifications.length, 0);
}

const INJECT_BODY_MAX = 200;
const INJECT_TOTAL_MAX = 1200;

/** Let a fresh blocking catch own notifications it can deliver; hook injection remains the fallback. */
export function deferToActiveCatch(inbox: InboxMembership[]): InboxMembership[] {
  return inbox
    .map((membership) => {
      const lease = membership.catchLease;
      if (lease === undefined) return membership;
      return {
        ...membership,
        notifications: membership.notifications.filter(
          (notification) => !leaseOwnsNotification(lease, { ...notification, recipient: membership.name })
        ),
      };
    })
    .filter((membership) => membership.notifications.length > 0);
}

function injectBodyPreview(body: string): string {
  const compact = body.replace(/\r\n/g, '\n');
  if (compact.length <= INJECT_BODY_MAX) return compact;
  return `${compact.slice(0, INJECT_BODY_MAX).trimEnd()}\n… [truncated; run catch --now]`;
}

export function renderClaudeInboxContext(inbox: InboxMembership[]): string {
  const count = pendingCount(inbox);
  const noun = count === 1 ? 'notification' : 'notifications';
  const header = `<system-reminder source="square">You have ${count} unread Square ${noun}.`;
  const footer = [
    // Body here is a cache only. Delivered is written solely by catch.
    'Ids are stable across turns. If you already acted on an id, do not repeat the action; still run catch --now to mark delivered.',
    'Read and respond in the square before finishing the current turn.</system-reminder>',
  ];
  const queued = inbox.flatMap((membership) =>
    membership.notifications.map((notification) => ({ membership, notification }))
  );
  const blocks: string[] = [];
  let omitted = 0;

  for (const [index, entry] of queued.entries()) {
    const { membership, notification } = entry;
    const command = `${participantCommandPrefix(membership.squarePath, membership.name)} catch --now`;
    const id = notificationMessageId(membership.squarePath, notification.actIndex);
    const block = [
      `${id} · ${membership.squarePath}: @${membership.name} from @${notification.actor} (${notification.route})`,
      injectBodyPreview(notification.body),
      `Ack with: ${command}`,
    ].join('\n');
    const omittedAfter = omitted + queued.length - index - 1;
    const prospective = [
      header,
      ...blocks,
      block,
      ...(omittedAfter > 0
        ? [`… ${omittedAfter} unread ${omittedAfter === 1 ? 'notification' : 'notifications'} omitted. Run catch --now to receive them.`]
        : []),
      ...footer,
    ].join('\n');
    if (prospective.length > INJECT_TOTAL_MAX) {
      omitted += 1;
      continue;
    }
    blocks.push(block);
  }

  return [
    header,
    ...blocks,
    ...(omitted > 0
      ? [`… ${omitted} unread ${omitted === 1 ? 'notification' : 'notifications'} omitted. Run catch --now to receive them.`]
      : []),
    ...footer,
  ].join('\n');
}

function nativeHookResponse(
  input: ClaudeHookInput,
  lookup: (sessionId: string) => InboxMembership[],
  env: NodeJS.ProcessEnv
): object | undefined {
  if (typeof input.session_id !== 'string' || input.session_id === '') return undefined;
  if (input.hook_event_name !== 'UserPromptSubmit' && input.hook_event_name !== 'Stop') {
    return undefined;
  }
  if (input.hook_event_name === 'Stop' && input.stop_hook_active === true) return undefined;

  // Delivery membership is only claimed by explicit participant actions (join/express/catch/...).
  // Inherited PASEO_AGENT_ID proves process ancestry, not conversational ownership.

  // Stop is the guaranteed "don't leave while undelivered" nudge; it does not consume presentation.
  if (input.hook_event_name === 'Stop') {
    const pending = lookup(input.session_id).filter((membership) => membership.notifications.length > 0);
    if (pendingCount(pending) === 0) return undefined;
    return { decision: 'block', reason: renderClaudeInboxContext(pending) };
  }

  return presentOnce(
    input.session_id,
    (sessionId) => deferToActiveCatch(lookup(sessionId)),
    (inbox) => ({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: renderClaudeInboxContext(inbox),
      },
    }),
    env
  );
}

export function claudeHookResponse(
  input: ClaudeHookInput,
  lookup: (sessionId: string) => InboxMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env
): object | undefined {
  return nativeHookResponse(input, lookup, env);
}

/** Codex shares Claude's turn-boundary protocol; keep a dedicated command for churn isolation. */
export function codexHookResponse(
  input: ClaudeHookInput,
  lookup: (sessionId: string) => InboxMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env
): object | undefined {
  return nativeHookResponse(input, lookup, env);
}

export function opencodeHookResponse(
  input: ClaudeHookInput,
  lookup: (sessionId: string) => InboxMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env
): object | undefined {
  return nativeHookResponse(input, lookup, env);
}

export function runClaudeHook(inputText: string, env: NodeJS.ProcessEnv = process.env): string {
  let input: unknown;
  try {
    input = JSON.parse(inputText);
  } catch {
    return '';
  }
  if (input === null || typeof input !== 'object') return '';
  const response = claudeHookResponse(input as ClaudeHookInput, sessionInbox, env);
  return response === undefined ? '' : `${JSON.stringify(response)}\n`;
}

export function runCodexHook(inputText: string, env: NodeJS.ProcessEnv = process.env): string {
  let input: unknown;
  try {
    input = JSON.parse(inputText);
  } catch {
    return '';
  }
  if (input === null || typeof input !== 'object') return '';
  const response = codexHookResponse(input as ClaudeHookInput, sessionInbox, env);
  return response === undefined ? '' : `${JSON.stringify(response)}\n`;
}
