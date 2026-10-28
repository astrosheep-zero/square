import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Square, squareLocation } from '../dist/square-api.js';
import { localSquareLocation, parseSquareLocation } from '../dist/square-location.js';
import { run } from './square-cli-helpers.js';

test('Windows drive paths are local, not URI schemes', () => {
  // Drive-relative forms are paths too; path.resolve handles the drive's cwd on Windows.
  for (const location of ['D:\\work\\conversation.square', 'D:/work/conversation.square', 'D:conversation.square', 'D:']) {
    assert.deepEqual(parseSquareLocation(location), { kind: 'local', path: location });
  }
  assert.deepEqual(parseSquareLocation('stdio://local/conversation'), {
    kind: 'stdio', backend: 'local', key: 'conversation', uri: 'stdio://local/conversation',
  });
  assert.throws(() => parseSquareLocation('https://example.com/conversation'), error => error.code === 'invalid_args');
});

test('a relative local location stays local after resolving and reopening through SDK and CLI', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-local-location-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const relative = './conversation.square';
  const absolute = path.resolve(cwd, relative);
  // On Windows this second parse sees an absolute drive path even when the caller used ./.
  assert.equal(squareLocation({ cwd, path: relative }), absolute);
  assert.deepEqual(parseSquareLocation(absolute), { kind: 'local', path: absolute });
  assert.equal(localSquareLocation({ cwd, path: relative }), absolute);
  const created = await Square.build({ cwd, path: relative, markdown: 'A local conversation' });
  await created.close();
  const reopened = await Square.at({ cwd, path: absolute });
  try {
    assert.equal(reopened.location, absolute);
    assert.deepEqual((await reopened.history()).activities, []);
  } finally { await reopened.close(); }
  for (const location of [relative, absolute]) {
    const result = run(['--location', location, 'history'], { cwd, env: { SQUARE_INDEX: path.join(cwd, 'index.ndjsonl') } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});
