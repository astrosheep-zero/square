import assert from 'node:assert/strict';
import test from 'node:test';

import { style } from '../dist/surfaces/tty-style.js';

test('style stays unstyled without a TTY or under NO_COLOR', () => {
  assert.equal(style('dim', 'x', { stream: { isTTY: false }, env: {} }), 'x');
  assert.equal(style('dim', 'x', { stream: { isTTY: true }, env: { NO_COLOR: '' } }), 'x');
});
