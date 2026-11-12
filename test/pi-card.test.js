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
  assert.match(rows[0], /^■ design\.square\s+▪▪▪$/);
  assert.match(rows[1], /^│ rei → @faye · 09:21\s+act\/14$/);
  assert.equal(rows[2], '│ nods and @faye — done');
  assert.match(rows[3], /^│ aoi reply → kei · 09:21\s+act\/15$/);
  assert.equal(rows[4], '│ bold answer');
  assert.match(rows[5], /^│ kei bell · 09:21\s+act\/18$/);
  assert.equal(rows[6], '│ bell rings');
  assert.deepEqual(items, source);
});

test('the header tally is absent for one, marks two through five and counts larger batches', () => {
  for (const [count, tally] of [[1, ''], [2, '▪▪'], [5, '▪▪▪▪▪'], [6, '▪ 6'], [12, '▪ 12']]) {
    const items = Array.from({ length: count }, (_, index) => card('rei', 'hello', 'attention', index + 1));
    const header = content(render(items))[0];
    assert.equal(header.replace(/^■ design\.square\s*/, ''), tally);
  }
});

test('collapse keeps six non-blank rows including bylines and counts the hidden rows', t => {
  t.mock.method(Date, 'now', () => at);
  const items = [card('kei', 'first'), card('aoi', 'paragraph\n\n- item\n- item', 'reply', 15),
    card('rei', 'last', 'attention', 16)];
  const collapsed = content(render(items));
  const expanded = content(render(items, true));
  const nonBlank = expanded.filter(row => row !== '│');
  assert.deepEqual(collapsed.slice(0, -1), nonBlank.slice(0, 7)); // Header plus six activity rows.
  assert.equal(collapsed.at(-1), '  +2 lines');
  assert.ok(expanded.includes('│'));
  const fits = [card('rei', 'one\ntwo\nthree\nfour\nfive')];
  assert.deepEqual(render(fits), render(fits, true));
  assert.equal(content(render([card('rei', 'one\ntwo\nthree\nfour\nfive\nsix')])).at(-1), '  +1 line');
});

test('producer labels are rendered as supplied; old cards keep their body without inferred labels', t => {
  t.mock.method(Date, 'now', () => at);
  const items = [{ ...card('猫_name', 'hello'), label: 'express' },
    { ...card('@square-tui', '**answer**'), origin: 'Keiyaku', ref: 'turn/388', reach: undefined, label: 'done' },
    { ...card('worker', '✓ done\nlegacy answer'), origin: 'external', ref: 'job/1', reach: undefined },
    { ...card('aoi', 'reply body', 'reply', 15), replyTo: 'kei', label: 'custom event' }];
  const source = structuredClone(items);
  const rows = content(render(items, true));
  assert.match(rows[1], /^│ 猫_name express · 09:21\s+act\/14$/);
  assert.match(rows[3], /^│ @square-tui done · 09:21\s+turn\/388$/);
  assert.equal(rows[4], '│ answer');
  assert.match(rows[5], /^│ worker · 09:21\s+job\/1$/);
  assert.equal(rows[6], '│ ✓ done');
  assert.equal(rows[7], '│ legacy answer');
  assert.match(rows[8], /^│ aoi custom event · reply → kei · 09:21\s+act\/15$/);
  assert.deepEqual(items, source);
});

test('all guides are warning colored, with ordinary activity dimmed and direct activity bright', t => {
  t.mock.method(Date, 'now', () => at);
  for (const reach of ['mention', 'reply', 'bell', 'attention', undefined]) {
    const raw = render([{ ...card('rei', '*nods*\nnext'), reach }], true).slice(2, -1);
    const guide = theme.fg('warning', '│ ');
    const direct = ['mention', 'reply', 'bell'].includes(reach);
    assert.ok(raw.every(line => line.startsWith(direct ? guide : `\x1b[2m${guide}\x1b[22m`)));
    assert.ok(raw[0].includes(theme.fg('accent', theme.bold('rei'))));
    assert.ok(raw[1].includes(theme.fg('muted', theme.italic('nods'))));
  }
});

test('narrow bylines preserve the author and activity reference before label and time', t => {
  t.mock.method(Date, 'now', () => at);
  const items = [card('rei', 'body uses full width', 'mention')];
  for (const width of [12, 18, 24]) {
    assert.match(content(render(items, true, width))[1], /^│ rei.*act\/14$/);
  }
  assert.equal(content(render(items, true, 24))[2], '│ body uses full width');
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
