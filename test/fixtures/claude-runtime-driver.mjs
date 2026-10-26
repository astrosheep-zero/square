import fs from 'node:fs';
import path from 'node:path';
import { writeSquareFile, readSquareSnapshot } from '../../dist/artifact.js';
import { emptyRuntimeState } from '../../dist/square-sqlite.js';
import { createHostLedgerPort } from '../../dist/host-ledger-file-adapter.js';
import { writeClaudeNative } from '../../dist/packages/agent-delivery/src/claude-native.js';
import { processActNotificationsOnce } from '../../dist/notifications.js';
import { Square } from '../../dist/square-api.js';
import { operationEnv } from '../../dist/participant-identity.js';
const root = process.argv[2];
const op = process.argv[3];
const squarePath = path.join(root, 'work/.square/PUBLIC.square');
const ledger = createHostLedgerPort({ rootPath: path.join(root, 'ledger') });
if (op === 'setup') {
  fs.mkdirSync(path.dirname(squarePath), { recursive: true });
  await writeSquareFile(squarePath, { hardCap: null, preamble: [], warmup: ['Isolated dummy API fixture.'], acts: [], runtime: emptyRuntimeState(0) });
} else if (op === 'join') {
  // The fixture explicitly enters using the real receiver coordinate, before its first prompt.
  const env = operationEnv('claude', process.argv[4], { ...process.env, SQUARE_HOST_LEDGER_ROOT: path.join(root, 'ledger') });
  const square = await Square.at({ path: squarePath, hostLedger: ledger, env });
  try { await square.join('fixture-receiver'); } finally { await square.close(); }
} else if (op === 'send') {
  const presence = await ledger.listPresence();
  const receiver = presence.find((row) => row.channel === 'claude-code');
  if (!receiver) throw new Error('Isolated receiver not bound');
  const senderBody = { channel: 'claude-code', session: 'fixture-sender' };
  const square = await Square.at({ path: squarePath, body: senderBody, participant: 'fixture-sender' });
  let index;
  try {
    const sender = (await square.join('fixture-sender')).participant;
    index = Number((await sender.express('Notification BODY: shipped Square native probe.', { mentions: [receiver.participant] })).activity.id.slice(4));
  } finally { await square.close(); }
  console.log(JSON.stringify(await processActNotificationsOnce(squarePath, index, { env: { ...process.env, SQUARE_HOST_LEDGER_ROOT: path.join(root, 'ledger') } })));
} else if (op === 'replay') {
  const row = (await ledger.listEvidence({ kind: 'wake' })).find((row) => row.nativeDelivery);
  console.log(JSON.stringify(await writeClaudeNative({ sessionId: row.session, endpoint: row.nativeDelivery.endpoint }, row.nativeDelivery.payload, { deadline: Date.now() + 1000 })));
} else if (op === 'inspect') {
  const square = await Square.at({ path: squarePath, env: { ...process.env, SQUARE_HOST_LEDGER_ROOT: path.join(root, 'ledger') } });
  try { console.log(JSON.stringify({ state: (await readSquareSnapshot(squarePath)).state, presence: await ledger.listPresence(), evidence: await ledger.listEvidence() })); }
  finally { await square.close(); }
}
