import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DeliveryLedger } from '../../dist/ledger/delivery-ledger.js';
import plugin from '../../dist/plugins/opencode-v1/index.js';

const [location, generation, mode] = process.argv.slice(2);
const owner = 'test:sqlite';
if (mode === 'claim') {
  const ledger = await DeliveryLedger.open({ location });
  try {
    const batch = await ledger.claimPresentation(owner, { generation, budgetChars: 10000 });
    if (batch) { assert.equal(await batch.settle('presented'), true); console.log('claimed'); }
  } finally { await ledger.close(); }
} else {
  const missing = path.join(path.dirname(location), 'missing.sqlite');
  await assert.rejects(DeliveryLedger.open({ location: missing, readOnly: true }));
  await assert.rejects(fs.access(missing));
  const readonly = await DeliveryLedger.open({ location, readOnly: true });
  try {
    const [card] = await readonly.pending(owner, { generation });
    assert.deepEqual(card.key, ['one']);
    assert.equal(card.text, '鱼🐈 one card across runtimes');
    await assert.rejects(readonly.post({ owner, key: ['refused'], text: 'read only' }));
  } finally { await readonly.close(); }

  process.env.SQUARE_DELIVERY = location;
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ version: '1.18.35' });
  let hooks;
  try {
    hooks = await plugin({ serverUrl: 'http://127.0.0.1', directory: path.dirname(location), project: { id: 'fixture' },
      client: { session: { get: async () => ({}), promptAsync: async () => ({}) } } });
    assert.equal(typeof hooks.event, 'function');
    assert.equal(typeof hooks['experimental.chat.messages.transform'], 'function');
  } finally { globalThis.fetch = fetch; await hooks?.dispose?.(); }

  const ledger = await DeliveryLedger.open({ location });
  try {
    const batch = await ledger.claimPresentation(owner, { generation, budgetChars: 10000 });
    assert.ok(batch);
    assert.deepEqual(batch.cards.map(card => card.key), [['one']]);
    assert.equal(await batch.settle('presented'), true);
    console.log('claimed');
  } finally { await ledger.close(); }
}
