// Test-only read of the host ledger's presentation receipt.
import fs from 'node:fs';
import { createArtifactPort } from '../dist/artifact.js';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { harnessOwner } from '../dist/owner.js';
import { sameName } from '../dist/model.js';
import { squarePostKey } from '../dist/square-post.js';

export async function hasPresentedForOwner(sessionId, squarePath, name, actIndex, env = process.env) {
  const owner = harnessOwner({ channel: 'pi', session: sessionId });
  const location = fs.realpathSync(squarePath);
  const artifact = createArtifactPort(location);
  try {
    const { value: audience } = await artifact.read(facts => facts.audience(actIndex)
      .find(entry => sameName(entry.recipient, name) && entry.owner === owner));
    if (audience?.generation === undefined) return false;
    if (!env.SQUARE_DELIVERY) throw new Error('Test delivery ledger location is not configured');
    const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
    try {
      const key = squarePostKey(location, { kind: 'activity', index: actIndex, recipient: audience.recipient, generation: audience.generation });
      return (await ledger.receipts(owner, { keys: [key] })).some(receipt => receipt.key === key);
    } finally { await ledger.close(); }
  } finally { await artifact.close(); }
}
