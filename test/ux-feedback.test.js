import assert from 'node:assert/strict';
import test from 'node:test';
import { Square } from '../dist/square-api.js';
import { renderHistoryResult } from '../dist/operation-presentation.js';
import { renderExpressWaiting } from '../dist/presentation.js';

test('expanding a clipped history page keeps its activity coordinates', async () => {
  const square = Square.inMemory({ markdown: 'Conversation' });
  try {
    const rei = (await square.join('rei', { owner: ':' })).participant;
    const a = await rei.express('a'.repeat(220), { force: true });
    const b = await rei.express('b'.repeat(220), { force: true });
    const c = await rei.express('newer words', { force: true });
    const result = await square.history({ cursor: { id: c.activity.id, direction: 'before' }, limit: 2, observe: true });
    const text = renderHistoryResult('/tmp/example.square', result);
    assert.ok(text.includes(`history --at ${a.activity.id},${b.activity.id} --full`));
    assert.doesNotMatch(text, /history --full/);
  } finally { await square.close(); }
});

test('throttle waiting is not rendered as a failed send', () => {
  const text = renderExpressWaiting({ reason: 'throttled', delayMs: 1000 });
  assert.match(text, /waiting/);
  assert.doesNotMatch(text, /✕/);
});
