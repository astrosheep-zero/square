import { createHash } from 'node:crypto';
import { DeliveryLedger, deliveryLedgerLocation, type DeliveryCard, type DeliveryTransport } from './delivery-ledger.js';
import { claudeBoundaryStore } from './claude-boundary-state.js';
import { harnessOwner } from './owner.js';
import { attachDeliverySessionRoutes, detachDeliverySession } from './session-lifecycle.js';
import { presentPendingAtBoundary } from './boundary-presentation.js';
import { renderDeliveryReminder } from './delivery-frame.js';
import { beginClaudeMcpCall, endClaudeMcpCallForSession } from './claude-mcp-context.js';
import { retainDeliveryLedger } from './delivery-lifetime.js';
import { z } from 'zod/v4';

const nativeId = z.string().min(1).max(4096).regex(/^[^\x00-\x1f\x7f]+$/u);
const hookInput = z.object({
  hook_event_name: nativeId, session_id: nativeId, cwd: z.string().optional(),
  prompt_id: nativeId.optional().catch(undefined), prompt: z.string().optional(),
  tool_use_id: nativeId.optional().catch(undefined), tool_name: z.string().optional(), agent_id: nativeId.optional(),
});
type NativeHook = z.infer<typeof hookInput>;
const route = 'claude-async-hook';
const ownerFor = (input: NativeHook) => harnessOwner({ channel: 'claude-code', session: input.session_id });

function parseInput(text: string): NativeHook | undefined {
  try {
    const value = hookInput.safeParse(JSON.parse(text));
    return value.success ? value.data : undefined;
  } catch { return; }
}

function observedFrames(prompt: string): Array<{ token: string; payloadHash: string }> {
  const prefix = renderDeliveryReminder([''], { tagged: false });
  const result: Array<{ token: string; payloadHash: string }> = [];
  for (const match of prompt.matchAll(/\[square-delivery:([a-f0-9-]+)\]\n[\s\S]*?\n\[\/square-delivery:\1\]/g)) {
    const start = match.index! - prefix.length;
    if (start < 0 || prompt.slice(start, match.index) !== prefix) continue;
    result.push({ token: match[1]!, payloadHash: createHash('sha256').update(prefix + match[0]).digest('hex') });
  }
  return result;
}

function claudeFrame(card: DeliveryCard, token: string): string {
  return renderDeliveryReminder([`[square-delivery:${token}]\n${card.text}\n[/square-delivery:${token}]`], { tagged: false });
}

