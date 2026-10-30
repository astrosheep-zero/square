import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.join(import.meta.dirname, '..');

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
}

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  return npmCli === undefined ? run('npm', args, options) : run(process.execPath, [npmCli, ...args], options);
}

test('packed ESM root typechecks, imports, and rejects deep imports', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'square-package-consumer-'));
  const packed = runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', fixture], {
    env: { ...process.env, npm_config_cache: path.join(fixture, 'npm-cache') },
  });
  assert.equal(packed.status, 0, packed.stderr);
  const [{ filename }] = JSON.parse(packed.stdout);
  const unpack = path.join(fixture, 'unpack');
  fs.mkdirSync(unpack);
  const extracted = run('tar', ['-xzf', path.join(fixture, filename), '-C', unpack]);
  assert.equal(extracted.status, 0, extracted.stderr);
  const packageRoot = path.join(fixture, 'node_modules', '@astrosheep', 'square');
  fs.mkdirSync(path.dirname(packageRoot), { recursive: true });
  fs.renameSync(path.join(unpack, 'package'), packageRoot);
  // This fixture unpacks without npm install. Supply declared dependencies and
  // required peers as the consumer/host would, without private copies in Square.
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies?.['@earendil-works/pi-tui'], undefined, 'Pi owns the TUI runtime');
  assert.equal(manifest.peerDependencies?.['@earendil-works/pi-tui'], '*', 'use the host-provided TUI without a version pin');
  const requiredPeers = Object.keys(manifest.peerDependencies ?? {})
    .filter((name) => !manifest.peerDependenciesMeta?.[name]?.optional);
  for (const name of [...Object.keys(manifest.dependencies ?? {}), ...requiredPeers]) {
    const target = path.join(fixture, 'node_modules', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.join(root, 'node_modules', name), target, 'dir');
  }
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(fixture, 'attention-consumer.ts'), `
    import { resolveAudience, type AudienceInput, type AudienceRecipient, type AudienceRoute } from '@astrosheep/square/attention';
    const input: AudienceInput = { actor: 'a:one', recipients: ['b:two'] };
    const audience: readonly AudienceRecipient[] = resolveAudience(input);
    const route: AudienceRoute | undefined = audience[0]?.route;
    void route;
  `);
  fs.writeFileSync(path.join(fixture, 'delivery-consumer.ts'), `
    import assert from 'node:assert/strict';
    import { claimAttempt, prepareAttempt, settleAttempt, automaticDispatchEligible,
      presentationBlocksDispatch, dispatchEffect, preparePresentation, presentPrepared, presentPreparedBatch,
      type EffectPort, type DispatchCompletion, type PresentationCompletion, type PreparedPresentation,
      type Attempt, type AttemptRows, type DeliveryPurpose, type AttemptOutcome } from '@astrosheep/square/delivery';
    const stores = new Map<string, Map<string, Attempt<{ proof?: string }>>>();
    // These opaque coordinates belong to the consumer, not Square's identity codec.
    const seriesKey = 'tenant:east/item:7/authority:random';
    const records = new Map<string, Attempt<{ proof?: string }>>();
    stores.set(seriesKey, records);
    const rows: AttemptRows<{ proof?: string }> = {
      list: () => [...records.values()].sort((a, b) => b.ordinal - a.ordinal),
      byToken: token => records.get(token),
      insert: row => { records.set(row.token, row); },
      replace: row => { records.set(row.token, row); },
    };
    const purpose: DeliveryPurpose = 'dispatch';
    const outcome: AttemptOutcome = 'accepted';
    claimAttempt(rows, { purpose, token: 'my-token', at: 1, leaseMs: 100, data: {} });
    prepareAttempt(rows, { token: 'my-token', data: { proof: 'prepared' } });
    settleAttempt(rows, { token: 'my-token', outcome, at: 2, data: { proof: 'ack' } });
    const eligible: boolean = automaticDispatchEligible(rows.list(), 3);
    const blocked: boolean = presentationBlocksDispatch(rows.list(), 3);
    void eligible; void blocked;
    // Installed effects need neither Square storage nor its identities. Binding owns custody.
    const captured: unknown[] = [];
    function effectPort<C>(): EffectPort<C> {
      return {
        claim: async () => ({ token: 'application-token', ordinal: 4 }),
        current: async () => true,
        settle: async (claim, completion) => { captured.push({ claim, completion }); return true; },
      };
    }
    const dispatched = await dispatchEffect(effectPort<DispatchCompletion>(), async context => {
      assert.equal(await context.beforeSend(), true);
      assert.equal(context.claim.ordinal, 4);
      return { outcome: 'accepted', data: 'consumer-proof' };
    }, { timeoutMs: 1000 });
    assert.equal(dispatched.observation.kind, 'returned');
    assert.equal(dispatched.settlement?.persistence.status, 'recorded');
    async function prepared(payload: string, coverage: 'full' | 'clipped' = 'full'): Promise<PreparedPresentation<string>> {
      return (await preparePresentation({ payload, coverage, port: effectPort<PresentationCompletion>() }))!;
    }
    const single = await prepared('single');
    const shown = await presentPrepared(single, value => value.toUpperCase());
    assert.deepEqual(shown.observation, { kind: 'returned', value: 'SINGLE' });
    const batch = [await prepared('full'), await prepared('preview', 'clipped')];
    const shownBatch = await presentPreparedBatch(batch, included => ({
      payload: included.map(item => item.payload).join('+'), included,
    }), value => value);
    assert.deepEqual(shownBatch.observation, { kind: 'returned', value: 'full+preview' });
    assert.deepEqual(shownBatch.settlements.map(item => item.result.completion.outcome), ['presented', 'clipped']);
    assert.equal((await single.release()).completion.outcome, 'presented');
    assert.equal(captured.length, 4);
  `);
  fs.writeFileSync(path.join(fixture, 'receive-consumer.ts'), `
    import assert from 'node:assert/strict';
    import { receive, selectReceivedHeads, consumeReceived, recordConsumed, ReceiveError,
      type Item, type Address, type ReceivedHead, type ReceiptRef, type Selection,
      type ReceiveRead, type ReceiveWrite } from '@astrosheep/square/receive';
    type Query = { via?: string };
    let items = new Map<string, string>(), addresses: (ReceivedHead<string, string> & { recipient: string })[] = [];
    let receipts = new Map<string, Map<string, { at: number }>>();
    function transaction<R>(change: (tx: ReceiveWrite<string, string, string, Query>) => R): R {
      const data = new Map(items), audience = [...addresses], seen = structuredClone(receipts);
      const tx: ReceiveWrite<string, string, string, Query> = {
        insertItem(item) { if (data.has(item.key)) throw Error('duplicate'); data.set(item.key, item.data); },
        insertAddress(key, address) {
          if (audience.some(row => row.key === key && row.recipient === address.recipient)) throw Error('duplicate');
          audience.push({ key, ...address });
        },
        heads(recipient, query, options) {
          return audience.filter(row => row.recipient === recipient && (!query.via || row.via === query.via)
            && (!options.unconsumed || !seen.get(recipient)?.has(row.key))).slice(0, options.limit);
        },
        addressed: (recipient, key) => audience.find(row => row.recipient === recipient && row.key === key),
        load: keys => new Map(keys.filter(key => data.has(key)).map(key => [key, data.get(key)!])),
        count: (recipient, query, unconsumed) => tx.heads(recipient, query, { unconsumed, limit: Infinity }).length,
        receipt: ref => seen.get(ref.recipient)?.get(ref.item),
        insertReceipt(ref, at) {
          if (seen.get(ref.recipient)?.has(ref.item)) return false;
          if (!seen.has(ref.recipient)) seen.set(ref.recipient, new Map());
          seen.get(ref.recipient)!.set(ref.item, { at }); return true;
        },
      };
      const result = change(tx);
      items = data; addresses = audience; receipts = seen;
      return result;
    }
    const item: Item<string, string> = { key: 'opaque/⚑?z', data: 'payload' };
    const address: Address<string> = { recipient: 'west:bob', via: 'paid-link' };
    const selection: Selection<string, Query> = { kind: 'exact', key: item.key, remainingQuery: {} };
    const ref: ReceiptRef<string> = { recipient: address.recipient, item: item.key };
    transaction(tx => receive(tx, { item, audience: [address] }));
    transaction(tx => {
      const read: ReceiveRead<string, string, string, Query> = tx;
      const heads: readonly ReceivedHead<string, string>[] = selectReceivedHeads(read, address.recipient, selection);
      assert.equal(heads[0].key, item.key);
      assert.equal(consumeReceived(tx, address.recipient, selection, 7).newlyConsumed, 1);
      assert.equal(consumeReceived(tx, address.recipient, selection, 9).newlyConsumed, 0);
      assert.equal(recordConsumed({ insertReceipt: tx.insertReceipt }, [ref], 10), 0);
      assert.deepEqual(read.receipt(ref), { at: 7 });
    });
    assert.throws(() => transaction(tx => consumeReceived(tx, 'other', selection, 11)), ReceiveError);
  `);
  fs.writeFileSync(path.join(fixture, 'consumer.ts'), `
    import { Square, SquareError, type Activity, type PerceivedActivity, type ActivityId, type Participant, type JoinResult, type HistoryResult } from '@astrosheep/square';
    const body = "test" + ":" + ('consumer');
    const square: Square = Square.inMemory({ markdown: 'context', wakeTransport: false });
    const opened: Promise<Square> = Square.at({ path: './test.square' });
    const built: Promise<Square> = Square.build({ path: './new.square', markdown: '', wakeTransport: false });
    const injected: Promise<Square> = Square.at({ path: './test.square', wakeTransport: { attempt: async () => ({ outcome: 'accepted' }) } });
    void opened; void built; void injected;
    const joined: Promise<JoinResult> = square.join('Alice', { owner: body });
    const webhook: Promise<JoinResult> = square.join('Bob', { owner: 'example:bob', wakeAddress: {
      kind: 'http', address: { url: 'https://example.com/square/wake', tokenEnv: 'BOB_WAKE_TOKEN' },
    } });
    void webhook;
    // @ts-expect-error caller identity is required on join, not the resource
    square.join('NoBody');
    // @ts-expect-error the resource never captures caller identity
    Square.inMemory({ markdown: 'context', body });
    // @ts-expect-error participant selection requires a name and caller identity
    square.participant('Alice');
    const participant: Promise<Participant> = joined.then(result => result.participant);
    const history: Promise<HistoryResult> = square.history({ limit: null });
    const id: ActivityId = 'act/1';
    const stream: AsyncIterable<Activity> = square.stream({ start: { kind: 'after', after: id } });
    const directed: AsyncIterable<PerceivedActivity> = square.stream({ recipient: 'Alice' });
    // @ts-expect-error stream cursors are activity ids, not raw indexes
    square.stream({ start: { kind: 'after', after: 1 } });
    // @ts-expect-error old join count is not a public fact
    joined.then(result => result.participantCount);
    // @ts-expect-error old stream fields are not public facts
    ({} as Activity).seq;
    const codes: SquareError['code'][] = ['invalid_args', 'invalid_name', 'unknown_participant', 'not_joined', 'already_joined', 'already_done', 'capped', 'throttled', 'bell_quota', 'behind', 'io', 'unavailable'];
    void participant; void history; void stream; void directed; void codes;
  `);
  const typecheck = run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--outDir', path.join(fixture, 'compiled'), '--strict', '--target', 'ESNext', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--types', 'node', '--typeRoots', path.join(root, 'node_modules', '@types'),
    path.join(fixture, 'consumer.ts'),
    path.join(fixture, 'attention-consumer.ts'),
    path.join(fixture, 'delivery-consumer.ts'),
    path.join(fixture, 'receive-consumer.ts'),
  ]);
  assert.equal(typecheck.status, 0, typecheck.stderr || typecheck.stdout || typecheck.error?.message);

  const delivered = run(process.execPath, [path.join(fixture, 'compiled', 'delivery-consumer.js')], { cwd: fixture });
  assert.equal(delivered.status, 0, delivered.stderr);
  const received = run(process.execPath, [path.join(fixture, 'compiled', 'receive-consumer.js')], { cwd: fixture });
  assert.equal(received.status, 0, received.stderr);

  const attention = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { resolveAudience } from '@astrosheep/square/attention';
    import assert from 'node:assert/strict';
    const first = resolveAudience({ actor: 'east:alice', recipients: ['east:bob', 'west:bob'], mentions: ['west:bob'] });
    const second = resolveAudience({ actor: 'west:bob', recipients: ['west:alice', 'east:alice'], reach: 'bell' });
    assert.deepEqual(first, [{ recipient: 'west:bob', route: 'mention' }]);
    assert.deepEqual(second, [{ recipient: 'west:alice', route: 'bell' }, { recipient: 'east:alice', route: 'bell' }]);
  `], { cwd: fixture, encoding: 'utf8' });
  assert.equal(attention.status, 0, attention.stderr);

  const delivery = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { claimAttempt, prepareAttempt, settleAttempt, automaticDispatchEligible } from '@astrosheep/square/delivery';
    import assert from 'node:assert/strict';
    const scopes = new Map();
    function bind(opaque) {
      const values = new Map(); scopes.set(opaque, values);
      return { list: () => [...values.values()].sort((a, b) => b.ordinal - a.ordinal),
        byToken: token => values.get(token), insert: row => values.set(row.token, row), replace: row => values.set(row.token, row) };
    }
    const east = bind('east:item#7:authority/a'), west = bind('west:item#7:authority/b');
    const input = { purpose: 'dispatch', token: 'same-local-token', at: 1, leaseMs: 10, data: {} };
    assert.equal(claimAttempt(east, input).status, 'acquired');
    assert.equal(claimAttempt(west, input).status, 'acquired');
    assert.equal(prepareAttempt(east, { token: input.token, data: { native: 'proof' } }), true);
    assert.equal(settleAttempt(east, { token: input.token, outcome: 'accepted', at: 2, data: { ack: true } }), true);
    const evidence = east.byToken(input.token);
    assert.equal(settleAttempt(east, { token: input.token, outcome: 'accepted', at: 3, data: {} }), true);
    assert.equal(east.byToken(input.token), evidence);
    assert.equal(automaticDispatchEligible(east.list(), 20), false);
    assert.equal(claimAttempt(west, { ...input, at: 11 }).evidence.outcome, 'unknown');
    assert.equal(automaticDispatchEligible(west.list(), 20), false);
  `], { cwd: fixture, encoding: 'utf8' });
  assert.equal(delivery.status, 0, delivery.stderr);

  const runtime = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import * as api from '@astrosheep/square';
    const { Square } = api;
    if (Object.hasOwn(api, 'withDefault' + 'WakeTransport')) process.exit(7);
    if (['at', 'build', 'inMemory'].some(key => typeof Square[key] !== 'function')) process.exit(8);
    const body = "test" + ":" + ('consumer');
    const square = Square.inMemory({ markdown: 'context' });
    const { participant: alice } = await square.join('Alice', { owner: body });
    if (alice.name !== 'Alice') process.exit(2);
    await square.close();
    // Pi renderer imports must resolve from the consumer's supplied TUI peer.
    const { default: extension } = await import('./node_modules/@astrosheep/square/plugins/pi/square-pi.js');
    const flags = [], handlers = new Map(), tools = [];
    extension({
      on(event, handler) { handlers.set(event, handler); },
      registerFlag(name) { flags.push(name); },
      registerTool(tool) { tools.push(tool); },
      getFlag() { return undefined; },
      sendMessage() { throw new Error('factory must not send'); },
    });
    if (flags.join() !== 'agent-delivery-socket') process.exit(3);
    if (!tools.some(tool => tool.name === 'square_express' && tool.parameters.properties.noMention)) process.exit(6);
    if (!handlers.has('session_start') || !handlers.has('session_shutdown')) process.exit(4);
    // The public OpenCode subpath stays stable after moving the implementation.
    const { default: plugin } = await import('@astrosheep/square/server');
    if (plugin.id !== 'square' || typeof plugin.setup !== 'function') process.exit(5);
  `], { cwd: fixture, encoding: 'utf8' });
  assert.equal(runtime.status, 0, runtime.stderr);

  const deep = spawnSync(process.execPath, ['--input-type=module', '-e', "import '@astrosheep/square/landing.js'"], {
    cwd: fixture,
    encoding: 'utf8',
  });
  assert.notEqual(deep.status, 0);
  assert.match(deep.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
});
