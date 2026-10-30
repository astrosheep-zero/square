import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolveAudience } from '@astrosheep/square/attention';
import { receive, consumeReceived, recordConsumed } from '@astrosheep/square/receive';
import { claimAttempt, settleAttempt, dispatchEffect, preparePresentation, presentPrepared } from '@astrosheep/square/delivery';

// Application routing fixture, not discovery or a core identity format.
const directory = new Map([
  ['e/author', 'east'], ['e/reader', 'east'], ['e/other', 'east'],
  ['w/author', 'west'], ['w/reader', 'west'], ['w/other', 'west'],
]);

// One structural ReceiveWrite adapter. Array insertion order is local order;
// opaque item keys are only compared for equality, never parsed or sorted.
function receiveStore(state) {
  const tx = {
    insertItem({ key, data }) {
      if (state.items.has(key)) throw new Error('duplicate item');
      state.items.set(key, structuredClone(data));
    },
    insertAddress(key, address) {
      if (tx.addressed(address.recipient, key)) throw new Error('duplicate address');
      state.addresses.push({ key, ...address });
    },
    heads(recipient, query, { unconsumed, limit }) {
      return state.addresses.filter(row => row.recipient === recipient
        && (!query.via || row.via === query.via)
        && (!unconsumed || !tx.receipt({ recipient, item: row.key }))).slice(0, limit);
    },
    addressed: (recipient, key) => state.addresses.find(row => row.recipient === recipient && row.key === key),
    load: keys => new Map(keys.filter(key => state.items.has(key)).map(key => [key, state.items.get(key)])),
    count: (recipient, query, unconsumed) => tx.heads(recipient, query, { unconsumed, limit: Infinity }).length,
    receipt: ({ recipient, item }) => state.receipts.get(recipient)?.get(item),
    insertReceipt({ recipient, item }, at) {
      if (!state.receipts.has(recipient)) state.receipts.set(recipient, new Map());
      const receipts = state.receipts.get(recipient);
      if (receipts.has(item)) return false;
      receipts.set(item, { at });
      return true;
    },
  };
  return tx;
}

// A tiny illustrative consumer, NOT a storage backend or durable runtime.
class Domain {
  #state = { items: new Map(), addresses: [], receipts: new Map(), series: [] };

  constructor(name, nextKey) {
    this.name = name;
    this.nextKey = nextKey;
  }

