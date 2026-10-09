import { presentPendingAtBoundary, renderPendingAtBoundary } from '../dist/boundary-presentation.js';
import { automaticSessionEnd, automaticSessionStart } from '../dist/automatic-session.js';
import { sessionInbox, observeSessionPending } from '../dist/inbox.js';
import { renderAttentionDescription } from '../dist/attention-presentation.js';
import { createPiReceiver, sendPiMessage } from '../dist/packages/agent-delivery/src/pi.js';

class PiDeliveryDroppedError extends Error {
  constructor() {
    super('Pi discarded the queued Square notification');
    this.name = 'PiDeliveryDroppedError';
  }
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

const NOTIFY_BODY_MAX = 80;

function framePiMessage(content) {
  return `\n${content.replace(/^\n+/, '').replace(/\n+$/, '')}\n`;
}

export function summarizePendingForNotify(pending) {
  const lines = pending.flatMap((membership) => membership.notifications.map((note) => {
    const description = renderAttentionDescription({ actor: note.actor, recipient: membership.name, route: note.route });
    const body = note.body.replace(/\s+/g, ' ').trim();
    const clipped = body.length > NOTIFY_BODY_MAX ? `${body.slice(0, NOTIFY_BODY_MAX).trimEnd()}…` : body;
    return `${description}${clipped ? ` — ${clipped}` : ''}`;
  }));
  if (lines.length === 0) return undefined;
  return lines.length === 1 ? `■ square · ${lines[0]}` : `■ square · ${lines[0]} (+${lines.length - 1} more)`;
}

export default function squarePiExtension(pi) {
  pi.registerFlag('agent-delivery-socket', { type: 'string', description: 'Explicit private local delivery socket' });
  createPiReceiver(pi, {
    get endpoint() { return pi.getFlag('agent-delivery-socket'); },
  });
  let sessionId;
  let sessionCwd;
  let ui;
  let watcher;
  let watcherAbort;
  let generation = 0;
  const handledPending = new Set();
  const observedPending = new Set();
  const landingAcks = new Map();
  let retryAfterChange = false;
  let retryWait;
  let turnIndex = 0;
  let activeTurn;
  let currentRunSignal;
  let detachRunAbort;
  let cancelledRun = false;

  const cancelRunDelivery = () => {
    cancelledRun = true;
    for (const key of observedPending) handledPending.add(key);
    generation += 1;
    stopWatcher();
    failAcks(new Error('Pi notification delivery cancelled'));
    retryAfterChange = false;
    retryWait = undefined;
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

  // Each operation carries its own session coordinate. Never rewrite the process environment:
  // Pi owns PI_SESSION_ID and several SDK sessions may coexist in one process.
  const sessionEnv = (id) => ({ ...process.env, ...(id === undefined ? {} : { PI_SESSION_ID: id }) });

  // A transport may keep its promise pending while Pi is shutting down or
  // replacing a session. Never make a lifecycle hook wait for that transport.
  const stopWatcher = () => {
    watcherAbort?.abort();
    watcher = undefined;
    watcherAbort = undefined;
  };

  const pause = (signal, delayMs) => new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => {
      signal.removeEventListener('abort', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });

  const wake = async (token, signal) => {
    const boundSessionId = sessionId;
    const env = sessionEnv(boundSessionId);
    const observer = await observeSessionPending(boundSessionId, env);
    try {
      if (signal.aborted || token !== generation) return;
      const armDeferredRetry = () => {
        const controller = new AbortController();
        let resolveArmed;
        const armed = new Promise((resolve) => { resolveArmed = resolve; });
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        const pending = observer.wait(Infinity, {
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
        const deferredRetry = retryAfterChange;
        let pending;
        try {
          pending = deferredRetry && retryWait !== undefined
            ? await retryWait
            : await observer.wait(Infinity, { signal, excludeKeys: handledPending });
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
        for (const key of keys) observedPending.add(key);
        const deferred = armDeferredRetry();
        const retryArmed = await deferred.armed;
        if (!retryArmed) {
          deferred.cancel();
          continue;
        }
        let keepDeferred = false;
        try {
          await presentPendingAtBoundary(
            boundSessionId,
            async (content) => {
              if (signal.aborted || currentRunSignal?.aborted) throw new Error('Pi notification delivery cancelled');
              // The full activity stays out of the TUI stream (display: false) but still
              // reaches the model; a brief notify tells the human what just landed.
              const summary = summarizePendingForNotify(pending);
              if (summary) ui?.notify?.(summary, 'info');
              const messageContent = framePiMessage(content);
              const landing = waitForLanding(messageContent, signal, 'steer');
              try {
                sendPiMessage(pi,
                  { customType: 'square', content: messageContent, display: false },
                  { deliverAs: 'steer', triggerTurn: true },
                );
              } catch (error) {
                landing.ack.settle(error);
              }
              return landing.promise;
            },
            async (id, env) => {
              const inbox = await sessionInbox(id, env ?? sessionEnv(id));
              if (signal.aborted || token !== generation) return [];
              for (const key of inboxKeys(inbox)) observedPending.add(key);
              return inbox.map((membership) => ({
                ...membership,
                notifications: membership.notifications.filter((note) => !handledPending.has(
                  `${membership.squarePath}\u0000${membership.name.toLocaleLowerCase()}\u0000${note.actIndex}`,
                )),
              }));
            },
            env,
            signal,
          );
          for (const key of keys) handledPending.add(key);
        } catch (error) {
          if (signal.aborted || token !== generation) return;
          if (error instanceof PiDeliveryDroppedError) {
            deferred.cancel();
            continue;
          }
          // The next state edge is already being observed before native injection starts.
          retryAfterChange = true;
          retryWait = deferred.pending;
          keepDeferred = true;
        } finally {
          if (!keepDeferred) { deferred.cancel(); await deferred.pending; }
        }
      }
    } finally { observer.close(); }
  };

  pi.on('session_start', async (_event, ctx) => {
    detachRunAbort?.();
    cancelledRun = false;
    generation += 1;
    failAcks(new Error('Pi session replaced'));
    stopWatcher();
    handledPending.clear();
    observedPending.clear();
    retryAfterChange = false;
    retryWait = undefined;
    turnIndex = 0;
    activeTurn = undefined;
    currentRunSignal = undefined;
    ui = ctx?.ui;
    sessionId = ctx.sessionManager.getSessionId();
    sessionCwd = ctx.cwd || process.cwd();
    const token = generation;
    watcherAbort = new AbortController();
    const signal = watcherAbort.signal;
    void automaticSessionStart('pi', sessionId, sessionCwd, sessionEnv(sessionId)).then((context) => {
      if (context === undefined || sessionId === undefined || token !== generation) return;
      const messageContent = framePiMessage(context);
      const landing = waitForLanding(messageContent, signal, 'nextTurn');
      try {
        sendPiMessage(pi,
          { customType: 'square', content: messageContent, display: true },
          { deliverAs: 'nextTurn' },
        );
      } catch {
        // Joining context is advisory; an unavailable Pi transport does not block startup.
        landing.ack.settle(new Error('Pi joining-context injection failed'));
      }
      void landing.promise.catch(() => undefined);
    }).catch(() => undefined);
    watcher = wake(token, signal).catch(() => undefined);
  });

  pi.on('agent_start', async (_event, ctx) => {
    detachRunAbort?.();
    currentRunSignal = ctx?.signal;
    if (ctx?.mode !== 'tui' || currentRunSignal === undefined) return;
    const runSignal = currentRunSignal;
    detachRunAbort = () => runSignal.removeEventListener('abort', cancelRunDelivery);
    if (runSignal.aborted) cancelRunDelivery();
    else runSignal.addEventListener('abort', cancelRunDelivery, { once: true });
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
    if (event.message?.stopReason === 'aborted' && ctx?.mode === 'tui') {
      if (!cancelledRun) cancelRunDelivery();
      return;
    }
    if (turn === undefined) return;
    for (const ack of acks) {
      if (ack.kind !== 'steer' || turn.index <= ack.sentAfterTurn) continue;
      if (turn.hasInput) {
        ack.emptyTurnWindows = 0;
      } else {
        ack.emptyTurnWindows += 1;
        if (ack.emptyTurnWindows >= 2) ack.settle(new PiDeliveryDroppedError());
      }
    }
  });

  pi.on('agent_settled', async () => {
    detachRunAbort?.();
    detachRunAbort = undefined;
    currentRunSignal = undefined;
    if (!cancelledRun || sessionId === undefined) return;
    const token = generation;
    // Cancel the entire pending batch, including entries not yet sent to Pi.
    // This is local suppression, never evidence that the model saw the activity.
    const cancelled = await sessionInbox(sessionId, sessionEnv(sessionId));
    if (token !== generation || sessionId === undefined) return;
    for (const key of inboxKeys(cancelled)) handledPending.add(key);
    cancelledRun = false;
    watcherAbort = new AbortController();
    watcher = wake(token, watcherAbort.signal).catch(() => undefined);
  });

  pi.on('session_shutdown', async () => {
    detachRunAbort?.();
    detachRunAbort = undefined;
    cancelledRun = false;
    generation += 1;
    failAcks(new Error('Pi session ended'));
    stopWatcher();
    ui = undefined;
    if (sessionId && sessionCwd) void automaticSessionEnd('pi', sessionId, sessionCwd, sessionEnv(sessionId)).catch(() => undefined);
    sessionId = undefined;
    sessionCwd = undefined;
    retryWait = undefined;
    activeTurn = undefined;
    currentRunSignal = undefined;
  });
}
