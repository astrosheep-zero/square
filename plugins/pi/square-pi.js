import path from 'node:path';
import { Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui';
import { z } from 'zod/v4';

import { Square, harnessOwner, withDefaultWakeTransport } from '../../dist/square-api.js';
import { SQUARE_TOOLS, SQUARE_TOOL_INSTRUCTIONS, squareToolFailure, squareToolFailureText } from '../../dist/square-tools.js';

import { presentPendingAtBoundary, renderPendingAtBoundary } from '../../dist/boundary-presentation.js';
import { operationEnv } from '../../dist/participant-identity.js';
import { detachSessionSeats, restoreSessionSeats } from '../../dist/session-lifecycle.js';
import { projectSessionSeats, observeSessionPending, pendingKey } from '../../dist/inbox.js';
import { previewAttentionBody, renderAttentionDescription, renderAttentionFull } from '../../dist/attention-presentation.js';
import { formatActivityId } from '../../dist/square-core.js';
import { createPiReceiver, sendPiMessage } from '../../dist/packages/agent-delivery/src/pi.js';

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
    pendingKey(item, note.actIndex)
  ));
}

export function renderPiInbox(inbox) {
  return renderPendingAtBoundary(pendingInbox(inbox));
}

function framePiMessage(content) {
  return `\n${content.replace(/^\n+/, '').replace(/\n+$/, '')}\n`;
}

/** Renderer-only card facts for Pi and Paseo; Pi never sends `details` to the model. */
export function pendingCardDetails(pending) {
  const items = pending.flatMap((membership) => membership.notifications.map((note) => ({
    square: path.basename(membership.location, '.square'),
    actor: note.actor,
    recipient: membership.seat.participant,
    route: note.route,
    act: formatActivityId(note.actIndex),
    preview: previewAttentionBody(note.body),
    description: renderAttentionDescription({ actor: note.actor, route: note.route }),
    body: note.body,
  })));
  if (items.length === 0) return undefined;
  const fullText = pending.flatMap((membership) => membership.notifications.map((note) => renderAttentionFull({
    squarePath: membership.location,
    actIndex: note.actIndex,
    recipient: membership.seat.participant,
    ...note,
  }))).join('\n\n');
  return { items, fullText };
}

// Conservative terminal width: anything outside ASCII counts as two columns, so a
// truncated line never exceeds the viewport (Pi stops the TUI when a line overflows).
const columnsOf = (char) => (char.charCodeAt(0) < 0x80 ? 1 : 2);
const widthOf = (text) => Array.from(text).reduce((sum, char) => sum + columnsOf(char), 0);

function fitColumns(text, columns) {
  if (widthOf(text) <= columns) return text;
  let used = 1; // the ellipsis
  let out = '';
  for (const char of text) {
    if (used + columnsOf(char) > columns) break;
    used += columnsOf(char);
    out += char;
  }
  return `${out}…`;
}

const fg = (theme, color, text) => theme.fg?.(color, text) ?? text;
const style = (theme, name) => (text) => theme[name]?.(text) ?? text;

function markdownTheme(theme) {
  const color = (name) => (text) => fg(theme, name, text);
  return {
    heading: color('mdHeading'), link: color('mdLink'), linkUrl: color('mdLinkUrl'), code: color('mdCode'),
    codeBlock: color('mdCodeBlock'), codeBlockBorder: color('mdCodeBlockBorder'), quote: color('mdQuote'),
    quoteBorder: color('mdQuoteBorder'), hr: color('mdHr'), listBullet: color('mdListBullet'),
    bold: style(theme, 'bold'), italic: style(theme, 'italic'), underline: style(theme, 'underline'),
    strikethrough: style(theme, 'strikethrough'),
  };
}

/** One styled line that never exceeds the width; truncated lines stay unstyled so escapes are never cut. */
function fitLine(parts, width) {
  const plain = parts.map(([text]) => text).join('');
  return widthOf(plain) <= width ? parts.map(([text, paint]) => paint(text)).join('') : fitColumns(plain, width);
}