  transaction(change) {
    const draft = structuredClone(this.#state);
    const result = change(draft, receiveStore(draft));
    if (result instanceof Promise) throw new Error('no awaits inside memory transactions');
    // A throw above discards the draft. No capability or mutable row escapes.
    const captured = structuredClone(result);
    this.#state = draft;
    return captured;
  }

  originate(actor, mentions, text) {
    // Attention names its route; receive stores that application route as via.
    const audience = resolveAudience({ actor, recipients: [...directory.keys()], mentions })
      .map(({ recipient, route }) => ({ recipient, via: route }));
    const key = this.nextKey();
    const data = { text, origin: { domain: this.name, key } };
    this.transaction((_state, tx) => receive(tx, {
      item: { key, data }, audience: audience.filter(a => directory.get(a.recipient) === this.name),
    }));
    const outgoing = new Map();
    for (const address of audience) {
      const destination = directory.get(address.recipient);
      if (destination === this.name) continue;
      if (!outgoing.has(destination)) outgoing.set(destination, []);
      outgoing.get(destination).push(address);
    }
    return { key, data, outgoing };
  }

  admit(data, audience) {
    const key = this.nextKey(); // Destination owns this identity, not origin.key.
    this.transaction((_state, tx) => receive(tx, {
      item: { key, data }, audience,
    }));
    return key;
  }

  // Captured item/target/purpose are application coordinates, not an encoded key.
  // For dispatch target is a destination; for presentation it is one recipient.
  effectPort(purpose, item, target, fullReceipts = []) {
    const rows = state => {
      let series = state.series.find(s => s.purpose === purpose && s.item === item && s.target === target);
      if (!series) {
        series = { purpose, item, target, attempts: new Map() };
        state.series.push(series);
      }
      return {
        list: () => structuredClone([...series.attempts.values()].sort((a, b) => b.ordinal - a.ordinal)),
        byToken: token => structuredClone(series.attempts.get(token)),
        insert: row => { series.attempts.set(row.token, structuredClone(row)); },
        replace: row => { series.attempts.set(row.token, structuredClone(row)); },
      };
    };
    const current = (state, tx) => state.items.has(item) && (purpose === 'dispatch'
      || Boolean(tx.addressed(target, item)) && !tx.receipt({ recipient: target, item }));
    return {
      claim: async () => this.transaction((state, tx) => {
        if (!current(state, tx)) return undefined;
        const claim = claimAttempt(rows(state), {
          purpose, token: randomUUID(), at: Date.now(), leaseMs: 30_000, data: {},
        });
        return claim.status === 'acquired' ? { token: claim.token, ordinal: claim.ordinal } : undefined;
      }),
      current: async () => this.transaction(current),
      settle: async (claim, completion) => this.transaction((state, tx) => {
        const recorded = settleAttempt(rows(state), {
          token: claim.token, outcome: completion.outcome, at: Date.now(), data: completion,
        });
        // ONE commit: attempt completion plus captured full-consumption receipts.
        // No post-effect cancellation/currentness veto and no re-selection.
        if (recorded && completion.outcome === 'presented') recordConsumed(tx, fullReceipts, Date.now());
        return recorded;
      }),
    };
  }

  consume(recipient, selection) {
    return this.transaction((_state, tx) => consumeReceived(tx, recipient, selection, Date.now()));
  }

  pending(recipient) {
    return this.transaction((_state, tx) => tx.heads(recipient, {}, { unconsumed: true, limit: Infinity }).map(h => h.key));
  }

  receipts() {
    return this.transaction(state => [...state.receipts].flatMap(([recipient, items]) =>
      [...items].map(([item, { at }]) => ({ recipient, item, at }))));
  }

  attempts() {
    return this.transaction(state => state.series.map(({ purpose, item, target, attempts }) =>
      ({ purpose, item, target, outcomes: [...attempts.values()].map(a => a.outcome) })));
  }

  async present(recipient, item, sink) {
    const payload = this.transaction((_state, tx) => {
      if (!tx.addressed(recipient, item)) throw new Error('not addressed');
      return tx.load([item]).get(item);
    });
    const prepared = await preparePresentation({
      payload, coverage: 'full',
      port: this.effectPort('presentation', item, recipient, [{ recipient, item }]),
    });
    return prepared ? presentPrepared(prepared, sink) : undefined;
  }
}

export async function demonstrateSymmetricDomains() {
  // Same implementation, truly separate stores and unrelated key spaces.
  let westKey = -700;
  const east = new Domain('east', () => `opaque?${randomUUID()}`);
  const west = new Domain('west', () => westKey--);
  const domains = new Map([['east', east], ['west', west]]);
  const handoffs = [];
  let online = true;

  async function sendAll(source, message, mode = 'accepted') {
    const reports = [];
    for (const [destination, audience] of message.outgoing) {
      const report = await dispatchEffect(source.effectPort('dispatch', message.key, destination), async context => {
        if (!await context.beforeSend()) return { outcome: 'not-capable' };
        // A final policy gate may finish after the runner's timeout. Never mutate
        // the destination after our deadline or cancellation, even if it said yes.
        if (context.signal?.aborted || Date.now() >= context.deadline) return { outcome: 'not-capable' };
        if (!online) return { outcome: 'failed' }; // Known no-send in this in-process fixture.
        const key = domains.get(destination).admit(message.data, audience);
        handoffs.push({ from: source.name, to: destination, key, audience: structuredClone(audience) });
        // Unknown deliberately happens AFTER admission. This is not a dedup protocol.
        return { outcome: mode, data: { destinationKey: key } };
      }, { timeoutMs: 1000 });
      reports.push(report);
    }
    return reports;
  }

  const eastMessage = east.originate('e/author', ['e/reader', 'w/reader', 'w/other'], 'East says hello');
  const westMessage = west.originate('w/author', ['w/reader', 'e/reader', 'e/other'], 'West says hello');
  // Establish origin receipts before destination presentation: neither can overwrite the other.
  east.consume('e/reader', { kind: 'exact', key: eastMessage.key, remainingQuery: {} });
  west.consume('w/reader', { kind: 'exact', key: westMessage.key, remainingQuery: {} });

  const exchanges = [];
  for (const [source, destination, message, mode, first, second] of [
    [east, west, eastMessage, 'accepted', 'w/reader', 'w/other'],
    [west, east, westMessage, 'unknown', 'e/reader', 'e/other'],
  ]) {
    const [report] = await sendAll(source, message, mode);
    const destinationKey = report.settlement.completion.data.destinationKey;
    const admission = [destination.pending(first), destination.pending(second)];
    const originReceiptsBefore = source.receipts();
    const output = [];
    // The sink proves only that this example callback captured the full payload.
    const presentation = await destination.present(first, destinationKey, payload => { output.push(payload); });
    const afterPresentation = [destination.pending(first), destination.pending(second)];
    const presentationReceipts = destination.receipts().filter(ref => ref.item === destinationKey);
    const originReceiptsAfter = source.receipts();
    const exact = { kind: 'exact', key: destinationKey, remainingQuery: {} };
    const unmatched = destination.consume(second, { kind: 'page', query: { via: 'bell' }, limit: 1 });
    const consumed = destination.consume(second, { kind: 'page', query: { via: 'mention' }, limit: 1 });
    const repeated = destination.consume(second, exact);
    const handoffsBeforeReplay = handoffs.length;
    const [replay] = await sendAll(source, message, mode);
    exchanges.push({
      from: source.name, to: destination.name, sourceKey: message.key, destinationKey,
      dispatch: report, admission, presentation, output, afterPresentation, presentationReceipts,
      originReceiptsBefore, originReceiptsAfter, unmatched, consumed, repeated, replay,
      handoffsBeforeReplay, handoffsAfterReplay: handoffs.length,
    });
  }

  online = false;
  const handoffsBeforeOffline = handoffs.length;
  const offline = [];
  for (const [domain, author, recipient] of [[east, 'e/author', 'e/reader'], [west, 'w/author', 'w/reader']]) {
    const messages = [];
    for (const text of ['oldest', 'middle', 'newest']) {
      const message = domain.originate(author, [recipient], text);
      messages.push(message);
      await sendAll(domain, message); // Local work has no remote destination at all.
    }
    const exact = { kind: 'exact', key: messages[1].key, remainingQuery: {} };
    const middle = domain.consume(recipient, exact);
    const repeated = domain.consume(recipient, exact);
    const page = () => domain.consume(recipient, { kind: 'page', query: { via: 'mention' }, limit: 1 });
    offline.push({ domain: domain.name, keys: messages.map(m => m.key), middle, repeated, pages: [page(), page()] });
  }
  return {
    exchanges, handoffs, offline, handoffsBeforeOffline, handoffsAfterOffline: handoffs.length,
    attempts: { east: east.attempts(), west: west.attempts() },
    receipts: { east: east.receipts(), west: west.receipts() },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  console.log(JSON.stringify(await demonstrateSymmetricDomains(), null, 2));
}
