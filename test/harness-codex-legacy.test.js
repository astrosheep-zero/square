import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CODEX_PLUGIN_ID,
  codexMarketplaceRoot,
  installCodexPlugin,
  uninstallCodexPlugin,
} from '../dist/harness-codex.js';

test('Codex lifecycle retires only the legacy Square identity', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-codex-hidden-legacy-'));
  const previousCodexHome = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  const config = path.join(home, '.codex', 'config.toml');
  const marketplace = codexMarketplaceRoot(home);
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, [
    '[marketplaces.astrosheep-square]',
    `source = ${JSON.stringify(marketplace)}`,
    '',
    '[marketplaces.astrosheep]',
    `source = ${JSON.stringify(marketplace)}`,
    '',
    '[plugins."square@astrosheep-square"]',
    'enabled = true',
    '',
    '[plugins."square@astrosheep"]',
    'enabled = true',
    '',
    '[plugins."unrelated@personal"]',
    'enabled = true',
    '',
  ].join('\n'));

  const plugins = new Set(['square@astrosheep-square', 'square@astrosheep', 'unrelated@personal']);
  const marketplaceNames = new Set(['astrosheep-square', 'astrosheep']);
  const run = (_home, args) => {
    if (args[0] === 'plugin' && args[1] === 'add') {
      plugins.add(args[2]);
      return { status: 0, stdout: JSON.stringify({ installedPath: '/tmp/current-square' }), stderr: '' };
    }
    if (args[0] === 'plugin' && args[1] === 'remove') plugins.delete(args[2]);
    if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') marketplaceNames.delete(args[3]);
    return { status: 0, stdout: '{}', stderr: '' };
  };

  try {
    const result = await installCodexPlugin(home, run);
    assert.equal(plugins.has('square@astrosheep-square'), false);
    assert.equal(marketplaceNames.has('astrosheep-square'), false);
    assert.equal(plugins.has('square@astrosheep'), true);
    assert.equal(plugins.has('unrelated@personal'), true);
    assert.ok(result.notes.some((note) => note.includes('square@astrosheep-square')));
    assert.match(fs.readFileSync(config, 'utf8'), /^hooks = true$/m);

    await uninstallCodexPlugin(home, run);
    assert.equal(plugins.has('square@astrosheep'), false);
    assert.equal(marketplaceNames.has('astrosheep'), false);
    assert.equal(plugins.has('unrelated@personal'), true);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
