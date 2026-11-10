import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod/v4';
import { DeliveryLedger, deliveryLedgerLocation, type DeliveryTransport, type TransportOutcome } from './delivery-ledger.js';
import { retainDeliveryLedger } from './delivery-lifetime.js';
import { harnessOwner } from './owner.js';
import { attachDeliverySessionRoutes, detachDeliverySession } from './session-lifecycle.js';
import { beginClaudeMcpCall, endClaudeMcpCall } from './claude-mcp-context.js';
import { renderDeliveryReminder } from './delivery-frame.js';

const routeKind = 'claude-mod';
const nativeId = z.string().min(1).max(4096).regex(/^[^\x00-\x1f\x7f]+$/u);
const coordinate = z.object({ agentId: nativeId.optional() });
const request = z.discriminatedUnion('op', [
  coordinate.extend({ op: z.literal('state'), mode: z.enum(['busy', 'idle', 'stopped', 'ended']) }),
  z.object({ op: z.literal('guard'), token: z.string().uuid() }),
  z.object({ op: z.literal('settle'), token: z.string().uuid(), kind: z.enum(['append', 'submit', 'failed', 'unknown', 'released']),
    text: z.string().optional(), uuid: nativeId.optional() }),
  coordinate.extend({ op: z.literal('mcp-begin'), toolUseId: nativeId, cwd: z.string().min(1) }),
  z.object({ op: z.literal('mcp-end'), toolUseId: nativeId, token: nativeId }),
  z.object({ op: z.literal('close') }),
]);
type Mode = 'busy' | 'idle' | 'stopped' | 'ended';
interface Receiver { agentId?: string; owner: string; generation: string; mode: Mode; attempted: Set<string> }
interface Offer { receiver: Receiver; text: string; invoked: boolean; guard(): Promise<boolean>; finish(outcome: TransportOutcome): void }

