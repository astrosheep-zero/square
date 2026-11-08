import { Box, Markdown, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { z } from 'zod/v4';

import { Square, discover, squareClock } from '../../dist/square-api.js';
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
    bold: style(theme, 'bold'), italic: (text) => fg(theme, 'muted')(style(theme, 'italic')(text)),
    underline: style(theme, 'underline'), strikethrough: style(theme, 'strikethrough'),
  };
}

/** Keep the short references; the long origin is the part that may ellipsize. */
function cardHeader(left, right, width) {
  if (!right) return truncateToWidth(left, width);
  const rightWidth = visibleWidth(right);
  if (rightWidth + 4 >= width) return truncateToWidth(left, width);
  const leftWidth = width - rightWidth - 2;
  return `${truncateToWidth(left, leftWidth)}${' '.repeat(width - Math.min(visibleWidth(left), leftWidth) - rightWidth)}${right}`;
}

const escapeMarkdown = text => text.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '\\$&');
const shortOrigin = origin => origin.split(/[\\/]/).filter(Boolean).at(-1) || origin;

/** The same quiet quote guide in collapsed and expanded states. */
function guidedMarkdown(text, theme, { preview = false, lead } = {}) {
  const source = lead ? `**${escapeMarkdown(lead)}** ${text}` : text;
  const markdown = new Markdown(source, 0, 0, markdownTheme(theme), { color: fg(theme, 'customMessageText') });
  const guide = fg(theme, 'mdQuoteBorder')('│ ');
  return {
    invalidate() { markdown.invalidate(); },
    render(width) {
      const contentWidth = Math.max(1, width - 2);
      let lines = markdown.render(contentWidth);
      if (preview) {
        const visible = lines.filter(line => line.trim() !== '');
        const clipped = visible.length > 2 || text.length >= 1_000;
        lines = visible.slice(0, 2);
        if (clipped && lines.length) lines[lines.length - 1] = truncateToWidth(`${lines.at(-1).trimEnd()}${fg(theme, 'dim')('…')}`, contentWidth);
      }
      return lines.map(line => guide + line);
    },
  };
}

/** People get the producer's display facts, never the model-facing reminder envelope. */
export function renderSquareCard(message, { expanded, outputPad = 1 }, theme) {
  if (typeof message.content !== 'string') return undefined;
  const items = message.details?.items;
  if (!Array.isArray(items) || items.length === 0
    || items.some(item => !isCardPresentation(item) && typeof item?.text !== 'string')) {
    return new Markdown(message.content, outputPad, 0, markdownTheme(theme));
  }
  const presentations = items.filter(isCardPresentation);
  const authors = [...new Set(presentations.flatMap(item => item.author === undefined ? [] : [item.author]))];
  const origins = [...new Set(presentations.map(item => item.origin))];
  const originName = origins.map(shortOrigin).join(', ') || 'Notification';
  const badge = presentations.at(-1)?.badge;
  const byline = [authors.join(', '), badge].filter(Boolean).join(' · ');
  const refs = presentations.flatMap(item => item.ref === undefined ? []
    : [origins.length > 1 ? `${shortOrigin(item.origin)} ${item.ref}` : item.ref]).join(', ');
  const trailing = [refs, presentations.length > 1 ? String(presentations.length) : undefined].filter(Boolean).join(' · ');
  const box = new Box(outputPad, 1, text => theme.bg?.('customMessageBg', text) ?? text);
  const left = `${fg(theme, 'accent')('■')} ${style(theme, 'bold')(originName)}${byline ? fg(theme, 'muted')(` · ${byline}`) : ''}`;
  const right = trailing ? fg(theme, 'dim')(trailing) : '';
  box.addChild({ invalidate() {}, render(width) { return [cardHeader(left, right, width)]; } });
  const bodyOf = item => isCardPresentation(item) ? item.body : item.text;
  if (!expanded) {
    const body = bodyOf(items.at(-1));
    if (body.trim()) box.addChild(guidedMarkdown(body.slice(0, 1_000).replace(/[\uD800-\uDBFF]$/, ''), theme, { preview: true }));
    return box;
  }
  for (const [index, item] of items.entries()) {
    if (index > 0) box.addChild({
      invalidate() {},
      render(width) { return [`${fg(theme, 'mdQuoteBorder')('│ ')}${fg(theme, 'borderMuted')('─'.repeat(Math.max(1, width - 2)))}`]; },
    });
    box.addChild(guidedMarkdown(bodyOf(item), theme, {
      lead: authors.length > 1 && isCardPresentation(item) ? item.author : undefined,
    }));
  }
  return box;
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
          const now = squareClock(process.env);
          return {
            identity: { owner: harnessOwner({ channel: 'pi', session: sessionId }) },
            now,
            open: (location, control) => Square.at({ cwd: ctx.cwd, path: location, clock: now }, control),
            discover: async (options, control) => ({ result: await discover({ cwd: ctx.cwd }, options, control), now: now() }),
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
