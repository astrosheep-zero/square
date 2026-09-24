import assert from 'node:assert/strict';
import test from 'node:test';

import { style } from '../dist/tty-style.js';

const tty = { isTTY: true };
const piped = { isTTY: false };

const PALETTE = {
  blocked: '\x1b[38;5;203m',
  release: '\x1b[38;5;114m',
  changed: '\x1b[38;5;179m',
  dim: '\x1b[38;5;244m',
  match: '\x1b[38;5;222m\x1b[1m',
};

test('each role wraps with its exact codes on a TTY', () => {
  for (const [role, code] of Object.entries(PALETTE)) {
    assert.equal(style(role, 'x', { stream: tty, env: {} }), `${code}x\x1b[0m`);
  }
});

test('style passes text through bare unless stdout is a TTY', () => {
  assert.equal(style('dim', 'x', { stream: piped, env: {} }), 'x');
  assert.equal(style('dim', 'x', { stream: {}, env: {} }), 'x');
});

test('style passes text through bare when NO_COLOR is defined, including empty', () => {
  assert.equal(style('dim', 'x', { stream: tty, env: { NO_COLOR: '1' } }), 'x');
  assert.equal(style('dim', 'x', { stream: tty, env: { NO_COLOR: '' } }), 'x');
});

test('style returns an empty string unwrapped', () => {
  assert.equal(style('match', '', { stream: tty, env: {} }), '');
});
