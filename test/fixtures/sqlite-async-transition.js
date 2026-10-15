import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { createArtifactPort, prepareSquareBuild } from '../../dist/artifact.js';

const [kind, squarePath] = process.argv.slice(2);
const cell = kind === 'file'
  ? createArtifactPort(squarePath)
  : createArtifactPort(':memory:', await prepareSquareBuild({ force: true, hardCap: null }, 'async transition fixture'));
let unhandled;
process.on('unhandledRejection', (reason) => { unhandled = reason; });

try {
  const before = await cell.read(facts => facts.header());
  await assert.rejects(
    () => cell.transact(async () => { throw new Error('async callback must not escape'); }),
    /synchronous|thenable|Promise/i,
  );
  await sleep(20);
  assert.equal(unhandled, undefined, String(unhandled));
  assert.deepEqual(await cell.read(facts => facts.header()), before);
} finally {
  await cell.close();
}
