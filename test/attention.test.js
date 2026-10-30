import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAudience } from '../dist/attention.js';

test('attention resolves canonical recipients with precedence, ignore, and bell', () => {
  const input = {
    actor: 'ALICE', recipients: ['Alice', 'Bob', 'BOB', 'Cara', 'Dan', 'Eve'],
    mentions: ['bob', 'alice', 'missing', 'cara', 'BOB'], replyAuthor: 'dan',
    incoming: [{ listener: 'cara', kind: 'ignore' }, { listener: 'bob', kind: 'listen' },
      { listener: 'dan', kind: 'listen' }, { listener: 'eve', kind: 'listen' }],
    sameIdentity: (a, b) => a.toLowerCase() === b.toLowerCase(),
  };
  const before = structuredClone({ ...input, sameIdentity: undefined });
  assert.deepEqual(resolveAudience(input), [
    { recipient: 'Bob', route: 'mention' }, { recipient: 'Dan', route: 'reply' },
    { recipient: 'Eve', route: 'attention' },
  ]);
  assert.deepEqual(resolveAudience({ ...input, reach: 'bell' }), [
    { recipient: 'Bob', route: 'bell' }, { recipient: 'Cara', route: 'bell' },
    { recipient: 'Dan', route: 'bell' }, { recipient: 'Eve', route: 'bell' },
  ]);
  assert.deepEqual({ ...input, sameIdentity: undefined }, before);
});
