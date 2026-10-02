import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeTargetBatch } from '../dist/cli/harness-command.js';
import { doctorPiPackage, piPackageRoot } from '../dist/harness-pi.js';
import { SQUARE_IDENTITY } from '../dist/identity.js';
import { run, withPath } from './square-cli-helpers.js';

function doctorFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-harness-doctor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ledger = path.join(home, 'host-ledger');
  return {
    home,
    env: {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: path.join(home, '.codex'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      SQUARE_HOST_LEDGER_ROOT: ledger,
      SQUARE_LOCATION: '',
      SQUARE_PARTICIPANT_NAME: '',
      SQUARE_REGISTRY: path.join(ledger, 'sessions.ndjsonl'),
      SQUARE_PRESENTED: path.join(ledger, 'presented.ndjsonl'),
      SQUARE_CLAUDE_BIN: path.join(home, 'missing-claude'),
      SQUARE_CODEX_BIN: path.join(home, 'missing-codex'),
      SQUARE_OPENCODE_BIN: path.join(home, 'missing-opencode'),
      SQUARE_OPENCODE_BIN_ARGS: '[]',
      SQUARE_PI_BIN: path.join(home, 'missing-pi'),
    },
  };
}

function installedPiPackage(home) {
  const root = piPackageRoot(home);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    version: SQUARE_IDENTITY.packageVersion,
    pi: { extensions: ['./extensions/square-pi.js'] },
  }));
  return root;
}

test('Pi doctor keeps list failures distinct from unconfigured packages and still checks installed files', (t) => {
  const { home } = doctorFixture(t);
  const root = installedPiPackage(home);
  for (const listed of [
    { status: 1, stdout: SQUARE_IDENTITY.packageName, stderr: 'cannot inspect packages' },
    { status: 2, stdout: 'cannot inspect packages', stderr: '' },
    { status: 3, stdout: '', stderr: '' },
  ]) {
    const lines = doctorPiPackage(home, () => listed);
    assert.equal(lines[0], `✕ Pi package list failed: ${listed.stderr || listed.stdout || 'exit 3'}`);
    assert.deepEqual(lines.slice(1), [
      `✓ Pi package ${SQUARE_IDENTITY.packageVersion} installed at ${root}`,
      '✓ Pi Square extension declared',
    ]);
    assert.doesNotMatch(lines.join('\n'), /(?:not )?configured/);
  }
  assert.equal(
    doctorPiPackage(home, () => ({ status: 0, stdout: '', stderr: '' }))[0],
    `○ Pi package ${SQUARE_IDENTITY.packageName} not configured`,
  );
});

test('Pi doctor bounds unavailable and failed command diagnostics without losing their category', (t) => {
  const { home } = doctorFixture(t);
  const diagnostic = '界'.repeat(200);
  const clipped = `${'界'.repeat(159)}…`;
  for (const error of [new Error(diagnostic), diagnostic]) {
    const lines = doctorPiPackage(home, () => { throw error; });
    assert.equal(lines[0], `○ Pi runtime unavailable (${clipped})`);
    assert.match(lines[1], /Pi package .* missing at/);
    assert.equal(lines[2], '○ Pi Square extension not declared');
  }
  for (const result of [
    { status: 1, stdout: '', stderr: diagnostic },
    { status: 1, stdout: diagnostic, stderr: '' },
  ]) {
    assert.equal(doctorPiPackage(home, () => result)[0], `✕ Pi package list failed: ${clipped}`);
  }
});

test('aggregate doctor isolates unexpected target errors and continues every independent check', async () => {
  const attempted = [];
  const result = await executeTargetBatch(['claude', 'codex', 'opencode', 'pi', 'delivery'], 'doctor', {
    homeDir: '/unused', force: false,
  }, async (target, action) => {
    attempted.push(target);
    assert.equal(action, 'doctor');
    if (target === 'claude') throw new Error('x'.repeat(200));
    if (target === 'pi') throw new Error('unavailable');
    return { lines: [`${target} checked`], notes: [] };
  });
  assert.deepEqual(attempted, ['claude', 'codex', 'opencode', 'pi', 'delivery']);
  assert.deepEqual(result.lines, ['codex checked', 'opencode checked', 'delivery checked']);
  assert.deepEqual(result.failures, [
    `✕ claude doctor failed: ${'x'.repeat(159)}…`,
    '✕ pi doctor failed: unavailable',
  ]);
});

test('actual aggregate doctor reports absent host commands and still inspects delivery health', (t) => {
  const fixture = doctorFixture(t);
  const squarePath = path.join(fixture.home, 'SQUARE.square');
  const options = { cwd: fixture.home, env: fixture.env };
  const built = run(withPath(squarePath, ['build']), { ...options, input: 'Doctor regression\n' });
  assert.equal(built.status, 0, built.stderr);

  const result = run(withPath(squarePath, ['harness', 'doctor']), options);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /○ Claude doctor unavailable/);
  assert.match(result.stdout, /○ Codex doctor unavailable/);
  assert.match(result.stdout, /○ OpenCode runtime unavailable/);
  assert.match(result.stdout, /○ Pi runtime unavailable/);
  assert.match(result.stdout, /✓ no pending delivery attention/);
  assert.doesNotMatch(result.stdout, /Pi package .* configured/);
});

test('actual targeted Pi doctor reports unavailable without claiming an unconfigured package', (t) => {
  const fixture = doctorFixture(t);
  installedPiPackage(fixture.home);
  const result = run(['harness', 'doctor', 'pi'], { cwd: fixture.home, env: fixture.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /○ Pi runtime unavailable/);
  assert.match(result.stdout, /✓ Pi package .* installed at/);
  assert.match(result.stdout, /✓ Pi Square extension declared/);
  assert.doesNotMatch(result.stdout, /configured|Claude|Codex|OpenCode|delivery/);
});

test('actual targeted Pi doctor reports a failed list command truthfully', (t) => {
  const fixture = doctorFixture(t);
  // Pi passes `list` to this Node fixture; no installed host executable is used.
  fs.writeFileSync(path.join(fixture.home, 'list'), 'process.stderr.write("fixture list failed"); process.exit(7);');
  const result = run(['harness', 'doctor', 'pi'], {
    cwd: fixture.home,
    env: { ...fixture.env, SQUARE_PI_BIN: process.execPath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /✕ Pi package list failed: fixture list failed/);
  assert.doesNotMatch(result.stdout, /configured|Claude|Codex|OpenCode|delivery/);
});

test('actual aggregate doctor retains host findings when delivery inspection fails', (t) => {
  const fixture = doctorFixture(t);
  const squarePath = path.join(fixture.home, 'invalid.square');
  fs.writeFileSync(squarePath, 'not a square artifact');
  const result = run(withPath(squarePath, ['harness', 'doctor']), { cwd: fixture.home, env: fixture.env });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /○ Pi runtime unavailable/);
  assert.match(result.stdout, /✕ delivery doctor failed:/);
  assert.doesNotMatch(result.stdout, /no pending delivery attention/);
});
