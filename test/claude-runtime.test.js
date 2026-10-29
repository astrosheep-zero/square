import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Opt-in real macOS runtime + dummy-key loopback API; never user config/account.
// Default npm test only proves these fixtures are packaged without running Claude.
const repo = path.resolve(import.meta.dirname, '..');
const enabled = process.env.SQUARE_CLAUDE_LIVE_TEST === '1';
const base = process.env.SQUARE_CLAUDE_LIVE_EVIDENCE || path.join(os.tmpdir(), 'square-claude-live-evidence');
const binary = process.env.SQUARE_CLAUDE_BIN || '/opt/homebrew/bin/claude';

test('shipped Claude mod real runtime scheduling and lifecycle', { skip: !enabled, timeout: 240000 }, () => {
  assert.equal(process.platform, 'darwin');
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(version.status, 0, version.stderr);
  fs.mkdirSync(base, { recursive: true });
  const modes = (process.env.SQUARE_CLAUDE_LIVE_MODES || 'idle,busy,hold,lifecycle,fork,cancel').split(',');
  for (const mode of modes) {
    assert.ok(['idle', 'busy', 'hold', 'lifecycle', 'fork', 'cancel'].includes(mode));
    const run = spawnSync('python3', ['-B', path.join(repo, 'test/fixtures/claude-native-runtime.py'), mode, repo, base, binary], { encoding: 'utf8', timeout: 55000 });
    fs.writeFileSync(path.join(base, `${mode}-controller.log`), (run.stdout ?? '') + (run.stderr ?? ''));
    assert.equal(run.status, 0, `${mode}: ${run.stderr} ${run.stdout}`);
    const dir = path.join(base, mode);
    const summary = JSON.parse(fs.readFileSync(path.join(dir, 'live-summary.json'), 'utf8'));
    const rows = JSON.parse(fs.readFileSync(path.join(dir, 'square-evidence.json'), 'utf8'));
    const records = fs.readFileSync(path.join(dir, 'bridge.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map(({ input, stdout }) => {
      const out = stdout ? JSON.parse(stdout) : {};
      return { kind: input.operation, id: input.sessionId, out, bindings: out.bindings };
    });
    const requests = JSON.parse(fs.readFileSync(path.join(dir, 'api.json'), 'utf8'));
    const bodyRequests = requests.filter((request) => JSON.stringify(request.data.messages).includes('Notification BODY: shipped Square native probe.'));
    assert.ok(summary.sent_native && bodyRequests.length, mode);
    for (const name of ['hooks/register.js', 'hooks/hooks.json', 'types.d.ts', '.mcp.json', '.claude-plugin/plugin.json']) assert.equal(fs.readFileSync(path.join(dir, 'plugin', name), 'utf8'), fs.readFileSync(path.join(repo, 'plugins', 'claude', name), 'utf8'));
    if (mode === 'busy') assert.ok(bodyRequests.some((request) => JSON.stringify(request.data.messages).includes('tool_result')));
    if (mode === 'hold') {
      assert.ok(summary.actions.includes('while held no queued/stored callback: True'));
      assert.equal(records.filter((row) => row.kind === 'admitted').length, 0);
    }
    if (mode === 'lifecycle') {
      const original = records.find((row) => row.kind === 'start');
      const resumed = records.findLast((row) => row.kind === 'start' && row.id === original.id);
      const firstBinding = records.find(row => row.id === original.id && row.bindings?.length)?.bindings[0];
      assert.ok(firstBinding);
      assert.equal(resumed.bindings[0].generation, firstBinding.generation, 'resume preserves the standing join generation');
      assert.equal(rows.seats.find(seat => seat.participant === 'fixture-receiver').generation, firstBinding.generation);
      assert.ok(summary.actions.includes('resumed receiver stored NEW Square activity'));
    }
    if (mode === 'fork') assert.ok(summary.actions.some((action) => action.startsWith('forked ')));
    if (mode === 'cancel') {
      const owner = rows.seats.find(seat => seat.participant === 'fixture-receiver');
      assert.equal(owner.cancelledThrough, 2);
      assert.equal(rows.state.runtime.observations[owner.participant]?.['act/2'], undefined);
      assert.equal(rows.evidence.some((row) => row.kind === 'presentation' && row.activity === 'act/2'), false);
      assert.equal(rows.state.runtime.observations[owner.participant]['act/3'].state, 'seen');
      assert.ok(summary.actions.includes('recognized cancelled frame consumed before queue'));
    } else assert.ok(rows.evidence.some((row) => row.kind === 'presentation' && row.outcome === 'presented'));
    console.log(`${mode}: native body/context/evidence assertions passed — ${dir}`);
  }
});
