import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import squarePiExtension from '../extensions/square-pi.js';
import { writeSquareFile, emptyRuntimeState, loadSquare } from '../dist/artifact.js';
import { recordJoin } from '../dist/registry.js';

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-isolation-'));
  const file = path.join(root, 'SQUARE.square');
  const keys = ['SQUARE_REGISTRY', 'SQUARE_PRESENTED', 'SQUARE_PI_SESSION_ID', 'SQUARE_PI_BOUNDARY_TIMEOUT_MS', 'SQUARE_HOST_LEDGER_USER', 'SQUARE_HOST_LEDGER_LOCAL'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'), SQUARE_PRESENTED: path.join(root, 'presented.ndjsonl'), SQUARE_PI_BOUNDARY_TIMEOUT_MS: '20', SQUARE_HOST_LEDGER_USER: root, SQUARE_HOST_LEDGER_LOCAL: root });
  delete process.env.SQUARE_PI_SESSION_ID;
  const sessionId = `isolation-${path.basename(root)}`;
  await writeSquareFile(file, { hardCap: null, preamble: [], warmup: ['test'], runtime: emptyRuntimeState(3), acts: [
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, index: 2, body: 'do not acknowledge a timed-out preview', mentions: ['Bob'] },
  ] });
  await recordJoin(sessionId, 'Bob', file, { channel: 'pi', ownerId: 'pi-owner' });
  const handlers = new Map();
  squarePiExtension({ on(event, handler) { handlers.set(event, handler); }, sendMessage() { assert.fail('busy Pi must not be woken'); } });
  const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId }, isIdle: () => false };
  await handlers.get('session_start')({}, ctx);
  try { await run({ root, file, handlers, ctx }); }
  finally {
    await handlers.get('session_shutdown')({}, ctx);
    // Let cancelled background I/O unwind before restoring the isolated environment.
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
}

async function boundedHook(handlers, ctx) {
  let timer;
  try {
    return await Promise.race([
      handlers.get('before_agent_start')({}, ctx),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Square blocked the Pi prompt beyond its boundary deadline')), 500); }),
    ]);
  } finally { clearTimeout(timer); }
}

test('Pi prompt escapes blocked artifact I/O and never acknowledges a late preview', async () => {
  await fixture(async ({ file, handlers, ctx }) => {
    const database = new DatabaseSync(file);
    database.exec('BEGIN EXCLUSIVE');
    try { assert.equal(await boundedHook(handlers, ctx), undefined); }
    finally { database.exec('ROLLBACK'); database.close(); }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await loadSquare(file)).runtime.observations.Bob?.['act/2'], undefined);
  });
});

test('Pi prompt and shutdown survive an unreadable bound artifact without changing its bytes', async () => {
  await fixture(async ({ file, handlers, ctx }) => {
    const invalid = Buffer.from('invalid square format');
    fs.writeFileSync(file, invalid);
    assert.equal(await boundedHook(handlers, ctx), undefined);
    assert.deepEqual(fs.readFileSync(file), invalid);
  });
});
