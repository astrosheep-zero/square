import fs from 'node:fs';
import path from 'node:path';
import { writeSquareFile, readSquareSnapshot, createArtifactPort } from '../../dist/artifact.js';
import { emptyRuntimeState } from '../../dist/square-sqlite.js';
import { writeClaudeNative } from '../../dist/packages/agent-delivery/src/claude-native.js';
import { processActNotificationsOnce } from '../../dist/notifications.js';
import { Square, harnessOwner } from '../../dist/square-api.js';
import { operationEnv } from '../../dist/participant-identity.js';
const root = process.argv[2];
const op = process.argv[3];
const squarePath = path.join(root, 'work/.square/PUBLIC.square');
const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') };
if (op === 'setup') {
  fs.mkdirSync(path.dirname(squarePath), { recursive: true });
  await writeSquareFile(squarePath, { hardCap: null, preamble: [], warmup: ['Isolated dummy API fixture.'], acts: [], runtime: emptyRuntimeState(0) });
} else if (op === 'join') {
  // Explicitly enter using the real receiver coordinate before its first prompt.
  const session = process.argv[4];
  const square = await Square.at({ path: squarePath, env: operationEnv('claude', session, env) });
  try { await square.join('fixture-receiver', { owner: harnessOwner({ channel: 'claude-code', session }) }); }
  finally { await square.close(); }
} else if (op === 'send') {
  const square = await Square.at({ path: squarePath, env });
  let index;
  try {
    const sender = (await square.join('fixture-sender', { owner: 'fixture:sender' })).participant;
    index = Number((await sender.express('Notification BODY: shipped Square native probe.', { mentions: ['fixture-receiver'] })).activity.id.slice(4));
  } finally { await square.close(); }
  await processActNotificationsOnce(squarePath, index, { env });
  console.log(JSON.stringify({ dispatchCompleted: true }));
} else if (op === 'replay') {
  // Replay the actual previously received frame, not a reconstructed legacy ledger payload.
  const records = fs.readFileSync(path.join(root, 'bridge.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const frame = records.find(row => row.input.operation === 'guard' && row.input.text?.includes('[square-inbox:'))?.input;
  if (!frame) throw new Error('No native frame received to replay');
  const endpoint = records.findLast(row => row.input.sessionId === frame.sessionId && row.input.endpoint)?.input.endpoint;
  console.log(JSON.stringify(await writeClaudeNative({ sessionId: frame.sessionId, endpoint }, frame.text, { deadline: Date.now() + 1000 })));
} else if (op === 'inspect') {
  const artifact = createArtifactPort(squarePath);
  try {
    const { value } = await artifact.read(facts => {
      const seats = facts.roster().flatMap(participant => {
        const seat = facts.seat(participant.name);
        return seat === undefined ? [] : [{ ...seat, cancelledThrough: facts.cancelledThrough(seat.participant, seat.generation) }];
      });
      return { seats, evidence: seats.flatMap(seat => facts.deliveryEvidence(seat.participant, seat.generation)) };
    });
    console.log(JSON.stringify({ state: (await readSquareSnapshot(squarePath)).state, ...value }));
  } finally { await artifact.close(); }
}
