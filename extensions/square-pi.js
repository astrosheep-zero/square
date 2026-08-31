import { presentPendingAtBoundary, renderPendingAtBoundary } from '../dist/boundary-presentation.js';
import { automaticSessionEnd, automaticSessionStart } from '../dist/automatic-session.js';
import { waitForSessionPending } from '../dist/inbox.js';
import { projectSessionBindings } from '../dist/square-projections.js';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { captureSquareChangeCursor } from '../dist/square-file-adapter.js';

const PI_SEND_TIMEOUT_MS = 5_000;
const DEFAULT_PI_BOUNDARY_TIMEOUT_MS = 2_000;

function sessionBindings(sessionId) {
  return projectSessionBindings({ hostLedger: createHostLedgerPort(), sessionId });
}

function piBoundaryTimeoutMs() {
  const configured = Number.parseInt(process.env.SQUARE_PI_BOUNDARY_TIMEOUT_MS || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PI_BOUNDARY_TIMEOUT_MS;
}

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
  let retryCursor;
  const present = (deliver, signal) => sessionId === undefined ? undefined : presentPendingAtBoundary(sessionId, deliver, undefined, undefined, signal);

  const presentAtBoundary = (deliver) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Pi boundary presentation timed out')), piBoundaryTimeoutMs());
    const pending = present(deliver, controller.signal);
    if (pending === undefined) {
      clearTimeout(timer);
      return undefined;
    }
    return pending.finally(() => clearTimeout(timer));
  };

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

  const pause = (signal, delayMs) => new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener('abort', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });

  const wake = async (piContext, token, signal) => {
    while (sessionId !== undefined && token === generation && !signal.aborted) {
      if ((await sessionBindings(sessionId)).length === 0) {
        await pause(signal, 1_000);
        continue;
      }
      const deferredRetry = retryAfterChange;
      const pending = await waitForSessionPending(sessionId, 30_000, {
        signal,
        excludeKeys: handledPending,
        skipImmediate: deferredRetry,
        ...(deferredRetry && retryCursor !== undefined ? { changeCursor: retryCursor } : {}),
      });
      if (sessionId === undefined || token !== generation || signal.aborted) return;
      if (pending.length === 0) {
        if (deferredRetry) {
          retryAfterChange = false;
          retryCursor = undefined;
        }
        continue;
      }
      retryAfterChange = false;
      retryCursor = undefined;
      if (!piContext.isIdle()) {
        const serial = settledSerial;
        await waitForSettled(serial, signal);
        continue;
      }
      if (presenting) continue;
      const keys = inboxKeys(pending);
      presenting = true;
      const retryBaseline = await captureSquareChangeCursor(pending.map((item) => item.squarePath));
      try {
        const delivered = await presentPendingAtBoundary(
          sessionId,
          async (content) => {
            const send = Promise.resolve(pi.sendMessage(
              { customType: 'square', content, display: true },
              { deliverAs: 'steer', triggerTurn: true },
            ));
            let timer;
            try {
              await Promise.race([
                send,
                new Promise((_, reject) => {
                  if (signal.aborted) {
                    reject(signal.reason || new Error('Pi native injection aborted'));
                    return;
                  }
                  signal.addEventListener('abort', () => reject(signal.reason || new Error('Pi native injection aborted')), { once: true });
                }),
                new Promise((_, reject) => {
                  timer = setTimeout(() => reject(new Error('Pi native injection timed out')), PI_SEND_TIMEOUT_MS);
                }),
              ]);
            } finally {
              if (timer !== undefined) clearTimeout(timer);
            }
            return true;
          },
          undefined,
          undefined,
          signal,
        );
        if (delivered === true || delivered === undefined) {
          for (const key of keys) handledPending.add(key);
        }
      } catch {
        // Leave pending evidence untouched so the next state change can retry.
        retryAfterChange = true;
        retryCursor = retryBaseline;
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
    retryCursor = undefined;
    sessionId = ctx.sessionManager.getSessionId();
    sessionCwd = ctx.cwd || process.cwd();
    previousSessionId = process.env.SQUARE_PI_SESSION_ID;
    process.env.SQUARE_PI_SESSION_ID = sessionId;
    joiningContext = undefined;
    void automaticSessionStart('pi', sessionId, sessionCwd).catch(() => undefined);
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
      return await presentAtBoundary((context) => ({ message: { customType: 'square', content: context, display: true } }));
    } catch {
      return undefined;
    }
  });

  pi.on('session_shutdown', async () => {
    generation += 1;
    stopWatcher();
    for (const waiter of settledWaiters) waiter.resolve();
    settledWaiters = [];
    if (sessionId && sessionCwd) void automaticSessionEnd('pi', sessionId, sessionCwd).catch(() => undefined);
    if (process.env.SQUARE_PI_SESSION_ID === sessionId) {
      if (previousSessionId === undefined) delete process.env.SQUARE_PI_SESSION_ID;
      else process.env.SQUARE_PI_SESSION_ID = previousSessionId;
    }
    sessionId = undefined;
    sessionCwd = undefined;
    joiningContext = undefined;
    presenting = false;
    retryCursor = undefined;
  });
}
