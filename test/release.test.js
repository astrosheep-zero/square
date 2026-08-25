import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { harnessTargets } from '../dist/harness.js';
import { SQUARE_IDENTITY } from '../dist/identity.js';

const root = path.join(import.meta.dirname, '..');

test('generated release artifacts expose the current identity and supported hosts', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const claudePlugin = JSON.parse(fs.readFileSync(path.join(root, 'claude-plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
  const claudeHooks = JSON.parse(fs.readFileSync(path.join(root, 'claude-plugin', 'hooks', 'hooks.json'), 'utf8'));
  const codexPlugin = JSON.parse(fs.readFileSync(path.join(root, 'codex-plugin', '.codex-plugin', 'plugin.json'), 'utf8'));
  const squareSkill = fs.readFileSync(path.join(root, 'skills', 'square', 'SKILL.md'), 'utf8');
  const claudeSkill = fs.readFileSync(path.join(root, 'claude-plugin', 'skills', 'square', 'SKILL.md'), 'utf8');

  assert.equal(packageJson.name, '@astrosheep/square');
  assert.equal(packageJson.dependencies['@getpaseo/client'], undefined);
  assert.equal(packageJson.dependencies.ws, undefined);
  assert.deepEqual(packageJson.exports['./paseo'], {
    types: './dist/paseo.d.ts',
    default: './dist/paseo.js',
  });
  assert.equal(packageJson.peerDependenciesMeta['@getpaseo/client'].optional, true);
  assert.equal(packageJson.peerDependenciesMeta.ws.optional, true);
  assert.equal(SQUARE_IDENTITY.packageName, packageJson.name);
  assert.equal(SQUARE_IDENTITY.packageVersion, packageJson.version);
  assert.equal(packageJson.files.includes('claude-plugin'), true);
  assert.equal(claudePlugin.version, packageJson.version);
  assert.equal(codexPlugin.version, packageJson.version);
  assert.equal(fs.existsSync(path.join(root, 'skills', 'square', '.claude-plugin')), false);
  assert.equal(fs.existsSync(path.join(root, 'skills', 'square', 'hooks')), false);
  assert.deepEqual(Object.keys(claudeHooks.hooks), ['SessionStart', 'SessionResume', 'SessionEnd', 'PostToolBatch']);
  for (const event of Object.keys(claudeHooks.hooks)) {
    assert.equal(claudeHooks.hooks[event][0].hooks[0].command, 'square claude-hook');
  }
  assert.equal(claudeSkill, squareSkill);
  assert.match(squareSkill, /history.*only way to look back/i);
  assert.match(squareSkill, /Never read or parse the binary Square artifact directly/);
  assert.match(squareSkill, /history --all --full/);
  assert.match(codexPlugin.interface.defaultPrompt, /join.*catch.*express.*done/i);
  assert.doesNotMatch(JSON.stringify(codexPlugin.interface), /\bstream\b/i);
  assert.deepEqual(
    harnessTargets().map(({ name, capabilities }) => [name, capabilities]),
    [
      ['claude', ['install', 'uninstall', 'doctor']],
      ['codex', ['install', 'uninstall', 'doctor']],
      ['opencode', ['install', 'uninstall', 'doctor']],
      ['pi', ['install', 'uninstall', 'doctor']],
      ['delivery', ['doctor']],
    ]
  );
});
