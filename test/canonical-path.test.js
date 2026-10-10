import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalPath, canonicalPathSync } from '../dist/canonical-path.js';
import { writeSquareFile } from '../dist/artifact.js';
import { closeOpenSquare } from '../dist/open-square.js';
import { hostLedgerForEnv } from '../dist/registry.js';
import { readWakeRoutes } from './wake-routes.js';
import { openSquare } from '../dist/square-file-adapter.js';
import { join } from '../dist/square-actions.js';

function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-canonical-path-')); return { root, env: { ...process.env, SQUARE_HOST_LEDGER_ROOT: path.join(root, 'user'), CODEX_THREAD_ID: 'codex-session' } }; }
function emptyState() {
  return { hardCap: null, preamble: [], warmup: [], acts: [], routes: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } };
}

test('a missing square under a directory symlink joins and reads as its real path', async () => {
  const item = fixture();
  try {
    const real = path.join(item.root, 'real');
    const link = path.join(item.root, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link, 'dir');
    const throughLink = path.join(link, 'square.square');
    const throughReal = path.join(real, 'square.square');
    const target = path.join(fs.realpathSync.native(real), 'square.square');
    assert.equal(fs.existsSync(throughLink), false, 'the canonicalized square must not exist yet');

    assert.equal(await canonicalPath(throughLink), target);
    assert.equal(canonicalPathSync(throughLink), target);

    await writeSquareFile(throughLink, emptyState());
    const square = await openSquare(throughLink, { env: item.env });
    try { await join(square, 'Alice'); } finally { await closeOpenSquare(square); }

    assert.deepEqual(
      (await hostLedgerForEnv(item.env).listPresence({ location: throughReal, participant: 'Alice' })).map((binding) => [binding.location, binding.session]),
      [[target, 'codex-session']],
      'presence written through the symlinked path is found through the real path',
    );
    assert.deepEqual(
      (await readWakeRoutes({ location: throughReal, env: item.env })).map((route) => [route.location, route.participant, route.sessionId]),
      [[target, 'Alice', 'codex-session']],
      'the joined route is found through the real path',
    );
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});
