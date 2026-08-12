import { presentPendingAtBoundary, renderPendingAtBoundary } from '../dist/boundary-presentation.js';

export function pendingInbox(inbox) {
  return inbox.filter((item) => item.notifications?.length > 0);
}

export function inboxKeys(inbox) {
  return pendingInbox(inbox).flatMap((item) => item.notifications.map((note) =>
    `${item.squarePath}\u0000${item.name.toLocaleLowerCase()}\u0000${note.actIndex}`
  ));
}

export function renderPiInbox(inbox) {
  return renderPendingAtBoundary(pendingInbox(inbox));
}

export default function squarePiExtension(pi) {
  let sessionId;
  let previousSessionId;
  const present = (deliver) => sessionId === undefined ? undefined : presentPendingAtBoundary(sessionId, deliver);

  pi.on('session_start', async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    previousSessionId = process.env.SQUARE_PI_SESSION_ID;
    process.env.SQUARE_PI_SESSION_ID = sessionId;
  });

  pi.on('before_agent_start', async () => {
    try {
      return present((context) => ({ message: { customType: 'square', content: context, display: true } }));
    } catch {
      return undefined;
    }
  });

  pi.on('session_shutdown', async () => {
    if (process.env.SQUARE_PI_SESSION_ID === sessionId) {
      if (previousSessionId === undefined) delete process.env.SQUARE_PI_SESSION_ID;
      else process.env.SQUARE_PI_SESSION_ID = previousSessionId;
    }
    sessionId = undefined;
  });
}
