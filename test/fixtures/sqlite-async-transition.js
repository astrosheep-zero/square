import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { createSquareState } from '../../dist/artifact.js';
import { createFileCell, createMemoryCell } from '../../dist/square-storage.js';

const [kind, squarePath] = process.argv.slice(2);
const cell = kind === 'file'
  ? createFileCell(squarePath)
  : createMemoryCell(await createSquareState({ force: true, hardCap: null }, 'async transition fixture'));
let unhandled;
process.on('unhandledRejection', (reason) => { unhandled = reason; });

try {
  const before = await cell.read();
  await assert.rejects(
    () => cell.transact(async () => { throw new Error('async callback must not escape'); }),
    /synchronous|thenable|Promise/i,
  );
  await sleep(20);
  assert.equal(unhandled, undefined, String(unhandled));
  assert.deepEqual((await cell.read()).state, before.state);
  assert.equal((await cell.read()).version, before.version);
} finally {
  await cell.close();
}
