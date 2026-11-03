// A producer notice and its receiver's ledger presentation, using a disposable square.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Square } from '@astrosheep/square';
import { DeliveryLedger } from '@astrosheep/square/delivery-ledger';

const directory = await mkdtemp(path.join(os.tmpdir(), 'square-notice-example-'));
const ledgerPath = path.join(directory, 'delivery.sqlite');
const env = { ...process.env, SQUARE_DELIVERY: ledgerPath };
let square, ledger;
try {
  square = await Square.build({ path: path.join(directory, 'example.square'), markdown: 'Example', env });
  ledger = await DeliveryLedger.open({ location: ledgerPath });
  await square.join('Reader', { owner: 'example:reader' });
  const notice = await square.send({
    from: 'Coordinator', to: 'Reader', body: 'The work is ready.', metadata: { job: { id: 7 } },
  });
  const session = await ledger.session('example:reader');
  const claim = await ledger.claimPresentation('example:reader', { generation: session.generation, budgetChars: 10000 });
  if (!claim) throw new Error('No card was available for presentation');
  // This callback represents the receiver actually presenting the card.
  const presented = claim.cards.map(card => card.text);
  await claim.settle('presented');
  console.log(JSON.stringify({ notice, presented, receipts: await ledger.receipts('example:reader') }, null, 2));
} finally {
  await square?.close();
  await ledger?.close();
  await rm(directory, { recursive: true, force: true });
}