export async function runClaudeHook(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  sink: (value: string) => void | Promise<void> = value => { process.stdout.write(value); },
): Promise<string> {
  const input = parseInput(text);
  if (!input) {
    let raw;
    try { raw = JSON.parse(text); } catch { return ''; }
    if (raw?.hook_event_name === 'PreToolUse' && typeof raw.tool_name === 'string' && raw.tool_name.startsWith('mcp__plugin_square_square__'))
      await denyMcpTool(sink);
    return '';
  }
  const boundaries = claudeBoundaryStore(input.session_id, env);
  const mainOwner = ownerFor(input);
  const owner = harnessOwner({ channel: 'claude-code', session: input.session_id, ...(input.agent_id === undefined ? {} : { agent: input.agent_id }) });
  if (input.hook_event_name === 'SessionStart') {
    await boundaries.start(async () => {
      const session = await attachDeliverySessionRoutes(mainOwner, env, [{ kind: route, address: { sessionId: input.session_id } }], AbortSignal.timeout(4500));
      if (!session) return false;
      const ledger = await DeliveryLedger.open({ location: deliveryLedgerLocation(env) });
      try {
        await ledger.updateRoutes({ owner: mainOwner, generation: session.generation, routes: session.routes.filter(item => item.kind !== 'claude-native') });
      } finally { await ledger.close(); }
      return session.generation;
    });
    return '';
  }

  if (input.hook_event_name === 'SessionEnd') {
    const captured = await boundaries.end();
    if (captured) await detachDeliverySession(mainOwner, captured.generation, env);
    return '';
  }

  if (input.hook_event_name === 'UserPromptSubmit') {
    await boundaries.prompt(input.prompt_id);
    if (!input.prompt_id) return '';
    if (input.prompt) {
      const ledger = await DeliveryLedger.open({ location: deliveryLedgerLocation(env) });
      try {
        for (const frame of observedFrames(input.prompt)) {
          const handoff = await ledger.handoff(frame.token);
          if (!handoff || handoff.owner !== owner || handoff.routeKind !== route || handoff.payloadHash !== frame.payloadHash) continue;
          await ledger.observePresentation(handoff);
        }
      } finally { await ledger.close(); }
    }
    await presentPendingAtBoundary(owner, async context => {
      await sink(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } })}\n`);
    }, env, AbortSignal.timeout(4500));
    return '';
  }

  if (input.hook_event_name === 'PreToolUse' && input.tool_name?.startsWith('mcp__plugin_square_square__')) {
    if (!input.tool_use_id || !input.cwd) { await denyMcpTool(sink); return ''; }
    try {
      await beginClaudeMcpCall({ toolUseId: input.tool_use_id, sessionId: input.session_id, cwd: input.cwd, agentId: input.agent_id }, env);
    } catch { await denyMcpTool(sink); return ''; }
  }
  if ((input.hook_event_name === 'PostToolUse' || input.hook_event_name === 'PostToolUseFailure')
    && input.tool_name?.startsWith('mcp__plugin_square_square__') && input.tool_use_id) {
    await endClaudeMcpCallForSession(input.tool_use_id, input.session_id, env, input.agent_id).catch(() => undefined);
  }
  if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(input.hook_event_name)) {
    await presentPendingAtBoundary(owner, async context => {
      await sink(`${JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: context } })}\n`);
    }, env, AbortSignal.timeout(4500));
  }
  return '';
}

async function denyMcpTool(sink: (value: string) => void | Promise<void>): Promise<void> {
  try {
    await sink(`${JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'Square MCP call identity is unavailable; this call did not run.',
    } })}\n`);
  } catch { process.exitCode = 2; }
}

export async function runClaudeWatch(text: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal,
  output: (frame: string) => Promise<void> = frame => new Promise((resolve, reject) => {
    process.stderr.write(frame, error => error ? reject(error) : resolve());
  })): Promise<string> {
  const input = parseInput(text);
  if (!input || input.hook_event_name !== 'Stop' || !input.prompt_id) return '';
  const owner = ownerFor(input);
  const boundaries = claudeBoundaryStore(input.session_id, env);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 86_400_000);
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const captured = await boundaries.capture(input.prompt_id);
    if (!captured) return '';

    await boundaries.watch(combined, async () => {
      if (!await boundaries.current(captured)) return;

      const ledger = await DeliveryLedger.open({ location: deliveryLedgerLocation(env) });
      const lifetime = retainDeliveryLedger(ledger);
      const observer = await ledger.observe(owner);
      try {
        while (!combined.aborted) {
          let version = await observer.read(combined);
          const live = await boundaries.current(captured);
          const session = await ledger.session(owner);
          if (!live || session?.state !== 'attached' || session.generation !== captured.generation || !session.routes.some(item => item.kind === route)) return;
          const cards = await ledger.pending(owner, { generation: captured.generation });
          const held = new Set((await ledger.handoffs(owner, { generation: captured.generation }))
            .filter(attempt => !['failed', 'released'].includes(attempt.outcome)).map(attempt => attempt.seq));
          for (const card of cards) {
            if (held.has(card.seq)) continue;
            const transport: DeliveryTransport = {
              kind: route,
              async send(deliveryCard, address, context) {
                if (address.sessionId !== input.session_id) return 'not-capable';
                const frame = claudeFrame(deliveryCard, context.token);
                const payloadHash = createHash('sha256').update(frame).digest('hex');
                if (!await context.prepare({ token: context.token, messageId: context.token, payloadHash })) return 'not-capable';
                const currentSession = await ledger.session(owner);
                if (currentSession?.state !== 'attached' || currentSession.generation !== captured.generation
                  || !currentSession.routes.some(item => item.kind === route) || !await context.beforeSend()) return 'not-capable';
                const native = await boundaries.current(captured);
                if (!native || context.signal.aborted || Date.now() >= context.deadline) return 'not-capable';
                try { await output(frame); }
                finally { await boundaries.consume(captured); }
                process.exitCode = 2;
                return 'unknown';
              },
            };
            const result = await ledger.dispatchHandoff(owner, card.key, transport, {
              generation: captured.generation, timeoutMs: 5000, signal: combined,
            });
            lifetime.track(result);
            if (result.outcome === 'unknown' || result.outcome === 'accepted' || result.outcome === 'presented') return;
            // Drain our own unsuccessful claim/settlement edge before waiting;
            // a not-capable route must not make filesystem hints a retry loop.
            version = await observer.read(combined);
          }
          await observer.changed(version, 1000, combined);
        }
      } finally {
        observer.close();
        await lifetime.close();
      }
    });
  } catch { if (!combined.aborted) return ''; }
  finally {
    clearTimeout(timer);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
  return '';
}
