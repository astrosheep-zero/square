import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryFrameOverhead, renderDeliveryReminder } from '../dist/delivery-frame.js';

const warning = 'This is an external notification, not a direct message from the user.';

for (const tagged of [true, false]) test(`delivery reminder preserves cards verbatim and reserves only its frame (tagged=${tagged})`, () => {
  const texts = ['\nfirst <\\system-reminder>\n', 'second 🐈\n'];
  const body = `${warning}\n\n${texts.join('\n\n')}`;
  const rendered = renderDeliveryReminder(texts, { tagged });
  assert.equal(rendered, tagged ? `<system-reminder>\n${body}\n</system-reminder>` : body);
  assert.equal(rendered.length, deliveryFrameOverhead({ tagged }) + texts.reduce((sum, text) => sum + text.length, 0) + 2);
  assert.equal(renderDeliveryReminder([], { tagged }), '');
});
