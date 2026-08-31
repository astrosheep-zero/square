import assert from 'node:assert/strict';
import test from 'node:test';

import { renderDeliveryHealth } from '../dist/delivery-health.js';

function deliveryItem(kind, actIndex, fields = {}) {
  return {
    squarePath: '/tmp/SQUARE.square',
    recipient: `Recipient-${actIndex}`,
    actIndex,
    actor: `Actor-${actIndex}`,
    at: 0,
    ageMs: 0,
    route: 'mention',
    kind,
    ...fields,
  };
}

test('delivery health presentation bounds details without losing classified totals or groups', () => {
  const kinds = ['awaiting', 'wake-accepted', 'wake-unknown', 'presented-not-delivered', 'unreachable'];
  const items = kinds.flatMap((kind, group) => Array.from({ length: 5 }, (_, index) => deliveryItem(kind, group * 5 + index)));
  const lines = renderDeliveryHealth(items);

  assert.equal(lines[0], '· delivery attention · 25 pending');
  assert.deepEqual(lines.filter((line) => /^[○✕] (?:awaiting|wake-accepted|wake-unknown|presented-not-delivered|unreachable):/.test(line)), [
    '○ awaiting: 5',
    '○ wake-accepted: 5',
    '✕ wake-unknown: 5',
    '○ presented-not-delivered: 5',
    '✕ unreachable: 5',
  ]);
  assert.equal(lines.filter((line) => line.startsWith('  · act/')).length, 20);
  assert.equal(lines.at(-1), '20 of 25 pending details shown');
});

test('delivery health presentation keeps one short detail line stable', () => {
  assert.deepEqual(renderDeliveryHealth([deliveryItem('awaiting', 7, { recipient: 'Bob', actor: 'Alice' })]), [
    '· delivery attention · 1 pending',
    '○ awaiting: 1',
    '  · act/7 → @Bob from @Alice · 0ms',
  ]);
});

test('delivery health presentation ellipsizes recipient, actor, and wake signature fields', () => {
  const recipient = `recipient-${'r'.repeat(160)}`;
  const actor = `actor-${'a'.repeat(160)}`;
  const signature = `signature-${'s'.repeat(160)}`;
  const [detail] = renderDeliveryHealth([deliveryItem('wake-accepted', 7, {
    recipient,
    actor,
    attempt: {
      at: 0,
      attention: { squarePath: '/tmp/SQUARE.square', recipient, actIndex: 7 },
      routeKind: 'paseo',
      outcome: 'accepted',
      signature,
      attemptN: 1,
    },
  })]).filter((line) => line.startsWith('  · act/'));

  const fields = detail.match(/→ (.+) from (.+) · 0ms · (.+)$/)?.slice(1);
  assert.ok(fields);
  for (const field of fields) {
    assert.equal([...field].length, 160);
    assert.ok(field.endsWith('…'));
  }
});
