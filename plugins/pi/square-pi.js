import { Box, Markdown, stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { activityLabel, reachLabel, shortOrigin, timeLabel } from '../../dist/card-format.js';
import { z } from 'zod/v4';

import { Square, discover } from '../../dist/square-api.js';
import { harnessOwner } from '../../dist/owner.js';
import { DeliveryLedger } from '../../dist/delivery-ledger.js';
import { deliveryFrameOverhead, renderDeliveryReminder } from '../../dist/delivery-frame.js';
import { isCardPresentation } from '../../dist/card-presentation.js';
import { SQUARE_TOOLS, SQUARE_TOOL_INSTRUCTIONS, createSquareToolRunner, squareToolsEnabled } from '../../dist/square-tools.js';
import { attachDeliverySessionRoutes, detachDeliverySession } from '../../dist/session-lifecycle.js';
import { createPiReceiver, sendPiMessage } from '../../dist/packages/agent-delivery/src/pi.js';

const BUDGET_CHARS = 12_000;

function displayCard(card) {
  return isCardPresentation(card.details) ? card.details : { text: card.text };
}

const fg = (theme, name) => (text) => theme.fg?.(name, text) ?? text;
const style = (theme, name) => (text) => theme[name]?.(text) ?? text;

function markdownTheme(theme) {
  const color = (name) => fg(theme, name);
  return {
    heading: color('mdHeading'), link: color('mdLink'), linkUrl: color('mdLinkUrl'), code: color('mdCode'),
    codeBlock: color('mdCodeBlock'), codeBlockBorder: color('mdCodeBlockBorder'), quote: color('mdQuote'),
    quoteBorder: color('mdQuoteBorder'), hr: color('mdHr'), listBullet: color('mdListBullet'),
    // The inline parser has already applied the body foreground; let muted win without dropping bold/link styles.
    bold: style(theme, 'bold'), italic: (text) => fg(theme, 'muted')(style(theme, 'italic')(
      text.replace(/\x1b\[(?:38;[\d;]+|3[0-79]|9[0-7])m/g, ''))),
    underline: style(theme, 'underline'), strikethrough: style(theme, 'strikethrough'),
  };
}

/** Keep the right-hand tally or reference intact before truncating the left group. */
function cardHeader(left, right, width, author = '') {
  if (!right) return truncateToWidth(left, width, '…');
  const rightWidth = visibleWidth(right);
  if (rightWidth + 1 >= width) return truncateToWidth(right, width, '…');
  const leftWidth = width - rightWidth - 1;
  const label = truncateToWidth(visibleWidth(author) >= leftWidth ? author : left, leftWidth, '…');
  return `${label}${' '.repeat(width - visibleWidth(label) - rightWidth)}${right}`;
}

/** A final fence also covers very narrow terminals and Markdown tables/code. */
function bounded(component) {
  return {
    invalidate() { component.invalidate?.(); },
    render(width) { return component.render(Math.max(1, width)).map(line => truncateToWidth(line, Math.max(0, width), '…')); },
  };
}

/** Human display only: model-facing content and delivery receipts are independent. */
export function renderSquareCard(message, { expanded, outputPad = 1 }, theme) {
  if (typeof message.content !== 'string') return undefined;
  const items = message.details?.items;
  if (!Array.isArray(items) || items.length === 0
    || items.some(item => !isCardPresentation(item) && typeof item?.text !== 'string')) {
    return bounded(new Markdown(message.content, outputPad, 0, markdownTheme(theme)));
  }
  const presentations = items.filter(isCardPresentation);
  const origins = [...new Set(presentations.map(item => item.origin))];
  const originName = origins.map(shortOrigin).join(', ') || 'Notification';
  const tally = items.length < 2 ? '' : items.length <= 5 ? '▪'.repeat(items.length) : `▪ ${items.length}`;
  const left = `${fg(theme, 'accent')('■')} ${fg(theme, 'muted')(originName)}`;
  const now = Date.now();
  const messages = items.map(item => {
    const structured = isCardPresentation(item);
    const direct = structured && reachLabel(item.reach) !== undefined;
    const guide = fg(theme, 'warning')('│ ');
    const name = structured && item.author !== undefined
      ? fg(theme, 'accent')(style(theme, 'bold')(item.author)) : '';
    const label = structured ? activityLabel(item.reach, item.recipient, item.replyTo, item.label) : '';
    const styledLabel = label ? fg(theme, 'warning')(label) : '';
    const time = structured && item.at !== undefined ? fg(theme, 'dim')(`· ${timeLabel(item.at, now, true)}`) : '';
    return {
      name,
      byline: structured ? [name, styledLabel, time].filter(Boolean).join(' ') : undefined,
      ref: structured && item.ref !== undefined ? fg(theme, 'dim')(item.ref) : '',
      markdown: new Markdown(structured ? item.body : item.text, 0, 0, markdownTheme(theme), { color: fg(theme, 'customMessageText') }),
      guide: direct ? guide : `\x1b[2m${guide}\x1b[22m`,
    };
  });
  const box = new Box(outputPad, 1, text => theme.bg?.('customMessageBg', text) ?? text);
  box.addChild({
    invalidate() { for (const item of messages) item.markdown.invalidate(); },
    render(width) {
      const bodyWidth = Math.max(1, width - 2);
      const lines = messages.flatMap(item => {
        const body = item.markdown.render(bodyWidth);
        return [
          ...(item.byline === undefined ? [] : [cardHeader(item.byline, item.ref, bodyWidth, item.name)]),
          ...body,
        ].map(words => ({ guide: item.guide, words }));
      });
      const rows = expanded ? lines : lines.filter(line => stripTerminalSequences(line.words).trim() !== '');
      const hidden = expanded ? 0 : Math.max(0, rows.length - 6);
      const visible = (hidden ? rows.slice(0, 6) : rows).map(line =>
        truncateToWidth(line.guide + line.words, width, '…'));
      if (hidden) visible.push(truncateToWidth(fg(theme, 'dim')(`  +${hidden} ${hidden === 1 ? 'line' : 'lines'}`), width, '…'));
      return [cardHeader(left, fg(theme, 'dim')(tally), width), ...visible];
    },
  });
  return bounded(box);
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
          return {
            identity: { owner: harnessOwner({ channel: 'pi', session: sessionId }) },
            open: (location, control) => Square.at({ cwd: ctx.cwd, path: location }, control),
            discover: (options, control) => discover({ cwd: ctx.cwd }, options, control),
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
    const sessionId = ctx.sessionManager.getSessionId();
    const owner = harnessOwner({ channel: 'pi', session: sessionId });
    const signal = AbortSignal.timeout(5000);
    const attached = await attachDeliverySessionRoutes(owner, process.env, [{ kind: 'pi-native', address: { sessionId } }], signal);
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
