import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { harnessTargets } from '../dist/harness.js';
import { SQUARE_IDENTITY } from '../dist/identity.js';

const root = path.join(import.meta.dirname, '..');

test('generated release artifacts expose the current identity and supported hosts', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const claudePlugin = JSON.parse(fs.readFileSync(path.join(root, 'skills', 'square', '.claude-plugin', 'plugin.json'), 'utf8'));
  const codexPlugin = JSON.parse(fs.readFileSync(path.join(root, 'codex-plugin', '.codex-plugin', 'plugin.json'), 'utf8'));
  const squareSkill = fs.readFileSync(path.join(root, 'skills', 'square', 'SKILL.md'), 'utf8');

  assert.equal(packageJson.name, '@astrosheep/square');
  assert.equal(SQUARE_IDENTITY.packageName, packageJson.name);
  assert.equal(SQUARE_IDENTITY.packageVersion, packageJson.version);
  assert.equal(claudePlugin.version, packageJson.version);
  assert.equal(codexPlugin.version, packageJson.version);
  assert.match(squareSkill, /history.*only way to look back/i);
  assert.match(squareSkill, /Never read or parse the Square Markdown artifact directly/);
  assert.match(squareSkill, /history --all --full/);
  assert.match(codexPlugin.interface.defaultPrompt, /join.*catch.*express.*done/i);
  assert.doesNotMatch(JSON.stringify(codexPlugin.interface), /\bstream\b/i);
  assert.deepEqual(
    harnessTargets().map(({ name, capabilities }) => [name, capabilities]),
    [
      ['skills', ['install', 'uninstall', 'doctor']],
      ['claude', ['install', 'uninstall', 'doctor']],
      ['codex', ['install', 'uninstall', 'doctor']],
      ['opencode', ['install', 'uninstall', 'doctor']],
      ['pi', ['install', 'uninstall', 'doctor']],
      ['delivery', ['doctor']],
    ]
  );
});
