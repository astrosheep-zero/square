import { DeliveryLedger } from '../../dist/delivery-ledger.js';
import { harnessOwner } from '../../dist/owner.js';
import { beginClaudeMcpCall } from '../../dist/claude-mcp-context.js';

const [root, command, sessionId, key, text] = process.argv.slice(2);
const owner = harnessOwner({ channel: 'claude-code', session: sessionId });
const ledger = await DeliveryLedger.open({ location: `${root}/delivery.sqlite` });
try {
  if (command === 'seed-call') console.log(JSON.stringify(await beginClaudeMcpCall({
    toolUseId: key, sessionId, cwd: `${root}/work`,
  }, { ...process.env, SQUARE_DELIVERY: `${root}/delivery.sqlite` })));
  else if (command === 'post') console.log(JSON.stringify(await ledger.post({ owner, key, text })));
  else if (command === 'inspect') {
    const current = await ledger.session(owner);
    console.log(JSON.stringify({
      session: current,
      pending: current?.state === 'attached' ? await ledger.pending(owner, { generation: current.generation }) : [],
      handoffs: current ? await ledger.handoffs(owner, { generation: current.generation }) : [],
      receipts: await ledger.receipts(owner),
    }));
  } else throw new Error(`Unknown operation ${command}`);
} finally { await ledger.close(); }
