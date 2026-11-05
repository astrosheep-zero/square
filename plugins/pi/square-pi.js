import { Markdown } from '@earendil-works/pi-tui';
import { z } from 'zod/v4';

import { Square, discover, squareClock } from '../../dist/square-api.js';
import { harnessOwner } from '../../dist/owner.js';
import { DeliveryLedger } from '../../dist/delivery-ledger.js';
import { deliveryFrameOverhead, renderDeliveryReminder } from '../../dist/delivery-frame.js';
import { isCardPresentation } from '../../dist/card-presentation.js';
import { SQUARE_TOOLS, SQUARE_TOOL_INSTRUCTIONS, createSquareToolRunner, squareToolsEnabled } from '../../dist/square-tools.js';
import { operationEnv } from '../../dist/participant-identity.js';
import { attachDeliverySession, detachDeliverySession } from '../../dist/session-lifecycle.js';
import { createPiReceiver, sendPiMessage } from '../../dist/packages/agent-delivery/src/pi.js';

const BUDGET_CHARS = 12_000;

function displayCard(card) {
  return isCardPresentation(card.details) ? card.details : { text: card.text };
}

export function renderSquareCard(message, { outputPad = 1 }, theme) {
  if (typeof message.content !== 'string') return undefined;
  const color = (name) => (text) => theme.fg?.(name, text) ?? text;
  const style = (name) => (text) => theme[name]?.(text) ?? text;
  return new Markdown(message.content, outputPad, 0, {
    heading: color('mdHeading'), link: color('mdLink'), linkUrl: color('mdLinkUrl'), code: color('mdCode'),
    codeBlock: color('mdCodeBlock'), codeBlockBorder: color('mdCodeBlockBorder'), quote: color('mdQuote'),
    quoteBorder: color('mdQuoteBorder'), hr: color('mdHr'), listBullet: color('mdListBullet'),
    bold: style('bold'), italic: style('italic'), underline: style('underline'), strikethrough: style('strikethrough'),
  });
}

