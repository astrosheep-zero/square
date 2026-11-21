import assert from 'node:assert/strict';
import test from 'node:test';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { renderSquareCard } from '../plugins/pi/square-pi.js';

const slots = new Map();
const theme = {
  fg(slot, text) {
    if (!slots.has(slot)) slots.set(slot, slots.size + 1);
    return `\x1b[38;5;${slots.get(slot)}m${text}\x1b[39m`;
  },
  bg: (_slot, text) => text,
  bold: text => `\x1b[1m${text}\x1b[22m`,
  italic: text => `\x1b[3m${text}\x1b[23m`,
  underline: text => `\x1b[4m${text}\x1b[24m`,
  strikethrough: text => `\x1b[9m${text}\x1b[29m`,
};
const at = new Date(2026, 10, 10, 9, 21).getTime();
const card = (author, body, reach = 'attention', index = 14) => ({
  kind: 'presentation', origin: '/work/design.square', ref: `act/${index}`, author, body, reach, at, recipient: 'faye',
});
function render(items, expanded = false, width = 80, style = theme) {
  return renderSquareCard({ content: 'MODEL REMINDER', details: { items } }, { expanded, outputPad: 0 }, style).render(width);
}
const plain = lines => lines.map(line => stripTerminalSequences(line).trimEnd());
const content = lines => plain(lines).slice(1, -1); // The card's outer vertical padding.

test('each activity has its own byline and reference above its full Markdown body', t => {
  t.mock.method(Date, 'now', () => at);
  const items = [card('rei', '*nods* and @faye — done', 'mention'),
    { ...card('aoi', '**bold** answer', 'reply', 15), replyTo: 'kei' },
    card('kei', 'bell rings', 'bell', 18)];
  const source = structuredClone(items);
  const rows = content(render(items, true));
  const rei = rows.findIndex(row => row.endsWith('act/14'));
  assert.match(rows[rei], /^│ rei → @faye · 09:21\s+act\/14$/);
  assert.equal(rows[rei + 1], '│ nods and @faye — done');
  const aoi = rows.findIndex(row => row.endsWith('act/15'));
  assert.match(rows[aoi], /^│ aoi reply → kei · 09:21\s+act\/15$/);
  assert.equal(rows[aoi + 1], '│ bold answer');
  const kei = rows.findIndex(row => row.endsWith('act/18'));
  assert.match(rows[kei], /^│ kei bell · 09:21\s+act\/18$/);
  assert.equal(rows[kei + 1], '│ bell rings');
  assert.deepEqual(items, source);
});

test('producer labels are rendered as supplied; old cards keep their body without inferred labels', t => {
  t.mock.method(Date, 'now', () => at);
  const items = [{ ...card('猫_name', 'hello'), label: 'express' },
    { ...card('@square-tui', '**answer**'), origin: 'Keiyaku', ref: 'turn/388', reach: undefined, label: 'done' },
    { ...card('worker', '✓ done\nlegacy answer'), origin: 'external', ref: 'job/1', reach: undefined },
    { ...card('aoi', 'reply body', 'reply', 15), replyTo: 'kei', label: 'custom event' }];
  const source = structuredClone(items);
  const rows = content(render(items, true));
  const named = rows.findIndex(row => row.endsWith('act/14'));
  assert.match(rows[named], /^│ 猫_name express · 09:21\s+act\/14$/);
  assert.equal(rows[named + 1], '│ hello');
  const renamed = rows.findIndex(row => row.endsWith('turn/388'));
  assert.match(rows[renamed], /^│ @square-tui done · 09:21\s+turn\/388$/);
  assert.equal(rows[renamed + 1], '│ answer');
  const worker = rows.findIndex(row => row.endsWith('job/1'));
  assert.match(rows[worker], /^│ worker · 09:21\s+job\/1$/);
  assert.deepEqual(rows.slice(worker + 1, worker + 3), ['│ ✓ done', '│ legacy answer']);
  const custom = rows.findIndex(row => row.endsWith('act/15'));
  assert.match(rows[custom], /^│ aoi custom event · reply → kei · 09:21\s+act\/15$/);
  assert.equal(rows[custom + 1], '│ reply body');
  assert.deepEqual(items, source);
});

test('plain items have no inferred name, and legacy cards retain the Markdown fallback', t => {
  t.mock.method(Date, 'now', () => at);
  assert.ok(content(render([{ text: '**plain** body' }], true)).includes('│ plain body'));
  for (const details of [undefined, { items: [] }, { items: [{ ...card('a', 'body'), reach: 'invalid' }] }]) {
    const result = renderSquareCard({ content: '**legacy** body', details }, { expanded: false, outputPad: 0 }, theme);
    assert.deepEqual(plain(result.render(80)), ['legacy body']);
  }
});
