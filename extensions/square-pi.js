import { presentPendingAtBoundary, renderPendingAtBoundary } from '../dist/boundary-presentation.js';
import { automaticSessionEnd, automaticSessionStart } from '../dist/automatic-session.js';
import { waitForSessionPending } from '../dist/inbox.js';

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
  let sessionCwd;
  let joiningContext;
  let previousSessionId;
  let watcher;
  let watcherAbort;
  let generation = 0;
  let presenting = false;
  let settledSerial = 0;
  let settledWaiters = [];
  const handledPending = new Set();
  let retryAfterChange = false;
  const present = (deliver) => sessionId === undefined ? undefined : presentPendingAtBoundary(sessionId, deliver);

  const waitForSettled = (serial, signal) => {
    if (settledSerial !== serial) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = { serial, resolve };
      settledWaiters.push(waiter);
      if (signal) signal.addEventListener('abort', () => {
        const index = settledWaiters.indexOf(waiter);
        if (index >= 0) settledWaiters.splice(index, 1);
        resolve();
      }, { once: true });
    });
  };

  // A transport may keep its promise pending while Pi is shutting down or
  // replacing a session. Never make a lifecycle hook wait for that transport.
  const stopWatcher = () => {
    watcherAbort?.abort();
    watcher = undefined;
    watcherAbort = undefined;
  };

  const wake = async (piContext, token, signal) => {
    while (sessionId !== undefined && token === generation && !signal.aborted) {
      const deferredRetry = retryAfterChange;
      const pending = await waitForSessionPending(sessionId, 30_000, {
        signal,
        excludeKeys: handledPending,
        skipImmediate: deferredRetry,
      });
      if (sessionId === undefined || token !== generation || signal.aborted) return;
      if (pending.length === 0) {
        if (deferredRetry) retryAfterChange = false;
        continue;
      }
      retryAfterChange = false;
      if (!piContext.isIdle()) {
        const serial = settledSerial;
        await waitForSettled(serial, signal);
        continue;
      }
      if (presenting) continue;
      const keys = inboxKeys(pending);
      presenting = true;
      try {
        const delivered = await presentPendingAtBoundary(
          sessionId,
          async (content) => {
            await pi.sendMessage(
              { customType: 'square', content, display: true },
              { deliverAs: 'steer', triggerTurn: true },
            );
            return true;
          },
        );
        if (delivered === true || delivered === undefined) {
          for (const key of keys) handledPending.add(key);
        }
      } catch {
        // Leave pending evidence untouched so the next state change can retry.
        retryAfterChange = true;
      } finally {
        presenting = false;
      }
    }
  };

  pi.on('session_start', async (_event, ctx) => {
    generation += 1;
    stopWatcher();
    handledPending.clear();
    retryAfterChange = false;
    sessionId = ctx.sessionManager.getSessionId();
    sessionCwd = ctx.cwd || process.cwd();
    previousSessionId = process.env.SQUARE_PI_SESSION_ID;
    process.env.SQUARE_PI_SESSION_ID = sessionId;
    try { joiningContext = await automaticSessionStart('pi', sessionId, sessionCwd); } catch { joiningContext = undefined; }
    watcherAbort = new AbortController();
    const token = generation;
    watcher = wake(ctx, token, watcherAbort.signal).catch(() => undefined);
  });

  pi.on('agent_settled', async () => {
    settledSerial += 1;
    const waiters = settledWaiters;
    settledWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  });

  pi.on('before_agent_start', async () => {
    try {
      if (joiningContext) {
        const context = joiningContext;
        joiningContext = undefined;
        return { message: { customType: 'square', content: context, display: true } };
      }
      if (presenting) return undefined;
      return present((context) => ({ message: { customType: 'square', content: context, display: true } }));
    } catch {
      return undefined;
    }
  });

  pi.on('session_shutdown', async () => {
    generation += 1;
    stopWatcher();
    for (const waiter of settledWaiters) waiter.resolve();
    settledWaiters = [];
    if (sessionId && sessionCwd) await automaticSessionEnd('pi', sessionId, sessionCwd);
    if (process.env.SQUARE_PI_SESSION_ID === sessionId) {
      if (previousSessionId === undefined) delete process.env.SQUARE_PI_SESSION_ID;
      else process.env.SQUARE_PI_SESSION_ID = previousSessionId;
    }
    sessionId = undefined;
    sessionCwd = undefined;
    joiningContext = undefined;
    presenting = false;
  });
}