export default function squarePiExtension(pi) {
  const invoke = createSquareToolRunner();
  if (squareToolsEnabled(process.env)) for (const tool of SQUARE_TOOLS) {
    pi.registerTool({
      name: `square_${tool.name}`,
      label: `Square ${tool.name}`,
      description: tool.description,
      parameters: z.toJSONSchema(tool.inputSchema, { target: 'draft-7' }),
      exposure: 'codemode',
      namespace: { name: 'square', description: 'A shared square where agents gather to talk, think, and act together.', instructions: SQUARE_TOOL_INSTRUCTIONS },
      async execute(_id, args, signal, _onUpdate, ctx) {
        const { text, isError } = await invoke(tool, args, { signal }, () => {
          const sessionId = ctx.sessionManager.getSessionId();
          const env = operationEnv('pi', sessionId, process.env);
          return {
            identity: { owner: harnessOwner({ channel: 'pi', session: sessionId }) },
            open: (location, control) => Square.at({
              cwd: ctx.cwd, env, path: location,
            }, control),
            discover: async (options, control) => ({ result: await discover({ cwd: ctx.cwd, env }, options, control), now: squareClock(env)() }),
          };
        });
        return { ...(isError ? { isError } : {}), content: [{ type: 'text', text }] };
      },
    });
  }
  pi.registerMessageRenderer?.('square', renderSquareCard);
  pi.registerFlag('agent-delivery-socket', { type: 'string', description: 'Explicit private local delivery socket' });
  createPiReceiver(pi, { get endpoint() { return pi.getFlag('agent-delivery-socket'); } });

  let session;
  let epoch = 0;
  let watcher;
  let watcherAbort;
  let cancellation = Promise.resolve();
  let cancellationFailed = false;
  let cancelled = false;
  let detachRunAbort;
  let turnIndex = 0;
  let activeTurn;
  const landings = new Map();

  function finishLandings(error) {
    for (const landing of [...landings.values()]) landing.finish(error);
  }
  function waitForLanding(content, signal) {
    let landing;
    const promise = new Promise((resolve, reject) => {
      const abort = () => landing.finish(signal.reason ?? new Error('Pi delivery aborted'));
      landing = {
        sentAfterTurn: turnIndex, emptyTurnWindows: 0,
        finish(error) {
          if (landings.get(content) !== landing) return;
          landings.delete(content);
          signal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve();
        },
      };
      landings.set(content, landing);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    return { promise, landing };
  }
  function stopWatcher() {
    watcherAbort?.abort();
    watcherAbort = undefined;
    return watcher;
  }
  function cancelRun() {
    if (cancelled) return;
    cancelled = true;
    const captured = session;
    epoch += 1;
    stopWatcher();
    finishLandings(new Error('Pi notification delivery cancelled'));
    const signal = AbortSignal.timeout(5000);
    if (captured) cancellation = cancellation.then(async () => {
      if (!await captured.ledger.cancel({ owner: captured.owner, generation: captured.generation }, signal)) throw new Error('Pi cancellation fence lost');
      cancellationFailed = false;
    }).catch(() => { cancellationFailed = true; });
  }
  async function watch(captured, token, signal) {
    const { ledger, owner, generation } = captured;
    const observer = await ledger.observe(owner);
    try {
      while (!signal.aborted && token === epoch) {
        const edge = observer.generation;
        let claim;
        let invoked = false;
        try {
          claim = await ledger.claimPresentation(owner, { generation, budgetChars: BUDGET_CHARS - deliveryFrameOverhead({ tagged: true }), signal });
          if (!claim) {
            await observer.hinted(edge, 2_000, signal);
            continue;
          }
          if (signal.aborted || token !== epoch || !await claim.current(signal) || signal.aborted || token !== epoch) {
            await claim.settle('released');
            continue;
          }
          const items = claim.cards.map(displayCard);
          if (signal.aborted || token !== epoch || !await claim.current(signal) || signal.aborted || token !== epoch) {
            await claim.settle('released');
            continue;
          }
          const content = renderDeliveryReminder(claim.cards.map(card => card.text), { tagged: true });
          const { promise, landing } = waitForLanding(content, signal);
          try {
            invoked = true;
            sendPiMessage(pi, { customType: 'square', content, display: true, details: { items } }, { deliverAs: 'steer', triggerTurn: true });
          } catch (error) { landing.finish(error); }
          await promise;
          await claim.settle('presented');
        } catch (error) {
          if (claim) await claim.settle(invoked ? error?.dropped ? 'failed' : 'unknown' : 'released').catch(() => undefined);
          if (signal.aborted || token !== epoch) return;
          // Avoid re-injecting a failed batch until another ledger edge or reconciliation.
          await observer.hinted(observer.generation, 2_000, signal).catch(() => undefined);
        }
      }
    } finally { observer.close(); }
  }
  function startWatcher(captured, token) {
    watcherAbort = new AbortController();
    watcher = watch(captured, token, watcherAbort.signal).catch(() => undefined);
  }

  pi.on('session_start', async (_event, ctx) => {
    detachRunAbort?.();
    detachRunAbort = undefined;
    cancelled = false;
    const token = ++epoch;
    finishLandings(new Error('Pi session replaced'));
    const stopped = stopWatcher();
    const previous = session;
    session = undefined;
    await stopped;
    await cancellation;
    if (previous) {
      await detachDeliverySession(previous.owner, previous.generation, process.env, AbortSignal.timeout(5000)).catch(() => undefined);
      await previous.ledger.close();
    }
    if (token !== epoch || cancellationFailed) return;
    const owner = harnessOwner({ channel: 'pi', session: ctx.sessionManager.getSessionId() });
    const signal = AbortSignal.timeout(5000);
    const attached = await attachDeliverySession(owner, process.env, undefined, signal);
    if (!attached) return;
    if (token !== epoch) {
      await detachDeliverySession(owner, attached.generation, process.env, AbortSignal.timeout(5000));
      return;
    }
    let ledger;
    try {
      ledger = await DeliveryLedger.open({ signal });
      if (token !== epoch) {
        await detachDeliverySession(owner, attached.generation, process.env, AbortSignal.timeout(5000));
        await ledger.close();
        return;
      }
      session = { ledger, owner, generation: attached.generation };
      turnIndex = 0;
      activeTurn = undefined;
      startWatcher(session, token);
    } catch (error) {
      await detachDeliverySession(owner, attached.generation, process.env, AbortSignal.timeout(5000)).catch(() => undefined);
      await ledger?.close();
      throw error;
    }
  });

  pi.on('agent_start', async (_event, ctx) => {
    detachRunAbort?.();
    if (ctx?.mode !== 'tui' || !ctx.signal) return;
    const signal = ctx.signal;
    detachRunAbort = () => signal.removeEventListener('abort', cancelRun);
    if (signal.aborted) cancelRun(); else signal.addEventListener('abort', cancelRun, { once: true });
  });
  pi.on('message_end', async (event) => {
    const message = event.message;
    if (activeTurn && (message?.role === 'user' || message?.role === 'custom')) activeTurn.hasInput = true;
    if (message?.role === 'custom' && message.customType === 'square' && typeof message.content === 'string') {
      landings.get(message.content)?.finish();
    }
  });
  pi.on('turn_start', async () => { activeTurn = { index: ++turnIndex, hasInput: false }; });
  pi.on('turn_end', async (event, ctx) => {
    const turn = activeTurn;
    activeTurn = undefined;
    if (event.message?.stopReason === 'aborted' && ctx?.mode === 'tui') { cancelRun(); return; }
    if (!turn) return;
    for (const landing of [...landings.values()]) {
      if (turn.index <= landing.sentAfterTurn) continue;
      if (turn.hasInput) landing.emptyTurnWindows = 0;
      else if (++landing.emptyTurnWindows >= 2) landing.finish(Object.assign(new Error('Pi discarded queued notification'), { dropped: true }));
    }
  });
  pi.on('agent_settled', async () => {
    detachRunAbort?.();
    detachRunAbort = undefined;
    if (!cancelled || !session) return;
    const token = epoch;
    await stopWatcher();
    await cancellation;
    if (token !== epoch || !session || cancellationFailed) return;
    cancelled = false;
    startWatcher(session, token);
  });
  pi.on('session_shutdown', async () => {
    detachRunAbort?.();
    detachRunAbort = undefined;
    ++epoch;
    finishLandings(new Error('Pi session ended'));
    const stopped = stopWatcher();
    const ended = session;
    session = undefined;
    await stopped;
    await cancellation;
    if (ended) {
      await detachDeliverySession(ended.owner, ended.generation, process.env, AbortSignal.timeout(5000)).catch(() => undefined);
      await ended.ledger.close();
    }
  });
}