/** One mod-owned helper. Only this process touches Node/SQLite; no producer socket or inbox. */
export async function runClaudeMod(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  output: (line: string) => void | Promise<void> = line => new Promise<void>((resolve, reject) => {
    process.stdout.write(line, error => error ? reject(error) : resolve());
  }),
): Promise<string> {
  const { sessionId } = z.object({ sessionId: nativeId }).parse(JSON.parse(input));
  const stop = new AbortController();
  const abort = () => stop.abort();
  const lifetimeSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const ledger = await DeliveryLedger.open({ location: deliveryLedgerLocation(env), signal: AbortSignal.any([lifetimeSignal, AbortSignal.timeout(5000)]) });
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  const lifetime = retainDeliveryLedger(ledger);
  const receivers = new Map<string, Receiver>();
  const offers = new Map<string, Offer>();
  const secret = `/${randomBytes(32).toString('hex')}`;
  let revision = 0;
  const ownerFor = (agentId?: string) => harnessOwner({ channel: 'claude-code', session: sessionId, ...(agentId === undefined ? {} : { agent: agentId }) });
  async function state(agentId: string | undefined, mode: Mode, signal = lifetimeSignal): Promise<boolean> {
    const key = agentId ?? '';
    let receiver = receivers.get(key);
    if ((!receiver || receiver.mode === 'ended') && (mode === 'busy' || mode === 'idle')) {
      const owner = ownerFor(agentId);
      const attached = await attachDeliverySessionRoutes(owner, env, [{ kind: routeKind, address: { sessionId, ...(agentId === undefined ? {} : { agentId }) } }], signal);
      if (!attached) return false;
      const routes = attached.routes.filter(route => !['claude-async-hook', 'claude-native'].includes(route.kind));
      if (!await ledger.updateRoutes({ owner, generation: attached.generation, routes }, signal)) return false;
      receiver = { agentId, owner, generation: attached.generation, mode, attempted: new Set() };
      receivers.set(key, receiver);
    }
    if (!receiver) return false;
    if (mode === 'busy' && receiver.mode === 'stopped') receiver.attempted.clear();
    receiver.mode = mode;
    revision++;
    if (mode === 'stopped') await ledger.cancel({ owner: receiver.owner, generation: receiver.generation }, signal);
    if (mode === 'ended') await detachDeliverySession(receiver.owner, receiver.generation, env, signal);
    if (mode === 'stopped' || mode === 'ended') for (const offer of offers.values()) {
      if (offer.receiver === receiver) offer.finish(offer.invoked ? 'unknown' : 'not-capable');
    }
    return true;
  }
  async function rpc(data: z.infer<typeof request>): Promise<unknown> {
    switch (data.op) {
      case 'state': return { ok: await state(data.agentId, data.mode) };
      case 'guard': {
        const offer = offers.get(data.token);
        if (!offer || !['busy', 'idle'].includes(offer.receiver.mode) || !await offer.guard()) return { ok: false };
        // Crossing this fence may invoke a native effect. Cancellation thereafter is uncertain.
        offer.invoked = true;
        return { ok: true };
      }
      case 'settle': {
        const offer = offers.get(data.token);
        if (!offer) return { ok: false };
        const exact = data.text === offer.text;
        const outcome: TransportOutcome = data.kind === 'append' ? exact && data.uuid ? 'presented' : 'unknown'
          : data.kind === 'submit' ? exact ? 'presented' : 'accepted'
          : data.kind === 'released' ? 'not-capable' : data.kind;
        offer.finish(outcome);
        return { ok: true };
      }
      case 'mcp-begin': {
        const receiver = receivers.get(data.agentId ?? '');
        if (!receiver || receiver.mode !== 'busy') {
          // Some native child starts are nested under another mod's event. The
          // actual tool event is still authoritative, never its model arguments.
          if (receiver?.mode === 'stopped' || !await state(data.agentId, 'busy')) throw new Error('Square MCP call identity unavailable');
        }
        return beginClaudeMcpCall({ toolUseId: data.toolUseId, sessionId, cwd: data.cwd, agentId: data.agentId }, env, lifetimeSignal);
      }
      case 'mcp-end': await endClaudeMcpCall(data.toolUseId, data.token, env); return { ok: true };
      case 'close':
        // The mod may kill its process stream as soon as this RPC returns.
        // Commit detach before acknowledging, not only in process teardown.
        for (const receiver of receivers.values()) await state(receiver.agentId, 'ended');
        stop.abort();
        return { ok: true };
    }
  }
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== secret) { res.writeHead(404).end(); return; }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 1_048_576) throw new Error('Request too large');
      }
      const result = await rpc(request.parse(JSON.parse(body)));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Square Claude mod request failed' }));
    }
  });
  let observer;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening', { signal: lifetimeSignal });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Claude helper address unavailable');
    if (!await state(undefined, 'idle', AbortSignal.any([lifetimeSignal, AbortSignal.timeout(5000)]))) throw new Error('Claude helper attachment unavailable');
    observer = await ledger.observe(ownerFor());
    await output(`${JSON.stringify({ type: 'ready', url: `http://127.0.0.1:${address.port}${secret}` })}\n`);
    while (!lifetimeSignal.aborted) {
      let version = await observer.read(lifetimeSignal);
      const previousRevision = revision;
      for (const receiver of receivers.values()) {
        if (!['busy', 'idle'].includes(receiver.mode)) continue;
        const current = await ledger.session(receiver.owner, lifetimeSignal);
        if (current?.state !== 'attached' || current.generation !== receiver.generation) {
          if (receiver.agentId === undefined) return '';
          receiver.mode = 'ended';
          continue;
        }
        const held = new Set((await ledger.handoffs(receiver.owner, { generation: receiver.generation }, lifetimeSignal))
          .filter(attempt => !['failed', 'released'].includes(attempt.outcome)).map(attempt => attempt.seq));
        for (const card of await ledger.pending(receiver.owner, { generation: receiver.generation }, lifetimeSignal)) {
          if (lifetimeSignal.aborted || !['busy', 'idle'].includes(receiver.mode)) break;
          if (held.has(card.seq) || receiver.attempted.has(card.key)) continue;
          // An idle child cannot be woken with the main session's prompt.submit.
          if (receiver.agentId !== undefined && receiver.mode !== 'busy') continue;
          receiver.attempted.add(card.key);
          const transport: DeliveryTransport = {
            kind: routeKind,
            async send(deliveryCard, _address, context) {
              const text = renderDeliveryReminder([`[square-delivery:${context.token}]\n${deliveryCard.text}\n[/square-delivery:${context.token}]`], { tagged: false });
              if (!await context.prepare({ token: context.token, messageId: context.token, payloadHash: createHash('sha256').update(text).digest('hex') })
                || !await context.beforeSend() || !['busy', 'idle'].includes(receiver.mode)) return 'not-capable';
              const completion = Promise.withResolvers<TransportOutcome>();
              offers.set(context.token, { receiver, text, invoked: false, guard: context.beforeSend, finish: completion.resolve });
              try {
                await output(`${JSON.stringify({ type: 'delivery', token: context.token, agentId: receiver.agentId, text, display: deliveryCard.text })}\n`);
                return await completion.promise;
              } finally { offers.delete(context.token); }
            },
          };
          lifetime.track(await ledger.dispatchHandoff(receiver.owner, card.key, transport, { generation: receiver.generation, timeoutMs: 5000, signal: lifetimeSignal }));
          // Settlement changes are our own; drain them rather than busy-retrying.
          version = await observer.read(lifetimeSignal);
        }
      }
      if (!lifetimeSignal.aborted && previousRevision === revision) await observer.changed(version, 1000, lifetimeSignal);
    }
  } catch (error) { if (!lifetimeSignal.aborted) throw error; }
  finally {
    stop.abort();
    for (const offer of offers.values()) offer.finish(offer.invoked ? 'unknown' : 'not-capable');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    observer?.close();
    for (const receiver of receivers.values()) await detachDeliverySession(receiver.owner, receiver.generation, env, AbortSignal.timeout(1500)).catch(() => undefined);
    await lifetime.close();
    process.off('SIGTERM', abort);
    process.off('SIGINT', abort);
  }
  return '';
}
