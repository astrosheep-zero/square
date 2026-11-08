import { randomUUID } from 'node:crypto';
import { createArtifactPort } from '../../dist/artifact.js';
import { DeliveryLedger } from '../../dist/delivery-ledger.js';
import { squarePostKey } from '../../dist/square-post.js';

const [location, stage, ledgerLocation] = process.argv.slice(2);
const artifact = createArtifactPort(location);
const post = (await artifact.read(facts => facts.pendingPosts()[0])).value;
const token = randomUUID();
if (!(await artifact.transactAs({ kind: 'producer' }, facts => facts.acquirePost({ ...post, full: true }, token, process.pid, Date.now()))).value)
  throw new Error('Expected to acquire the pending producer post');
if (stage === 'after-post' || stage === 'after-settle') {
  const ledger = await DeliveryLedger.open({ location: ledgerLocation });
  await ledger.post({ owner: post.owner, key: squarePostKey(location, post), text: post.body });
  await ledger.close();
  if (stage === 'after-settle')
    await artifact.settleAs({ kind: 'producer' }, facts => facts.settlePost(token, true, 'posted'));
}
process.send({ stage });
// Deliberately retain producer ownership until the parent crashes this process.
setInterval(() => {}, 1000);
