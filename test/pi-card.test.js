import assert from 'node:assert/strict';
import test from 'node:test';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
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
  kind: 'presentation', origin: '/work/design.square', ref: `act/${index}`, author, body, reach, at,
});
function render(items, expanded = false, width = 80, style = theme) {
  return renderSquareCard({ content: 'MODEL REMINDER', details: { items } }, { expanded, outputPad: 0 }, style).render(width);
}
const plain = lines => lines.map(line => stripTerminalSequences(line).trimEnd());
const content = lines => plain(lines).slice(1, -1); // The card's outer vertical padding.

test('collapsed cards keep the oldest four non-blank rows and count only non-blank hidden rows', t => {
  t.mock.method(Date, 'now', () => at);
  const items = [card('kei', 'first', 'attention'), card('aoi', 'paragraph\n\n- item\n- item', 'reply', 15),
    card('rei', 'fifth\n\nsixth', 'attention', 16)];
  const source = structuredClone(items);
  const rawCollapsed = render(items, false, 64);
  const collapsed = content(rawCollapsed);
  assert.ok(rawCollapsed[1].includes(theme.fg('muted', 'design.square')));
  const expanded = content(render(items, true, 64));
  assert.match(collapsed[0], /■ design\.square  3 messages\s+act\/14–16$/);
  assert.deepEqual(collapsed.slice(0, 3), expanded.slice(0, 3));
  assert.match(collapsed[1], /^│ kei first\s+09:21$/);
  assert.match(collapsed[2], /^│ aoi reply paragraph\s+09:21$/);
  assert.equal(collapsed[3], '│ - item');
  assert.equal(collapsed[4], '│ - item…');
  assert.equal(collapsed[5], '  +2 lines');
  assert.equal(expanded[3], '│');
  assert.equal(expanded[4], '│ - item');
  assert.equal(expanded[5], '│ - item');
  assert.match(expanded[6], /^│ rei fifth\s+09:21$/);
  assert.equal(expanded[7], '│');
  assert.equal(expanded[8], '│ sixth');
  assert.deepEqual(items, source);
});

test('short cards have no footer or omission mark; hidden one-line tails use singular', t => {
  t.mock.method(Date, 'now', () => at);
  const items = [card('rei', 'one\ntwo\nthree\nfour')];
  assert.deepEqual(render(items), render(items, true));
  assert.equal(content(render(items)).length, 5);
  assert.equal(content(render(items)).some(line => line.includes('…') || line.includes('+')), false);
  const spaced = [card('rei', 'paragraph\n\n- one\n- two\n- three')];
  const collapsed = content(render(spaced));
  assert.equal(collapsed.length, 5);
  assert.equal(collapsed.some(line => line === '│' || line.includes('…') || line.includes('+')), false);
  assert.ok(content(render(spaced, true)).includes('│'));
  assert.equal(content(render([card('rei', 'one\ntwo\nthree\nfour\nfive')])).at(-1), '  +1 line');
});

test('direct reaches color every message guide and its label; attribution and actions keep their theme roles', t => {
  t.mock.method(Date, 'now', () => at);
  for (const [reach, label] of [['mention', '@you'], ['reply', 'reply'], ['bell', 'bell'], ['attention', undefined]]) {
    const raw = render([card('rei', '*nods*\nnext', reach)], true).slice(2, -1);
    const guide = theme.fg(label ? 'warning' : 'borderMuted', '│ ');
    assert.ok(raw.length >= 2);
    assert.ok(raw.every(line => line.startsWith(guide)));
    assert.ok(raw[0].includes(theme.fg('accent', theme.bold('rei'))));
    if (label) assert.ok(raw[0].includes(theme.fg('warning', label)));
    else assert.match(plain(raw)[0], /^│ rei nods/);
    assert.ok(raw[0].includes(theme.fg('muted', theme.italic('nods'))));
  }
});

test('the widest local time label sets one right gutter for all first lines', t => {
  t.mock.method(Date, 'now', () => at);
  const yesterday = new Date(2026, 10, 9, 22, 40).getTime();
  const older = new Date(2026, 10, 8, 22, 40).getTime();
  const lines = content(render([card('a', 'today'), { ...card('b', 'yesterday'), at: yesterday }, { ...card('c', 'older'), at: older }], true));
  const rows = lines.slice(1);
  assert.match(rows[0], /09:21$/);
  assert.match(rows[1], /yest 22:40$/);
  assert.match(rows[2], /11\/08 22:40$/);
  assert.equal(new Set(rows.map(visibleWidth)).size, 1);
});

test('reference gaps stay explicit and different origins never merge', t => {
  t.mock.method(Date, 'now', () => at);
  const items = [card('a', 'one', 'attention', 14), card('b', 'two', 'attention', 16),
    { ...card('c', 'three', 'attention', 17), origin: '/other/design.square' }];
  const header = content(render(items, true, 140))[0];
  assert.match(header, /design\.square act\/14, design\.square act\/16, design\.square act\/17$/);
  const narrow = content(render([card('a', 'one')], true, 18))[0];
  assert.match(narrow, /act\/14$/);
});

test('plain items have no inferred name, and legacy cards retain the Markdown fallback', t => {
  t.mock.method(Date, 'now', () => at);
  assert.match(content(render([{ text: '**plain** body' }], true))[1], /^│ plain body$/);
  for (const details of [undefined, { items: [] }, { items: [{ ...card('a', 'body'), reach: 'invalid' }] }]) {
    const result = renderSquareCard({ content: '**legacy** body', details }, { expanded: false, outputPad: 0 }, theme);
    assert.deepEqual(plain(result.render(80)), ['legacy body']);
  }
});

test('every line fits its terminal width, including Unicode, ANSI, code, tables and legacy fallback', t => {
  t.mock.method(Date, 'now', () => at);
  const items = [card('猫/👨‍👩‍👧‍👦', `${'鱼🦈e\u0301'.repeat(30)}\n\n\`\`\`ts\n${'x'.repeat(180)}\n\`\`\`\n\n| key | value |\n| --- | --- |\n| wide | ${'long'.repeat(25)} |`, 'mention')];
  for (const expanded of [false, true]) {
    const structured = renderSquareCard({ content: 'reminder', details: { items } }, { expanded }, theme);
    const legacy = renderSquareCard({ content: items[0].body }, { expanded }, theme);
    for (const width of [0, 1, 2, 3, 8, 18, 40, 80]) {
      for (const component of [structured, legacy]) {
        for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `line exceeds ${width} columns`);
      }
    }
  }
});
