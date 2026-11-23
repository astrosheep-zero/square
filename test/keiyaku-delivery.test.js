import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { akumaDeliveryOwner, DeliveryLedger, Square, postAndDispatch } from '../dist/index.js';
import { KeiyakuWakeTransport } from '../dist/hosts/keiyaku-delivery.js';
import { resolveParticipantIdentity } from '../dist/hosts/participant-identity.js';

const bind = actor => resolveParticipantIdentity(actor, () => assert.fail('actor cannot fall through to a native route'));
const byPromptAndActor = (a, b) => a.prompt.localeCompare(b.prompt) || a.akuId.localeCompare(b.akuId);

// Transport policy test; the installation above the SDK edge is deliberately fake.
// Physical Body/client exit and actual Tell admission belong to the paired witness.
test('only landed Square mentions can admit a Tell and leave unread activity across seat lifetimes', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'square-keiyaku-delivery-')));
  const ledgerLocation = path.join(root, 'ledger.sqlite');
  const log = path.join(root, 'tells.ndjson');
  const module = path.join(root, 'sdk.mjs');
  const ledger = await DeliveryLedger.open({ location: ledgerLocation });
  const opened = [];
  t.after(async () => {
    delete process.env.SQUARE_KEIYAKU_SDK;
    await Promise.all(opened.map(square => square.close()));
    await ledger.close();
    await rm(root, { recursive: true, force: true });
  });
  const build = async name => {
    const square = await Square.build({ path: path.join(root, `${name}.square`), markdown: '', ledgerLocation });
    opened.push(square);
    return square;
  };
  const readTells = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const actor = { world: root, akuId: 'aku/alpha/1234abcd' };
  const identity = bind(actor);
  const first = await build('first'), second = await build('second');
  const recipient = (await first.join('alpha', identity)).participant;
  await second.join('alpha', identity);
  const otherActor = { world: root, akuId: 'aku/beta/abcd1234' };
  const other = (await first.join('beta', bind(otherActor))).participant;
  const observer = (await first.join('gamma', bind({ world: root, akuId: 'aku/gamma/fe01de34' }))).participant;
  const sender = (await first.join('sender', { owner: 'test:sender' })).participant;
  const generation = (await ledger.session(identity.owner)).generation;
  assert.deepEqual((await ledger.session(identity.owner)).routes, [identity.wakeAddress]);

  await writeFile(log, '');
  process.env.SQUARE_KEIYAKU_SDK = path.join(root, 'not-installed.mjs');
  const mention = await sender.express('nonce-body-must-not-be-in-Tell', { mentions: ['alpha'], force: true });
  assert.equal((await ledger.pending(identity.owner, { generation })).length, 1, 'optional SDK miss releases without losing the card or post');
  await writeFile(module, `import { appendFile } from 'node:fs/promises';
    export const World = { prove: async world => world, established: async () => true };
    export class AkumaNotBornError extends Error {}
    export const Akuma = { select(world, akuId) { return { id: akuId, async tell(prompt, { signal, ...options }) {
      signal.throwIfAborted();
      await appendFile(${JSON.stringify(log)}, JSON.stringify({ world, akuId, prompt, options }) + '\\n');
      if (prompt.includes('second.square')) throw new Error('effect might have happened');
      return { kind: 'admitted', akumaId: akuId, tellId: 'test-tell' };
    } }; } };`);
  process.env.SQUARE_KEIYAKU_SDK = module;
  // Flush the pending mention after restoring the optional SDK. Bare activity is not a Tell source.
  const question = await recipient.express('question', { force: true });
  const tell = (target, as, id) => ({ ...target, options: { wait: false },
    prompt: ['A Square mention reached you. Take it in if unread:',
      `perceive ${JSON.stringify({ location: first.location, as, ids: [id] })}`,
      'To reread the full activity:',
      `history ${JSON.stringify({ location: first.location, ids: [id], maxChars: Number.MAX_SAFE_INTEGER })}`,
    ].join('\n') });
  const mentionTell = tell(actor, 'alpha', mention.activity.id);
  assert.deepEqual(await readTells(), [mentionTell], 'directed mention only wakes alpha');
  const many = await sender.express('for both named participants', { mentions: ['alpha', 'beta', 'beta'], force: true });
  const expected = [mentionTell, tell(actor, 'alpha', many.activity.id), tell(otherActor, 'beta', many.activity.id)];
  assert.deepEqual((await readTells()).sort(byPromptAndActor), expected.sort(byPromptAndActor),
    'each named seat wakes once; the unrelated stable owner does not wake');
  for (const seat of [recipient, other]) {
    assert.equal((await seat.perceive({ ids: [many.activity.id] })).activities[0].body, 'for both named participants');
  }
  assert.deepEqual((await observer.pending()).activities, []);
  await recipient.express('a literal self-address @alpha', { force: true });
  await first.send({ from: 'akuma-outcome', to: 'alpha', body: '@alpha synthetic report' });
  await postAndDispatch(ledger, { owner: identity.owner, key: ['keiyaku', actor.akuId, 'turn', '42'],
    text: 'an outcome returning to its author' });
  await recipient.attention({ target: 'sender', state: 'listen' });
  await sender.express('not directed', { force: true });
  await sender.express('reply, not mention', { reply: question.activity.id, force: true });
  await postAndDispatch(ledger, { owner: identity.owner, key: ['square', first.location, 'recipient', 'alpha', 'join', recipient.generation, 'act', '999'],
    text: 'not a real Square activity', details: { reach: 'mention' } });
  assert.deepEqual((await readTells()).sort(byPromptAndActor), expected,
    'self-address, replies, listens and outcome cards never reenter Tell');
  assert.deepEqual(await ledger.receipts(identity.owner), [], 'admission is never presentation');
  const selected = await first.participant('alpha', { owner: akumaDeliveryOwner(actor) });
  assert.equal(selected.generation, recipient.generation);
  assert.equal((await selected.perceive({ ids: [mention.activity.id] })).activities[0].body, 'nonce-body-must-not-be-in-Tell');
  await selected.done();

  const sender2 = (await second.join('sender', { owner: 'test:sender' })).participant;
  await sender2.express('for @alpha', { force: true });
  await sender2.express('flush again', { force: true });
  assert.equal((await readTells()).length, expected.length + 1, 'leaving one Square leaves the other route alive, and unknown is not replayed');
  assert.equal((await ledger.health(identity.owner)).unknownAttempts.length, 1);
  assert.deepEqual(await ledger.receipts(identity.owner), []);
});

