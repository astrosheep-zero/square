import {
  deferToActiveCatch,
  opencodeHookResponse,
  renderClaudeInboxContext,
} from '../dist/claude-hook.js';
import { sessionInbox } from '../dist/inbox.js';
import { presentOnce } from '../dist/presented.js';

function pendingSignature(sessionId) {
  const keys = sessionInbox(sessionId).flatMap((membership) =>
    membership.notifications.map(
      (notification) =>
        `${membership.squarePath}\u0000${membership.name.toLocaleLowerCase()}\u0000${notification.actIndex}`
    )
  );
  return keys.sort().join('\n');
}

const IDLE_WAKE = [
  '<system-reminder source="square">',
  'Square activity is waiting. Process the Square context injected into this turn, then run its catch command.',
  '</system-reminder>',
].join('\n');

export default async function squareOpenCodePlugin({ client }) {
  const handledAtIdle = new Map();

  return {
    'shell.env': async (input, output) => {
      if (input.sessionID) output.env.OPENCODE_SESSION_ID = input.sessionID;
    },

    'experimental.chat.system.transform': async (input, output) => {
      if (!input.sessionID) return;
      try {
        // Membership comes only from explicit join/express/catch claims, never env inheritance.
        presentOnce(
          input.sessionID,
          (sessionId) => deferToActiveCatch(sessionInbox(sessionId)),
          (inbox) => output.system.push(renderClaudeInboxContext(inbox))
        );

        const signature = pendingSignature(input.sessionID);
        if (signature === '') handledAtIdle.delete(input.sessionID);
        else handledAtIdle.set(input.sessionID, signature);
      } catch {
        // Adapter failures leave attention unpresented for a later boundary.
      }
    },

    event: async ({ event }) => {
      if (event.type !== 'session.idle') return;
      const sessionId = event.properties.sessionID;
      try {
        const signature = pendingSignature(sessionId);
        if (signature === '') {
          handledAtIdle.delete(sessionId);
          return;
        }
        if (handledAtIdle.get(sessionId) === signature) return;

        const response = opencodeHookResponse({
          session_id: sessionId,
          hook_event_name: 'Stop',
          stop_hook_active: false,
        });
        if (response?.decision !== 'block') return;

        handledAtIdle.set(sessionId, signature);
        try {
          await client.session.promptAsync({
            path: { id: sessionId },
            body: { parts: [{ type: 'text', text: IDLE_WAKE }] },
          });
        } catch {
          handledAtIdle.delete(sessionId);
        }
      } catch {
        // Idle acceleration is best-effort and must not break the host session.
      }
    },

    dispose: async () => {
      handledAtIdle.clear();
    },
  };
}
