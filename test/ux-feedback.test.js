import assert from 'node:assert/strict';
import test from 'node:test';
import { Square } from '../dist/square-api.js';
import { renderHistoryResult, renderJoinResult } from '../dist/operation-presentation.js';
import { renderExpressWaiting } from '../dist/presentation.js';

test('join guidance follows delivery capability, not a blanket instruction to wait', () => {
  const base = { kind: 'reconnected', participant: 'rei', observation: {
    location: '/tmp/example.square', standingCount: 1, now: 0,
  } };
  const native = renderJoinResult({ ...base, observation: { ...base.observation, deliveryAvailable: true } });
  const manual = renderJoinResult({ ...base, observation: { ...base.observation, deliveryAvailable: false } });
  assert.match(native, /when someone calls you, you’ll hear them here/);
  assert.doesNotMatch(native, /catch --idle/);
  assert.match(manual, /catch --idle 30m/);
  assert.match(manual, /stay within earshot/);
  for (const output of [native, manual]) assert.doesNotMatch(output, /every word here lands on a real ear/);
});

test('expanding a clipped history page keeps its activity coordinates', async () => {
  const square = Square.inMemory({ markdown: 'Conversation' });
  try {
    const rei = (await square.join('rei', { owner: ':' })).participant;
    const a = await rei.express('a'.repeat(220), { force: true });
    const b = await rei.express('b'.repeat(220), { force: true });
    const c = await rei.express('newer words', { force: true });
    const result = await square.history({ cursor: { id: c.activity.id, direction: 'before' }, limit: 2, observe: true });
    const text = renderHistoryResult('/tmp/example.square', result);
    assert.ok(text.includes(`history --at ${a.activity.id},${b.activity.id} --no-truncate`));
    assert.doesNotMatch(text, /history --no-truncate/);
  } finally { await square.close(); }
});

test('throttle waiting is not rendered as a failed send', () => {
  const text = renderExpressWaiting({ reason: 'throttled', delayMs: 1000 });
  assert.match(text, /waiting/);
  assert.doesNotMatch(text, /✕/);
});
