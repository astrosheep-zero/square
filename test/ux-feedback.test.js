import assert from 'node:assert/strict';
import test from 'node:test';
import { renderExpressWaiting } from '../dist/cli/express-presentation.js';

test('throttle waiting is not rendered as a failed send', () => {
  const text = renderExpressWaiting({ reason: 'throttled', delayMs: 1000 });
  assert.match(text, /waiting/);
  assert.doesNotMatch(text, /✕/);
});
