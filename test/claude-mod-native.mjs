import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.env.SQUARE_CLAUDE_MOD_NATIVE_SMOKE !== '1') {
  console.log('Set SQUARE_CLAUDE_MOD_NATIVE_SMOKE=1 to run isolated real-Claude mod verification.');
  process.exit(0);
}
assert.equal(process.platform, 'darwin', 'The native fixtures are validated on macOS only');
const repo = path.resolve(import.meta.dirname, '..');
const binary = process.env.SQUARE_CLAUDE_BIN || '/Users/astrosheep/.local/bin/claude';
const root = fs.realpathSync(fs.mkdtempSync('/tmp/square-claude-mod-native-'));
console.log(`Claude mod delivery evidence: ${root}`);
const run = spawnSync('python3', ['-B', path.join(repo, 'test/fixtures/claude-mod-runtime.py'), repo, root, binary, process.execPath], {
  encoding: 'utf8', timeout: 90_000,
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'LOGNAME'].includes(key))),
});
fs.writeFileSync(path.join(root, 'controller.log'), `${run.stdout ?? ''}${run.stderr ?? ''}`);
assert.equal(run.status, 0, `Native delivery failed: ${root}\n${run.error ?? ''}\n${run.stderr}\n${run.stdout}`);
const summary = JSON.parse(fs.readFileSync(path.join(root, 'summary.json'), 'utf8'));
assert.equal(summary.idleWakes, 2);
for (const field of ['duplicateSuppressed', 'busyAppendedWithinTurn', 'busyUiLogEmitted', 'stopDidNotWakeOrAppend', 'exactReceipts', 'detachedOnExit', 'expectedInterrupt'])
  assert.equal(summary[field], true, field);
const mcp = spawnSync(process.execPath, ['--import', './test/sandbox-env.js', '--test', 'test/claude-mcp-runtime.test.js'], {
  cwd: repo, env: { ...process.env, SQUARE_CLAUDE_BIN: binary }, stdio: 'inherit', timeout: 100_000,
});
assert.equal(mcp.status, 0, 'Native main/child MCP verification failed');
console.log('Claude mod delivery and main/child MCP verification passed.');
