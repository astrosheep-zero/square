import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { DeliveryLedger } from '../dist/ledger/delivery-ledger.js';
import { Square } from '../dist/api/square-api.js';
import { renderExpression } from '../dist/surfaces/operation-presentation.js';
import { draftPathFrom, persistSquare, run, withName } from './square-cli-helpers.js';

test('express warns once for absent and observed away targets and resumes without rejoining', async (t) => {
  const ledger = await DeliveryLedger.open({ location: process.env.SQUARE_DELIVERY });
  t.after(() => ledger.close());
  let reply, session;
  const file = await persistSquare(async ({ square, body }) => {
    await square.join('Alice', { owner: body });
    const bob = (await square.join('Bob', { owner: 'test:cli-away-bob' })).participant;
    reply = (await bob.express('question', { force: true })).activity.id;
    session = await ledger.session('test:cli-away-bob');
    await ledger.detach({ owner: session.owner, generation: session.generation });
  });
  const result = run(withName(file, 'Alice', ['express', '--force', '--mention', 'bob', '--mention', 'Nobody', '--reply', reply, '@bob @BOB @Nobody @nobody']));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter(line => line.startsWith('⚠')), [
    '⚠ @Nobody is not in this square.', '⚠ @Bob is away.',
  ]);
  const square = await Square.at({ path: file });
  t.after(() => square.close());
  await ledger.attach({ owner: session.owner, expectedGeneration: session.generation, routes: [] });
  await square.send({ from: 'test', to: 'Alice', body: 'resume' });
  const bob = await square.participant('Bob', { owner: session.owner });
  assert.deepEqual((await bob.perceive()).activities.map(activity => activity.body), ['@bob @BOB @Nobody @nobody']);
});

test('observed words and gestures render their own receipts', async (t) => {
  const square = Square.inMemory({ markdown: 'voice' });
  t.after(() => square.close());
  const alice = (await square.join('Alice', { owner: 'test:cli-voice' })).participant;
  const words = await alice.express('a plain thought', { force: true, observe: true });
  const gesture = await alice.express('*shrugs slowly*', { force: true, observe: true });
  assert.match(renderExpression('memory://voice', words), /● your words land — act\/\d+/);
  assert.match(renderExpression('memory://voice', gesture), /● your gesture lands — act\/\d+/);
});

test('a capped express keeps the exact stdin bytes and points at done', async () => {
  const file = await persistSquare(async ({ square, body }) => {
    const alice = (await square.join('Alice', { owner: body })).participant;
    await alice.express('the one activity', { force: true });
  }, { hardCap: 1 });
  const raw = '  one more @Alice\r\n';
  const capped = run(withName(file, 'Alice', ['express', '--mention', 'Alice', '-']), { input: raw });
  assert.equal(capped.status, 1, capped.stdout + capped.stderr);
  assert.match(capped.stdout, /✕ you’ve reached your speaking cap — 1\/1 spoken/);
  assert.equal(fs.readFileSync(draftPathFrom(capped.stdout), 'utf8'), raw);
  assert.match(capped.stdout, /done\n$/);
});
