import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

function parent(mode) {
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, 'fixtures/discovery-publication-parent.mjs'), mode], {
    env: process.env, encoding: 'utf8', timeout: 10000,
  });
  const diagnostic = JSON.stringify({ status: result.status, error: result.error?.code ?? null,
    signal: result.signal, stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.error, undefined, diagnostic);
  assert.equal(result.signal, null, diagnostic);
  assert.equal(result.status, 0, diagnostic);
  const report = JSON.parse(result.stdout.trim());
  assert.deepEqual(report.diagnostics.map(({ status, error, signal }) => ({ status, error, signal })),
    [{ status: 0, error: null, signal: null }]);
}

test('seat reattachment publishes discovery before a real parent synchronously expresses through a CLI child', () => {
  parent('open');
});

test('a held discovery index skips publication while parent and CLI child commit to the known artifact', () => {
  parent('held');
});
