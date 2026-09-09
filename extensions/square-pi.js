import { presentPendingAtBoundary, renderPendingAtBoundary } from '../dist/boundary-presentation.js';
import { automaticSessionEnd, automaticSessionStart } from '../dist/automatic-session.js';
import { waitForSessionPending } from '../dist/inbox.js';
import { projectSessionBindings } from '../dist/square-projections.js';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';

class PiDeliveryDroppedError extends Error {
  constructor() {
    super('Pi discarded the queued Square notification');
    this.name = 'PiDeliveryDroppedError';
  }
}

function sessionBindings(sessionId) {
  return projectSessionBindings({ hostLedger: createHostLedgerPort(), sessionId });
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
  let previousSessionId;
  let watcher;
  let watcherAbort;
  let generation = 0;
  const handledPending = new Set();
  const landingAcks = new Map();
  let retryAfterChange = false;
  let retryWait;
  let turnIndex = 0;
  let activeTurn;
  let currentRunSignal;
  const deferredSteers = new Set();

  const waitForAgentSettled = (signal) => new Promise((resolve, reject) => {
    const deferred = {
      release() {
        deferredSteers.delete(deferred);
        signal.removeEventListener('abort', abort);
        resolve();
      },
    };
    const abort = () => {
      deferredSteers.delete(deferred);
      signal.removeEventListener('abort', abort);
      reject(signal.reason || new Error('Pi native injection aborted'));
    };
    deferredSteers.add(deferred);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });

  const releaseDeferredSteers = () => {
    for (const deferred of [...deferredSteers]) deferred.release();
  };

  const failAcks = (error) => {
    const acks = [...landingAcks.values()].flatMap((waiters) => [...waiters]);
    for (const ack of acks) ack.settle(error);
  };

  const acknowledgeLanding = (message) => {
    if (message?.role !== 'custom' || message.customType !== 'square' || typeof message.content !== 'string') return;
    const acks = landingAcks.get(message.content);
    if (acks === undefined) return;
    for (const ack of [...acks]) ack.settle();
  };

  const waitForLanding = (content, signal, kind) => {
    let ack;
    const promise = new Promise((resolve, reject) => {
      const abort = () => ack.settle(signal.reason || new Error('Pi native injection aborted'));
      ack = {
        kind,
        sentAfterTurn: turnIndex,
        emptyTurnWindows: 0,
        dropAfterSettled: false,
        settle(error) {
          if (ack.settled) return;
          ack.settled = true;
          signal.removeEventListener('abort', abort);
          const acks = landingAcks.get(content);
          if (acks?.delete(ack) && acks.size === 0) landingAcks.delete(content);
          if (error === undefined) resolve();
          else reject(error);
        },
      };
      let acks = landingAcks.get(content);
      if (acks === undefined) {
        acks = new Set();
        landingAcks.set(content, acks);
      }
      acks.add(ack);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
    return { promise, ack };
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

  const wake = async (token, signal) => {
    const armDeferredRetry = () => {
      const controller = new AbortController();
      let resolveArmed;
      const armed = new Promise((resolve) => { resolveArmed = resolve; });
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const pending = waitForSessionPending(sessionId, 30_000, {
        signal: controller.signal,
        excludeKeys: handledPending,
        skipImmediate: true,
        onChangeArmed: resolveArmed,
      }).catch(() => {
        resolveArmed(false);
        return [];
      }).finally(() => signal.removeEventListener('abort', abort));
      return { armed, pending, cancel: () => controller.abort() };
    };

    while (sessionId !== undefined && token === generation && !signal.aborted) {
      try {
        if ((await sessionBindings(sessionId)).length === 0) {
          await pause(signal, 1_000);
          continue;
        }
      } catch {
        await pause(signal, 1_000);
        continue;
      }

      const deferredRetry = retryAfterChange;
      let pending;
      try {
        pending = deferredRetry && retryWait !== undefined
          ? await retryWait
          : await waitForSessionPending(sessionId, 30_000, { signal, excludeKeys: handledPending });
      } catch {
        await pause(signal, 1_000);
        continue;
      }
      if (sessionId === undefined || token !== generation || signal.aborted) return;
      if (pending.length === 0) {
        if (deferredRetry) {
          retryAfterChange = false;
          retryWait = undefined;
        }
        continue;
      }
      retryAfterChange = false;
      retryWait = undefined;

      const keys = inboxKeys(pending);
      const deferred = armDeferredRetry();
      const retryArmed = await deferred.armed;
      if (!retryArmed) {
        deferred.cancel();
        continue;
      }
      let keepDeferred = false;
      try {
        await presentPendingAtBoundary(
          sessionId,
          async (content) => {
            if (currentRunSignal?.aborted) await waitForAgentSettled(signal);
            const landing = waitForLanding(content, signal, 'steer');
            try {
              Promise.resolve(pi.sendMessage(
                { customType: 'square', content, display: true },
                { deliverAs: 'steer', triggerTurn: true },
              )).catch((error) => landing.ack.settle(error));
            } catch (error) {
              landing.ack.settle(error);
            }
            return landing.promise;
          },
          undefined,
          undefined,
          signal,
        );
        for (const key of keys) handledPending.add(key);
      } catch (error) {
        if (error instanceof PiDeliveryDroppedError) {
          deferred.cancel();
          continue;
        }
        // The next state edge is already being observed before native injection starts.
        retryAfterChange = true;
        retryWait = deferred.pending;
        keepDeferred = true;
      } finally {
        if (!keepDeferred) deferred.cancel();
      }
    }
  };

  pi.on('session_start', async (_event, ctx) => {
    generation += 1;
    failAcks(new Error('Pi session replaced'));
    stopWatcher();
    handledPending.clear();
    retryAfterChange = false;
    retryWait = undefined;
    turnIndex = 0;
    activeTurn = undefined;
    currentRunSignal = undefined;
    sessionId = ctx.sessionManager.getSessionId();
    sessionCwd = ctx.cwd || process.cwd();
    previousSessionId = process.env.SQUARE_PI_SESSION_ID;
    process.env.SQUARE_PI_SESSION_ID = sessionId;
    const token = generation;
    watcherAbort = new AbortController();
    const signal = watcherAbort.signal;
    void automaticSessionStart('pi', sessionId, sessionCwd).then((context) => {
      if (context === undefined || sessionId === undefined || token !== generation) return;
      const landing = waitForLanding(context, signal, 'nextTurn');
      try {
        Promise.resolve(pi.sendMessage(
          { customType: 'square', content: context, display: true },
          { deliverAs: 'nextTurn' },
        )).catch((error) => landing.ack.settle(error));
      } catch {
        // Joining context is advisory; an unavailable Pi transport does not block startup.
        landing.ack.settle(new Error('Pi joining-context injection failed'));
      }
      void landing.promise.catch(() => undefined);
    }).catch(() => undefined);
    watcher = wake(token, signal).catch(() => undefined);
  });

  pi.on('agent_start', async (_event, ctx) => {
    currentRunSignal = ctx?.getSignal?.();
  });

  pi.on('message_end', async (event) => {
    if (activeTurn !== undefined && (event.message?.role === 'user' || event.message?.role === 'custom')) {
      activeTurn.hasInput = true;
    }
    acknowledgeLanding(event.message);
  });

  pi.on('turn_start', async () => {
    turnIndex += 1;
    activeTurn = { index: turnIndex, hasInput: false, signal: currentRunSignal };
  });

  pi.on('turn_end', async (event, ctx) => {
    const turn = activeTurn;
    activeTurn = undefined;
    const acks = [...landingAcks.values()].flatMap((waiters) => [...waiters]);
    if (event.message?.stopReason === 'aborted' && ctx?.mode === 'tui' && turn?.signal !== undefined) {
      for (const ack of acks) {
        if (ack.kind === 'steer') ack.dropAfterSettled = true;
      }
      return;
    }
    if (turn === undefined) return;
    for (const ack of acks) {
      if (ack.kind !== 'steer' || ack.dropAfterSettled || turn.index <= ack.sentAfterTurn) continue;
      if (turn.hasInput) {
        ack.emptyTurnWindows = 0;
      } else {
        ack.emptyTurnWindows += 1;
        if (ack.emptyTurnWindows >= 2) ack.settle(new PiDeliveryDroppedError());
      }
    }
  });

  pi.on('agent_settled', async () => {
    currentRunSignal = undefined;
    const acks = [...landingAcks.values()].flatMap((waiters) => [...waiters]);
    for (const ack of acks) {
      if (ack.dropAfterSettled) ack.settle(new PiDeliveryDroppedError());
    }
    releaseDeferredSteers();
  });

  pi.on('session_shutdown', async () => {
    generation += 1;
    failAcks(new Error('Pi session ended'));
    stopWatcher();
    if (sessionId && sessionCwd) void automaticSessionEnd('pi', sessionId, sessionCwd).catch(() => undefined);
    if (process.env.SQUARE_PI_SESSION_ID === sessionId) {
      if (previousSessionId === undefined) delete process.env.SQUARE_PI_SESSION_ID;
      else process.env.SQUARE_PI_SESSION_ID = previousSessionId;
    }
    sessionId = undefined;
    sessionCwd = undefined;
    retryWait = undefined;
    activeTurn = undefined;
    currentRunSignal = undefined;
  });
}