test('target validation and the final ledger fence precede invocation; only an exact admission settles accepted', async () => {
  const actor = { world: '/world', akuId: 'aku/alpha/1234abcd' };
  const owner = akumaDeliveryOwner(actor);
  const key = ['square', '/place.square', 'recipient', 'alpha', 'join', 'generation', 'act', '4'];
  const card = { owner, key, text: 'do not copy card text into Tell' };
  const trace = [];
  class AkumaNotBornError extends Error {}
  let proof = true, fence = true, admit = () => ({ kind: 'admitted', akumaId: actor.akuId, tellId: 'tell-id' });
  const transport = new KeiyakuWakeTransport(async () => ({
    World: { prove: async world => world, established: async () => proof }, AkumaNotBornError,
    Akuma: { select: (_root, id) => ({ id, tell(_prompt, options) {
      trace.push('invoked');
      assert.deepEqual(options, { wait: false, signal: context.signal });
      return admit();
    } }) },
  }));
  const context = { token: 'attempt', deadline: Date.now() + 10_000, signal: new AbortController().signal,
    async prepare({ payloadHash }) { trace.push('prepared'); assert.match(payloadHash, /^[a-f0-9]{64}$/); return true; },
    async beforeSend() { trace.push('fenced'); return fence; } };
  assert.equal(await transport.send(card, { ...actor, world: '/other' }, context), 'not-capable');
  proof = false;
  assert.equal(await transport.send(card, actor, context), 'not-capable');
  assert.deepEqual(trace, []);
  proof = true;
  fence = false;
  assert.equal(await transport.send(card, actor, context), 'not-capable');
  assert.deepEqual(trace.splice(0), ['prepared', 'fenced']);
  fence = true;
  assert.equal(await transport.send(card, actor, context), 'accepted');
  assert.deepEqual(trace.splice(0), ['prepared', 'fenced', 'invoked']);
  admit = () => ({ kind: 'admitted', akumaId: 'aku/beta/1234abcd', tellId: 'other-id' });
  assert.equal(await transport.send(card, actor, context), 'unknown');
  admit = () => { throw new AkumaNotBornError(); };
  assert.equal(await transport.send(card, actor, context), 'failed');
  admit = () => { throw Object.assign(new Error('wake failed after admission'), { tell: { kind: 'failed', akumaId: actor.akuId, tellId: 'tell-id' } }); };
  assert.equal(await transport.send(card, actor, context), 'accepted');
});
