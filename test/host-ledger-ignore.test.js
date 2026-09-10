import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileHostLedgerPort } from '../dist/host-ledger-file-adapter.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-ledger-ignore-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const localPath = path.join(root, '.square', 'host-ledger');
  const userPath = path.join(root, 'user-ledger');
  const port = new FileHostLedgerPort({ localPath, userPath });
  const record = { location: path.join(root, 'test.square'), participant: 'rei', session: 'test', channel: 'pi' };
  return { root, localPath, userPath, port, record };
}

test('first presence claim ignores local and user ledger data, including locks', async (t) => {
  const { root, localPath, userPath, port, record } = await fixture(t);
  assert.equal((await port.claimPresence(record)).status, 'acquired');
  for (const directory of [localPath, userPath]) {
    assert.equal(await fs.readFile(path.join(directory, '.gitignore'), 'utf8'), '*\n');
    for (const name of await fs.readdir(directory)) {
      execFileSync('git', ['check-ignore', '-q', path.join(directory, name)], { cwd: root });
    }
  }
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }), '');
  await assert.rejects(fs.stat(path.join(root, '.gitignore')), { code: 'ENOENT' });
});

test('existing ledger directories gain an ignore file; existing ignore files stay untouched', async (t) => {
  const { localPath, port, record } = await fixture(t);
  await fs.mkdir(localPath, { recursive: true });
  await fs.writeFile(path.join(localPath, 'presence.ndjsonl'), '');
  assert.equal((await port.ensurePresence(record)).status, 'ensured');
  const ignore = path.join(localPath, '.gitignore');
  assert.equal(await fs.readFile(ignore, 'utf8'), '*\n');
  await fs.writeFile(ignore, '# user-owned\n*.ndjsonl\n');
  assert.equal((await port.ensurePresence(record)).status, 'ensured');
  assert.equal(await fs.readFile(ignore, 'utf8'), '# user-owned\n*.ndjsonl\n');
});

test('read-only ledger access does not create directories', async (t) => {
  const { localPath, userPath, port } = await fixture(t);
  assert.deepEqual(await port.listPresence(), []);
  for (const directory of [localPath, userPath]) {
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  }
});
