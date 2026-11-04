import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from '../../dist/delivery-ledger-sqlite.js';
import { DeliveryLedger } from '../../dist/delivery-ledger.js';
import plugin from '../../dist/plugins/opencode-v1/index.js';

const [mode, root, generation] = process.argv.slice(2);
const location = path.join(root, 'delivery.sqlite');
const owner = 'test:sqlite';
if (mode === 'claim') {
  const ledger = await DeliveryLedger.open({ location });
  try {
    const batch = await ledger.claimPresentation(owner, { generation, budgetChars: 10000 });
    if (batch) { assert.equal(await batch.settle('presented'), true); console.log('claimed'); }
  } finally { await ledger.close(); }
} else {
  const missing = path.join(root, 'missing.sqlite');
  assert.throws(() => new DatabaseSync(missing, { readOnly: true }));
  await assert.rejects(fs.access(missing));
  const file = path.join(root, 'driver #?.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE sample (value TEXT)');
  assert.equal(db.prepare('SELECT value FROM sample').get(), undefined);
  assert.equal(Number(db.prepare('INSERT INTO sample VALUES (?)').run('鱼🐈').changes), 1);
  db.close();
  const before = await fs.readFile(file);
  const readonly = new DatabaseSync(file, { readOnly: true });
  assert.equal(readonly.prepare('SELECT value FROM sample').get().value, '鱼🐈');
  assert.throws(() => readonly.exec("INSERT INTO sample VALUES ('no')"));
  readonly.close();
  await assert.rejects(DeliveryLedger.open({ location: file }), /Unsupported delivery ledger format/);
  assert.deepEqual(await fs.readFile(file), before);
  const broken = path.join(root, 'broken.sqlite');
  await fs.writeFile(broken, 'not a database');
  await assert.rejects(DeliveryLedger.open({ location: broken }));
  assert.equal(await fs.readFile(broken, 'utf8'), 'not a database');

  process.env.SQUARE_DELIVERY = location;
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ version: '1.18.35' });
  let hooks;
  try {
    hooks = await plugin({ serverUrl: 'http://127.0.0.1', directory: root, project: { id: 'fixture' },
      client: { session: { get: async () => ({}), promptAsync: async () => ({}) } } });
    assert.equal(typeof hooks.event, 'function');
    assert.equal(typeof hooks['experimental.chat.messages.transform'], 'function');
  } finally { globalThis.fetch = fetch; await hooks?.dispose?.(); }
}