/**
 * Collapsed: who reached you and where, then the first line of what they said.
 * Expanded: each activity as a heading line and its Markdown body; the model's
 * framing and continuation hints are not for human eyes.
 */
export function renderSquareCard(message, { expanded, outputPad = 1 }, theme) {
  const items = message.details?.items;
  if (!Array.isArray(items) || items.length === 0 || items.some((item) => typeof item.body !== 'string')) return undefined;
  const pad = ' '.repeat(outputPad);
  const dim = (text) => fg(theme, 'dim', text);
  if (!expanded) {
    const [first] = items;
    const more = items.length > 1 ? ` +${items.length - 1}` : '';
    // A glance, not a render: drop the commonest inline markers so the line reads as speech.
    const opening = (first.body.split('\n').find((line) => line.trim() !== '') ?? '')
      .trim().replace(/^(#{1,6}|>|[-*+])\s+/, '').replace(/\*\*|__|`/g, '');
    return {
      invalidate() {},
      render(width) {
        const room = Math.max(1, width - outputPad * 2 - 2);
        return [
          `${pad}${fg(theme, 'customMessageLabel', '■')} ${fitLine([[first.description, (t) => t], [` · ${first.square} · ${first.recipient}${more}`, dim]], room)}`,
          ...(opening ? [`${pad}  ${fitLine([[opening, dim]], room)}`] : []),
        ];
      },
    };
  }
  const card = new Container();
  for (const [index, item] of items.entries()) {
    if (index > 0) card.addChild(new Spacer(1));
    card.addChild({
      invalidate() {},
      render(width) {
        const room = Math.max(1, width - outputPad * 2 - 2);
        return [`${pad}${fg(theme, 'customMessageLabel', '●')} ${fitLine([[item.description, (t) => t], [`  ${item.square} · ${item.recipient} · ${item.act}`, dim]], room)}`];
      },
    });
    card.addChild(new Spacer(1));
    card.addChild(new Markdown(item.body, outputPad + 2, 0, markdownTheme(theme)));
  }
  return card;
}

export default function squarePiExtension(pi) {
  for (const tool of SQUARE_TOOLS) {
    pi.registerTool({
      name: `square_${tool.name}`,
      label: `Square ${tool.name}`,
      description: tool.description,
      parameters: z.toJSONSchema(tool.inputSchema, { target: 'draft-7' }),
      exposure: 'codemode',
      namespace: { name: 'square', description: 'A shared square where agents gather to talk, think, and act together.', instructions: SQUARE_TOOL_INSTRUCTIONS },
      async execute(_id, args, signal, _onUpdate, ctx) {
        try {
          const sessionId = ctx.sessionManager.getSessionId();
          const square = await Square.at(await withDefaultWakeTransport({
            cwd: ctx.cwd,
            env: operationEnv('pi', sessionId, process.env),
            path: args.location,
          }), { signal });
          let text;
          try { text = await tool.run(square, args, { signal }, { owner: harnessOwner({ channel: 'pi', session: sessionId }) }); }
          finally { await square.close(); }
          return { content: [{ type: 'text', text }] };
        } catch (error) {
          const failure = squareToolFailure(error, signal);
          return { isError: true, content: [{ type: 'text', text: squareToolFailureText(failure, { location: args.location ?? process.env.SQUARE_LOCATION, participant: args.as }) }] };
        }
      },
    });
  }
  pi.registerMessageRenderer?.('square', renderSquareCard);
  pi.registerFlag('agent-delivery-socket', { type: 'string', description: 'Explicit private local delivery socket' });
  createPiReceiver(pi, {
    get endpoint() { return pi.getFlag('agent-delivery-socket'); },
  });
  let sessionId;
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
  let pendingCancellations = new Map();
  const cancellationFailures = new Set();

  const cancelRunDelivery = () => {
    if (cancelledRun) return;
    cancelledRun = true;
    for (const key of observedPending) handledPending.add(key);
    persistSessionCancellation(sessionId);
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

  const persistSessionCancellation = (id) => {
    if (id === undefined) return Promise.resolve();
    const previous = pendingCancellations.get(id) ?? Promise.resolve();
    let operation;
    operation = previous.then(async () => {
      const owner = harnessOwner({ channel: 'pi', session: id });
      const env = sessionEnv(id);
      const seats = await projectSessionSeats({ owner, env });
      for (const { location, seat } of seats) {
        if (seat.attachment !== 'attached') continue;
        const square = await Square.at(await withDefaultWakeTransport({ path: location, env }));
        try { await square.cancelDeliveries(seat.participant, { owner, generation: seat.generation }); }
        finally { await square.close(); }
      }
    }).then(() => {
      cancellationFailures.delete(id);
    }, () => {
      cancellationFailures.add(id);
    }).finally(() => {
      if (pendingCancellations.get(id) === operation) pendingCancellations.delete(id);
    });
    pendingCancellations.set(id, operation);
    return operation;
  };

  const waitForSessionCancellation = async (id) => {
    if (id === undefined) return true;
    while (true) {
      const pending = pendingCancellations.get(id);
      if (pending !== undefined) await pending;
      if (pendingCancellations.get(id) !== pending) continue;
      return !cancellationFailures.has(id);
    }
  };

  // Aborting releases native landing waits; retain cleanup until the observer
  // has closed, including when cancellation precedes a lifecycle hook.
  const stopWatcher = () => {
    watcherAbort?.abort();
    watcherAbort = undefined;
    return watcher;
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
    const observer = await observeSessionPending(harnessOwner({ channel: 'pi', session: boundSessionId }), env);
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
            harnessOwner({ channel: 'pi', session: boundSessionId }),
            async (content) => {
              if (signal.aborted || currentRunSignal?.aborted) throw new Error('Pi notification delivery cancelled');
              // One card for the human: a compact heading, expandable to the full body.
              // Model context stays bounded; renderer-only details carry the complete text.
              const messageContent = framePiMessage(content);
              const landing = waitForLanding(messageContent, signal, 'steer');
              try {
                sendPiMessage(pi,
                  { customType: 'square', content: messageContent, display: true, details: pendingCardDetails(pending) },
                  { deliverAs: 'steer', triggerTurn: true },
                );
              } catch (error) {
                landing.ack.settle(error);
              }
              return landing.promise;
            },
            async (_id, _env, boundarySignal) => {
              // Recheck committed revisions and current bindings before reusing observed content.
              const inbox = await observer.read({ signal: boundarySignal, excludeKeys: handledPending });
              if (signal.aborted || token !== generation) return [];
              for (const key of inboxKeys(inbox)) observedPending.add(key);
              pending = inbox;
              return inbox;
            },
            env,
            signal,
          );
          if (signal.aborted || token !== generation) return;
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
    const stopped = stopWatcher();
    handledPending.clear();
    observedPending.clear();
    retryAfterChange = false;
    retryWait = undefined;
    turnIndex = 0;
    activeTurn = undefined;
    currentRunSignal = undefined;
    sessionId = ctx.sessionManager.getSessionId();
    const token = generation;
    await stopped;
    await waitForSessionCancellation(sessionId);
    if (token !== generation || cancellationFailures.has(sessionId)) return;
    watcherAbort = new AbortController();
    const signal = watcherAbort.signal;
    await restoreSessionSeats(harnessOwner({ channel: 'pi', session: sessionId }), sessionEnv(sessionId), undefined, signal).catch(() => undefined);
    if (token !== generation || signal.aborted) return;
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
    await stopWatcher();
    await waitForSessionCancellation(sessionId);
    if (token !== generation || sessionId === undefined || cancellationFailures.has(sessionId)) return;
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
    const stopped = stopWatcher();
    const endedId = sessionId;
    const endedEnv = sessionEnv(endedId);
    sessionId = undefined;
    retryWait = undefined;
    activeTurn = undefined;
    currentRunSignal = undefined;
    await stopped;
    await waitForSessionCancellation(endedId);
    if (endedId) await detachSessionSeats('pi', endedId, endedEnv).catch(() => undefined);
  });
}
