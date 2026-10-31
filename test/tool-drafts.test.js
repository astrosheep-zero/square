import assert from 'node:assert/strict';
import test from 'node:test';

import { SquareExpressDrafts } from '../dist/square-tools.js';

const unsent = { code: 'behind', message: 'pending', operation: { expressEffect: 'unsent' } };

test('express drafts are owner-scoped, consumed on success, and limited to FIFO 64', () => {
  const drafts = new SquareExpressDrafts();
  const tokens = Array.from({ length: 65 }, (_, index) => drafts.retain({ body: `body ${index}` }, 'owner-a', undefined, unsent, true));
  assert.ok(tokens.every(token => typeof token === 'string'));
  assert.throws(() => drafts.resolve({ draft: tokens[0] }, 'owner-a'), /Unknown, expired, or inaccessible/);
  assert.deepEqual(drafts.resolve({ draft: tokens[1] }, 'owner-a'), { args: { body: 'body 1' }, token: tokens[1] });
  assert.throws(() => drafts.resolve({ draft: tokens[1] }, 'owner-b'), /Unknown, expired, or inaccessible/);
  assert.throws(() => drafts.resolve({ draft: tokens[1], body: 'replacement' }, 'owner-a'), /cannot be combined/);
  drafts.consume(tokens[1]);
  assert.throws(() => drafts.resolve({ draft: tokens[1] }, 'owner-a'), /Unknown, expired, or inaccessible/);
  assert.deepEqual(drafts.resolve({ draft: tokens[64] }, 'owner-a'), { args: { body: 'body 64' }, token: tokens[64] });
});

test('express drafts expire two hours after creation without sliding renewal', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const drafts = new SquareExpressDrafts();
  const token = drafts.retain({ body: 'short lived' }, 'owner', undefined, unsent, true);
  assert.ok(token);
  now += 2 * 60 * 60 * 1000 - 1;
  assert.equal(drafts.retain({ body: 'short lived' }, 'owner', token, unsent, true), token);
  assert.deepEqual(drafts.resolve({ draft: token }, 'owner').args, { body: 'short lived' });
  now += 1;
  assert.throws(() => drafts.resolve({ draft: token }, 'owner'), /Unknown, expired, or inaccessible/);
});

test('only pre-attempt and confirmed-unsent failures become retryable drafts', () => {
  const drafts = new SquareExpressDrafts();
  for (const expressEffect of ['landed', 'unknown']) {
    const token = drafts.retain({ body: 'check history first' }, 'owner', undefined, {
      code: 'internal', message: 'result failed', operation: { expressEffect },
    }, true);
    assert.equal(token, undefined);
  }
  assert.equal(drafts.retain({ body: 'do not retry' }, 'owner', undefined, {
    code: 'internal', message: 'presentation failed after the operation',
  }, true), undefined);
  assert.ok(drafts.retain({ body: 'open failed before express' }, 'owner', undefined, {
    code: 'io', message: 'artifact unavailable',
  }, false));
  assert.equal(drafts.retain({ draft: 'dr_nested', body: 'do not nest drafts' }, 'owner', undefined, {
    code: 'invalid_args', message: 'draft cannot be combined with body',
  }, false), undefined);
});
