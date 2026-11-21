import assert from 'node:assert/strict';
import test from 'node:test';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { renderSquareCard } from '../plugins/pi/square-pi.js';

const theme = {
  fg: (_slot, text) => text,
  bg: (_slot, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  underline: (text) => text,
  strikethrough: (text) => text,
};
const at = new Date(2026, 10, 10, 9, 21).getTime();
const card = (author, body, reach = 'attention', index = 14) => ({
  kind: 'presentation', origin: '/work/design.square', ref: `act/${index}`, author, body, reach, at, recipient: 'faye',
});
const plain = (lines) => lines.map((line) => stripTerminalSequences(line).trimEnd());
const content = (lines) => plain(lines).slice(1, -1); // The card's outer vertical padding.

test('structured cards keep authors, stable refs, full Markdown bodies and producer labels', (t) => {
  t.mock.method(Date, 'now', () => at);
  const items = [
    card('rei', '*nods* and @faye — done', 'mention', 14),
    { ...card('aoi', '**bold** answer', 'reply', 15), replyTo: 'kei', label: 'express' },
  ];
  const source = structuredClone(items);
  const text = content(renderSquareCard({ content: 'MODEL REMINDER', details: { items } }, { expanded: true, outputPad: 0 }, theme).render(80)).join('\n');
  assert.match(text, /rei/);
  assert.match(text, /act\/14/);
  assert.match(text, /nods and @faye — done/);
  assert.match(text, /aoi/);
  assert.match(text, /act\/15/);
  assert.match(text, /bold answer/);
  assert.match(text, /express/);
  assert.doesNotMatch(text, /MODEL REMINDER/);
  assert.deepEqual(items, source);
});

test('invalid structured details fall back to the card body', () => {
  const items = [{ ...card('a', 'body'), reach: 'invalid' }];
  const result = renderSquareCard({ content: '**legacy** body', details: { items } }, { expanded: false, outputPad: 0 }, theme);
  assert.deepEqual(plain(result.render(80)), ['legacy body']);
});
