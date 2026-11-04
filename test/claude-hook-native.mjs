import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

assert.equal(process.env.SQUARE_CLAUDE_HOOK_NATIVE_SMOKE, '1', 'Set SQUARE_CLAUDE_HOOK_NATIVE_SMOKE=1 for isolated real-runtime validation.');
assert.equal(process.platform, 'darwin', 'Native hook evidence is currently limited to macOS.');
const root = path.resolve(import.meta.dirname, '..');
const binary = process.env.SQUARE_CLAUDE_BIN || '/Users/astrosheep/.local/bin/claude';
const evidence = process.env.SQUARE_CLAUDE_HOOK_NATIVE_EVIDENCE
  || `/tmp/square-claude-hook-native-${Date.now()}`;
fs.mkdirSync(evidence, { recursive: true });
const result = spawnSync('python3', ['-B', path.join(root, 'test/fixtures/claude-hook-native-runtime.py'),
  root, evidence, binary, process.execPath], { encoding: 'utf8', timeout: 270_000 });
fs.writeFileSync(path.join(evidence, 'controller.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`);
assert.equal(result.status, 0, `Claude native hook scenario failed; evidence: ${evidence}\n${result.stderr}\n${result.stdout}`);
const scenario = JSON.parse(fs.readFileSync(path.join(evidence, 'idle-rewake', 'summary.json'), 'utf8'));
assert.equal(scenario.idleNoticesWokeWithoutHumanInput, 2);
assert.equal(scenario.secondGeneratedStopHadStopHookActive, true);
assert.equal(scenario.activeBoundaryContext, true);
assert.equal(scenario.busyEscapeFencedOldWatcher, true);
assert.equal(scenario.nativeFrameReceiptObserved, true);
assert.equal(scenario.attachmentRotationFenced, true);
assert.equal(scenario.duplicateStopSuppressed, true);
console.log(`Claude ${scenario.runtime}: native idle rearm, boundary context and prompt/lifecycle fencing passed. Evidence: ${evidence}`);
const mcp = spawnSync(process.execPath, ['--import', './test/sandbox-env.js', '--test', 'test/claude-mcp-runtime.test.js'], {
  cwd: root, encoding: 'utf8', timeout: 100_000, env: process.env,
});
fs.writeFileSync(path.join(evidence, 'mcp-controller.log'), `${mcp.stdout ?? ''}${mcp.stderr ?? ''}`);
assert.equal(mcp.status, 0, `Native MCP hook validation failed; evidence: ${evidence}\n${mcp.stdout}\n${mcp.stderr}`);
process.stdout.write(mcp.stdout);
