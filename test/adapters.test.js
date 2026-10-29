import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'jsonc-parser';
import { visibleWidth } from '@earendil-works/pi-tui';
import { DatabaseSync } from 'node:sqlite';

import installedSquarePiExtension, {
  inboxKeys,
  pendingCardDetails,
  pendingInbox,
  renderPiInbox,
  renderSquareCard,
} from '../plugins/pi/square-pi.js';
import { createArtifactPort, readSquareSnapshot } from '../dist/artifact.js';
import { SQUARE_IDENTITY } from '../dist/identity.js';
import {
  CLAUDE_PLUGIN_ID,
  doctorClaudePlugin,
  installClaudePlugin,
  uninstallClaudePlugin,
} from '../dist/harness-claude.js';
import {
  CODEX_PLUGIN_ID,
  codexMarketplaceRoot,
  doctorCodexPlugin,
  installCodexPlugin,
  uninstallCodexPlugin,
} from '../dist/harness-codex.js';
import {
  doctorPiPackage,
  installPiPackage,
  piPackageRoot,
  piPackageSource,
  uninstallPiPackage,
} from '../dist/harness-pi.js';
import { withFileLock } from '../dist/file-lock.js';
import { hasPresentedForOwner } from './presentation-fixtures.js';
import { formatActivityId } from '../dist/square-core.js';
import { Square } from '../dist/square-api.js';
import { executeHarnessTarget } from '../dist/harness.js';
import { executeTargetBatch } from '../dist/cli/harness-command.js';
import {
  installOpenCodePlugin,
  uninstallOpenCodePlugin,
  verifyOpenCodeRuntime,
} from '../dist/harness-links.js';

// Pi allows several handlers per event, including the optional generic receiver.
function squarePiExtension(pi) {
  const on = pi.on.bind(pi);
  const registrations = new Map();
  return installedSquarePiExtension({
    ...pi,
    registerTool() {},
    registerFlag() {},
    getFlag() { return undefined; },
    on(event, handler) {
      const handlers = registrations.get(event) ?? [];
      handlers.push(handler);
      registrations.set(event, handlers);
      on(event, async (...args) => { for (const callback of handlers) await callback(...args); });
    },
  });
}

function sampleInbox() {
  return [{
    location: '/tmp/SQUARE.square',
    seat: { participant: 'Bob', owner: ':', generation: 'act/0' },
    joinedAt: 1,
    notifications: [{ actIndex: 7, actor: 'Alice', at: 8, route: 'mention', body: 'hello @Bob' }],
  }];
}

function enabledPlugins(pluginId) { return JSON.stringify({ installed: [{ pluginId, installed: true, enabled: true }] }); }
function enabledClaudePlugins(pluginId) { return JSON.stringify([{ id: pluginId, version: SQUARE_IDENTITY.packageVersion, enabled: true, installPath: '/tmp/plugin' }]); }
function clippedDiagnostic(value) { return `${[...value].slice(0, 159).join('')}…`; }

function openCodeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-opencode-'));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(home, 'config');
  const config = path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  fs.mkdirSync(config, { recursive: true });
  t.after(() => {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, config };
}

test('multi-target installation continues after an independent target fails', async () => {
  const attempted = [];
  const result = await executeTargetBatch(['claude', 'codex'], 'install', {
    homeDir: '/tmp/home',
    force: false,
  }, async (target) => {
    attempted.push(target);
    if (target === 'claude') throw new Error('unavailable');
    return { lines: ['codex installed'], notes: [] };
  });

  assert.deepEqual(attempted, ['claude', 'codex']);
  assert.deepEqual(result.lines, ['codex installed']);
  assert.deepEqual(result.failures, ['✕ claude install failed: unavailable']);
});

test('Square identity keeps package, plugin, and marketplace coordinates aligned', () => {
  assert.deepEqual(
    {
      packageName: SQUARE_IDENTITY.packageName,
      pluginId: SQUARE_IDENTITY.pluginId,
      marketplaceName: SQUARE_IDENTITY.marketplaceName,
    },
    {
      packageName: '@astrosheep/square',
      pluginId: 'square@astrosheep',
      marketplaceName: 'astrosheep',
    }
  );
  assert.equal(SQUARE_IDENTITY.packageVersion, JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).version);
});

test('OpenCode doctor reads current config sources without claiming runtime loading', () => {
  const home = '/tmp/square-opencode';
  for (const entry of ['@astrosheep/square', { package: '@astrosheep/square@0.3.92', options: {} }]) {
    const configured = verifyOpenCodeRuntime(home, (_home, args) => {
      assert.equal(_home, home);
      assert.deepEqual(args, ['debug', 'config']);
      return { status: 0, stdout: JSON.stringify([
        { type: 'document', path: '/config/opencode.jsonc', info: { plugins: [entry] } },
        { type: 'directory', path: '/config' },
      ]), stderr: '' };
    });
    assert.equal(configured, '✓ OpenCode npm plugin configured (runtime loading not verified)');
  }
  assert.match(
    verifyOpenCodeRuntime(home, () => ({ status: 0, stdout: JSON.stringify([
      { type: 'document', info: { plugins: ['@astrosheep/square-other'] } }, { type: 'directory' },
    ]), stderr: '' })),
    /npm plugin not configured/
  );
  for (const stdout of ['not JSON', JSON.stringify({ config: { plugin: ['@astrosheep/square'] } }), 'null']) {
    assert.match(verifyOpenCodeRuntime(home, () => ({ status: 0, stdout, stderr: '' })), /^✕ OpenCode debug config returned/);
  }
  assert.match(
    verifyOpenCodeRuntime(home, () => ({ status: 1, stdout: '', stderr: 'extension failed' })),
    /OpenCode debug config failed: extension failed/
  );
});

test('harness doctor bounds external diagnostics without changing its category', async () => {
  const previous = process.env.SQUARE_CLAUDE_BIN;
  const missingCommand = `square-missing-${'x'.repeat(240)}`;
  process.env.SQUARE_CLAUDE_BIN = missingCommand;
  try {
    const result = await executeHarnessTarget('claude', 'doctor', { homeDir: os.tmpdir(), force: false });
    const prefix = '○ Claude doctor unavailable (';
    const diagnostic = result.lines[0].slice(prefix.length, -1);
    assert.match(result.lines[0], /^○ Claude doctor unavailable \(/);
    assert.equal([...diagnostic].length, 160);
    assert.match(diagnostic, /…$/);
  } finally {
    if (previous === undefined) delete process.env.SQUARE_CLAUDE_BIN;
    else process.env.SQUARE_CLAUDE_BIN = previous;
  }
});

test('OpenCode runtime doctor bounds stderr, stdout, and thrown diagnostics', () => {
  const diagnostic = '界'.repeat(200);
  const clipped = clippedDiagnostic(diagnostic);
  assert.equal(
    verifyOpenCodeRuntime('/tmp/square-opencode', () => ({ status: 1, stdout: '', stderr: diagnostic })),
    `✕ OpenCode debug config failed: ${clipped}`
  );
  assert.equal(
    verifyOpenCodeRuntime('/tmp/square-opencode', () => ({ status: 1, stdout: diagnostic, stderr: '' })),
    `✕ OpenCode debug config failed: ${clipped}`
  );
  assert.equal(
    verifyOpenCodeRuntime('/tmp/square-opencode', () => { throw new Error(diagnostic); }),
    `○ OpenCode runtime unavailable (${clipped})`
  );
});

test('OpenCode installation adds globally once and updates even a cached fresh install', (t) => {
  const { home, config } = openCodeHome(t);
  const target = path.join(config, 'opencode.json');
  const source = '{ // header\n "plugins": [ // keep plugin comment\n "other", // keep trailing\n ], "model":"provider/model",\n}\n';
  fs.writeFileSync(target, source);
  const calls = [];
  const run = (_home, args) => {
    assert.equal(_home, home);
    calls.push(args);
    // Native add sees its exact entry and does not rewrite the entire array.
    assert.deepEqual(parse(fs.readFileSync(target, 'utf8')).plugins, ['other', '@astrosheep/square']);
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.deepEqual(installOpenCodePlugin(home, true, run), ['@astrosheep/square']);
  const installed = fs.readFileSync(target, 'utf8');
  installOpenCodePlugin(home, false, run);
  assert.deepEqual(calls, [
    ['plugin', 'add', '@astrosheep/square'], ['plugin', 'update', '@astrosheep/square'],
    ['plugin', 'update', '@astrosheep/square'],
  ]);
  assert.deepEqual(parse(installed), { plugins: ['other', '@astrosheep/square'], model: 'provider/model' });
  for (const comment of source.matchAll(/\/\/[^\n]*/g)) assert.ok(installed.includes(comment[0]));
  assert.equal(fs.readFileSync(target, 'utf8'), installed);
});

test('OpenCode installation creates its global config when absent', (t) => {
  const { home, config } = openCodeHome(t);
  const calls = [];
  installOpenCodePlugin(home, false, (_home, args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; });
  assert.deepEqual(calls, [['plugin', 'add', '@astrosheep/square'], ['plugin', 'update', '@astrosheep/square']]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(config, 'opencode.json'), 'utf8')), { plugins: ['@astrosheep/square'] });
});

test('OpenCode install converges legacy duplicates and old pins to one unpinned current entry, retaining options', (t) => {
  const { home, config } = openCodeHome(t);
  const target = path.join(config, 'opencode.jsonc');
  const options = { enabled: true, nested: { a: 1, b: 2 } };
  const source = `{
    // keep header and unrelated legacy entry
    "plugin": ["keiyaku", ["@astrosheep/square@0.3.67", ${JSON.stringify(options)}]],
    "plugins": [
      "@astrosheep/square", // keep inline comment
      // keep next plugin comment
      "other", {"package":"@astrosheep/square@0.3.67", "options":{"nested":{"b":2,"a":1},"enabled":true}}
    ],
    "model": "provider/model",
  }`;
  fs.writeFileSync(target, source);
  const otherTarget = path.join(config, 'opencode.json');
  fs.writeFileSync(otherTarget, '{"plugins":["other-json","@astrosheep/square@0.3.67"],"setting":true}');
  const calls = [];
  const run = (_home, args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; };
  installOpenCodePlugin(home, false, run);
  const installed = fs.readFileSync(target, 'utf8');
  const installedOther = fs.readFileSync(otherTarget, 'utf8');
  assert.deepEqual(parse(installed), { plugin: ['keiyaku'], plugins: ['other'], model: 'provider/model' });
  assert.deepEqual(parse(installedOther), { plugins: ['other-json', { package: '@astrosheep/square', options }], setting: true });
  for (const comment of source.matchAll(/\/\/[^\n]*/g)) assert.ok(installed.includes(comment[0]));
  installOpenCodePlugin(home, true, run);
  assert.deepEqual(calls, [['plugin', 'update', '@astrosheep/square'], ['plugin', 'update', '@astrosheep/square']]);
  assert.equal(fs.readFileSync(target, 'utf8'), installed);
  assert.equal(fs.readFileSync(otherTarget, 'utf8'), installedOther);
});

test('OpenCode install unpins a sole old object or tuple before native add and latest update', (t) => {
  const { home, config } = openCodeHome(t);
  const target = path.join(config, 'opencode.jsonc');
  const options = { enabled: true };
  for (const configuration of [
    { plugins: [{ package: '@astrosheep/square@0.3.67', options }] },
    { plugin: [['@astrosheep/square@0.3.67', options]] },
  ]) {
    fs.writeFileSync(target, JSON.stringify(configuration));
    const calls = [];
    installOpenCodePlugin(home, false, (_home, args) => {
      calls.push(args);
      assert.deepEqual(parse(fs.readFileSync(target, 'utf8')).plugins, [{ package: '@astrosheep/square', options }]);
      return { status: 0, stdout: '', stderr: '' };
    });
    assert.deepEqual(calls, [['plugin', 'add', '@astrosheep/square'], ['plugin', 'update', '@astrosheep/square']]);
    assert.deepEqual(parse(fs.readFileSync(target, 'utf8')).plugin ?? [], []);
  }
});

test('OpenCode install refuses conflicting owned options before changing files or invoking the CLI', (t) => {
  const { home, config } = openCodeHome(t);
  const targets = [path.join(config, 'opencode.json'), path.join(config, 'opencode.jsonc')];
  const sources = [
    '{"plugin":[["@astrosheep/square@0.3.67",{"enabled":true}]],"model":"provider/model"}',
    '{"plugins":[{"package":"@astrosheep/square","options":{"enabled":false}}]}',
  ];
  targets.forEach((target, index) => fs.writeFileSync(target, sources[index]));
  assert.throws(() => installOpenCodePlugin(home, false, () => assert.fail('must not invoke OpenCode')), /Conflicting Square plugin options.*reconcile/);
  targets.forEach((target, index) => assert.equal(fs.readFileSync(target, 'utf8'), sources[index]));
});

test('OpenCode installation propagates native add and update failures', (t) => {
  const { home, config } = openCodeHome(t);
  const target = path.join(config, 'opencode.jsonc');
  for (const failing of ['add', 'update']) {
    const source = JSON.stringify({ plugins: failing === 'update' ? ['@astrosheep/square'] : [] });
    fs.writeFileSync(target, source);
    const run = (_home, args) => ({ status: args[1] === failing ? 1 : 0, stdout: '', stderr: 'external failure' });
    assert.throws(() => installOpenCodePlugin(home, false, run), /OpenCode .* failed: external failure/);
    assert.equal(fs.readFileSync(target, 'utf8'), source);
  }
  fs.rmSync(target);
  assert.throws(() => installOpenCodePlugin(home, false, () => ({ status: 1, stdout: '', stderr: 'offline' })), /offline/);
  assert.equal(fs.existsSync(path.join(config, 'opencode.json')), false);
});

test('OpenCode uninstall removes every owned entry from both global fields and files, retaining comments', (t) => {
  const { home, config } = openCodeHome(t);
  const target = path.join(config, 'opencode.jsonc');
  const source = `{
  // keep header
  "plugin": [
    // keep Keiyaku
    "file:///keiyaku/build/plugins/opencode", // keep trailing comment
    "@astrosheep/square", // comment outside owned value
    // keep the next plugin's comment
    "other-plugin",
    ["@astrosheep/square@0.3.67", {"enabled": true}],
  ],
  "plugins": ["@astrosheep/square", {"package":"other", "options":{"value":"@astrosheep/square"}}, {"package":"@astrosheep/square@0.3.92", "options":{}}, "@astrosheep/square-tools", "@astrosheep/square"],
  "model": "provider/model", // keep setting
  "instructions": ["@astrosheep/square"],
}
// keep footer
`;
  fs.writeFileSync(target, source);
  const jsonTarget = path.join(config, 'opencode.json');
  fs.writeFileSync(jsonTarget, '{"plugins":["@astrosheep/square","other-json"]}');
  assert.deepEqual(uninstallOpenCodePlugin(home), ['@astrosheep/square']);
  const next = fs.readFileSync(target, 'utf8');
  const errors = [];
  assert.deepEqual(parse(next, errors, { allowTrailingComma: true }), {
    plugin: ['file:///keiyaku/build/plugins/opencode', 'other-plugin'],
    plugins: [{ package: 'other', options: { value: '@astrosheep/square' } }, '@astrosheep/square-tools'],
    model: 'provider/model', instructions: ['@astrosheep/square'],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(jsonTarget, 'utf8')), { plugins: ['other-json'] });
  for (const comment of source.matchAll(/\/\/[^\n]*/g)) assert.ok(next.includes(comment[0]), comment[0]);
  assert.ok(next.includes('{"package":"other", "options":{"value":"@astrosheep/square"}}'));
  assert.deepEqual(uninstallOpenCodePlugin(home), []);
  assert.equal(fs.readFileSync(target, 'utf8'), next);
});

test('OpenCode uninstall keeps empty arrays valid and leaves unowned files byte-identical', (t) => {
  const { home, config } = openCodeHome(t);
  const target = path.join(config, 'opencode.jsonc');
  assert.deepEqual(uninstallOpenCodePlugin(home), []);
  for (const source of [
    '{"plugin":["@astrosheep/square"],"plugins":["@astrosheep/square","@astrosheep/square"]}',
    '{"plugin":["@astrosheep/square",],"plugins":["@astrosheep/square",]}',
  ]) {
    fs.writeFileSync(target, source);
    assert.deepEqual(uninstallOpenCodePlugin(home), ['@astrosheep/square']);
    const errors = [];
    assert.deepEqual(parse(fs.readFileSync(target, 'utf8'), errors, { allowTrailingComma: true }), { plugin: [], plugins: [] });
    assert.deepEqual(errors, []);
  }
  const source = '{ // untouched\n "plugins": ["other"], "model": "provider/model",\n}\n';
  fs.writeFileSync(target, source);
  assert.deepEqual(uninstallOpenCodePlugin(home), []);
  assert.equal(fs.readFileSync(target, 'utf8'), source);
});

test('OpenCode lifecycle refuses malformed config without editing any files or invoking the CLI', (t) => {
  const { home, config } = openCodeHome(t);
  const validTarget = path.join(config, 'opencode.json');
  const valid = '{"plugins":["@astrosheep/square"]}';
  fs.writeFileSync(validTarget, valid);
  const invalidTarget = path.join(config, 'opencode.jsonc');
  for (const invalid of ['{', 'null', '[]', '{"plugins":false}', '{"plugin":{}}']) {
    fs.writeFileSync(invalidTarget, invalid);
    assert.throws(() => installOpenCodePlugin(home, false, () => assert.fail('must not invoke OpenCode')), /Invalid OpenCode/);
    assert.throws(() => uninstallOpenCodePlugin(home), /Invalid OpenCode/);
    assert.equal(fs.readFileSync(validTarget, 'utf8'), valid);
    assert.equal(fs.readFileSync(invalidTarget, 'utf8'), invalid);
  }
});

test('Pi package lifecycle uses Pi installation as the single extension owner', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-package-'));
  const calls = [];
  const runPi = (_home, args) => {
    calls.push(args);
    return { status: 0, stdout: args[0] === 'list' ? `  ${SQUARE_IDENTITY.packageName}\n` : '', stderr: '' };
  };
  const root = piPackageRoot(home);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    version: SQUARE_IDENTITY.packageVersion,
    pi: { extensions: ['./plugins/pi/square-pi.js'] },
  }));
  try {
    assert.deepEqual(installPiPackage(home, runPi), [root]);
    assert.deepEqual(doctorPiPackage(home, runPi), [
      `✓ Pi package ${SQUARE_IDENTITY.packageName} configured`,
      `✓ Pi package ${SQUARE_IDENTITY.packageVersion} installed at ${root}`,
      '✓ Pi Square extension declared',
    ]);
    assert.deepEqual(uninstallPiPackage(home, runPi), [root]);
    assert.deepEqual(calls, [
      ['install', piPackageSource()],
      ['list'],
      ['remove', piPackageSource()],
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Pi installation preserves a configured local Square source without adding an npm copy', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-local-'));
  const agentDir = path.join(home, '.pi', 'agent');
  const root = path.join(home, 'Developer', 'square');
  const settingsPath = path.join(agentDir, 'settings.json');
  const source = '../../Developer/square';
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: SQUARE_IDENTITY.packageName, version: SQUARE_IDENTITY.packageVersion,
    pi: { extensions: ['./plugins/pi/square-pi.js'] },
  }));
  const calls = [];
  const run = (_home, args) => {
    calls.push(args);
    return { status: 0, stdout: source, stderr: '' };
  };
  try {
    for (const entry of [source, { source, skills: [] }]) {
      const settings = JSON.stringify({ packages: ['npm:unrelated', entry], defaultTools: ['read'] });
      fs.writeFileSync(settingsPath, settings);
      calls.length = 0;
      assert.deepEqual(installPiPackage(home, run), [root]);
      assert.deepEqual(calls, [], 'a local source must not invoke pi install');
      assert.equal(fs.readFileSync(settingsPath, 'utf8'), settings);
      assert.ok(doctorPiPackage(home, run).some((line) => line.includes(root)));
      assert.deepEqual(calls, [['list']]);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('package facade participant verbs persist through shared actions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-actions-api-'));
  const squarePath = path.join(dir, 'SQUARE.square');
  const body = "pi" + ":" + ('alice-session');
  const square = await Square.build({ path: squarePath, markdown: 'warmup' });
  const previousDisableWake = process.env.SQUARE_DISABLE_PASEO_WAKE;
  process.env.SQUARE_DISABLE_PASEO_WAKE = '1';
  try {
    const alice = (await square.join('Alice', { owner: body })).participant;
    await alice.express('one @Alice', { force: true, mentions: ['Alice'] });
    await alice.done();
    await square.close();
    const persisted = (await readSquareSnapshot(squarePath)).state;
    assert.deepEqual(persisted.acts.map((item) => item.kind), ['join', 'say', 'done']);
    assert.deepEqual(persisted.acts.map((item) => item.index), [0, 1, 2]);
  } finally {
    if (previousDisableWake === undefined) delete process.env.SQUARE_DISABLE_PASEO_WAKE;
    else process.env.SQUARE_DISABLE_PASEO_WAKE = previousDisableWake;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude installation leaves a diagnosable bundle that can be removed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-claude-install-'));
  const runClaude = (_home, args) => ({
    status: 0,
    stdout: args[1] === 'list' ? enabledClaudePlugins(CLAUDE_PLUGIN_ID) : '',
    stderr: '',
  });
  try {
    const installed = await installClaudePlugin(home, runClaude);
    assert.equal(fs.existsSync(path.join(installed.pluginRoot, '.claude-plugin', 'plugin.json')), true);
    assert.equal(fs.existsSync(path.join(installed.pluginRoot, 'hooks', 'hooks.json')), true);
    assert.equal(fs.existsSync(path.join(installed.pluginRoot, 'skills', 'square', 'SKILL.md')), true);
    const marketplace = JSON.parse(fs.readFileSync(path.join(installed.marketplaceRoot, '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.deepEqual(marketplace.owner, { name: 'Square' });
    assert.match((await doctorClaudePlugin(home, runClaude)).join('\n'), /✓ square@astrosheep installed/);
    await uninstallClaudePlugin(home, runClaude);
    assert.equal(fs.existsSync(installed.marketplaceRoot), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Claude installation overwrites a divergent bundled Square skill with the canonical source', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-claude-canonical-skill-'));
  const bundledSkill = path.join(import.meta.dirname, '..', 'plugins', 'claude', 'skills', 'square', 'SKILL.md');
  const canonicalSkill = path.join(import.meta.dirname, '..', 'skills', 'square', 'SKILL.md');
  const original = fs.readFileSync(bundledSkill);
  fs.writeFileSync(bundledSkill, 'deliberately divergent bundled content\n');
  const runClaude = () => ({ status: 0, stdout: '', stderr: '' });
  try {
    const installed = await installClaudePlugin(home, runClaude);
    assert.deepEqual(fs.readFileSync(path.join(installed.pluginRoot, 'skills', 'square', 'SKILL.md')), fs.readFileSync(canonicalSkill));
  } finally {
    fs.writeFileSync(bundledSkill, original);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Claude installation preserves the prior bundle when activation fails', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-claude-stage-rollback-'));
  const marketplace = path.join(home, '.square', 'claude', 'marketplaces', SQUARE_IDENTITY.marketplaceName);
  fs.mkdirSync(marketplace, { recursive: true });
  fs.writeFileSync(path.join(marketplace, 'previous.txt'), 'keep this bundle');
  const rejectUpdate = (_home, args) => ({
    status: args[1] === 'update' ? 1 : 0,
    stdout: '',
    stderr: 'activation rejected',
  });
  try {
    await assert.rejects(installClaudePlugin(home, rejectUpdate), /activation rejected/);
    assert.equal(fs.readFileSync(path.join(marketplace, 'previous.txt'), 'utf8'), 'keep this bundle');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Codex installation leaves a self-contained bundle with hooks enabled', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-codex-install-'));
  const runCodex = (_home, args) => ({
    status: 0,
    stdout: args[0] === 'plugin' && args[1] === 'add'
      ? JSON.stringify({ installedPath: '/tmp/square' })
      : enabledPlugins(CODEX_PLUGIN_ID),
    stderr: '',
  });
  try {
    const installed = await installCodexPlugin(home, runCodex);
    assert.match(fs.readFileSync(installed.configPath, 'utf8'), /^hooks = true$/m);
    assert.equal(fs.existsSync(path.join(installed.pluginRoot, '.codex-plugin', 'plugin.json')), true);
    assert.equal(fs.existsSync(path.join(installed.pluginRoot, 'hooks', 'hooks.json')), true);
    assert.equal(fs.existsSync(path.join(installed.pluginRoot, 'skills', 'square', 'SKILL.md')), true);
    assert.match((await doctorCodexPlugin(home, runCodex)).join('\n'), /✓ square@astrosheep installed/);
    await uninstallCodexPlugin(home, runCodex);
    assert.equal(fs.existsSync(installed.marketplaceRoot), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Codex installation honors an explicit Codex home', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-codex-explicit-home-'));
  const codexHome = path.join(home, 'codex-for');
  const observedHomes = [];
  const runCodex = (_home, args, currentCodexHome) => {
    observedHomes.push(currentCodexHome);
    return {
      status: 0,
      stdout: args[0] === 'plugin' && args[1] === 'add'
        ? JSON.stringify({ installedPath: '/tmp/square' })
        : enabledPlugins(CODEX_PLUGIN_ID),
      stderr: '',
    };
  };
  try {
    const installed = await installCodexPlugin(home, runCodex, codexHome);
    assert.equal(installed.configPath, path.join(codexHome, 'config.toml'));
    assert.equal(observedHomes.every((value) => value === codexHome), true);
    assert.match(fs.readFileSync(installed.configPath, 'utf8'), /^hooks = true$/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Codex installation refreshes the marketplace source already configured for its identity', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-codex-existing-source-'));
  const existing = path.join(home, '.square', 'codex', 'marketplace');
  const config = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, `[marketplaces.astrosheep]\nsource_type = "local"\nsource = ${JSON.stringify(existing)}\n`);
  fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, 'previous.txt'), 'old bundle');
  const calls = [];
  const runCodex = (_home, args) => {
    calls.push(args);
    return {
      status: 0,
      stdout: args[0] === 'plugin' && args[1] === 'add'
        ? JSON.stringify({ installedPath: '/tmp/square' })
        : enabledPlugins(CODEX_PLUGIN_ID),
      stderr: '',
    };
  };
  try {
    const installed = await installCodexPlugin(home, runCodex);
    assert.equal(installed.marketplaceRoot, existing);
    assert.equal(installed.pluginRoot, path.join(existing, 'plugins', 'square'));
    assert.deepEqual(calls.find((args) => args[1] === 'marketplace' && args[2] === 'add')?.[3], existing);
    assert.equal(fs.existsSync(path.join(existing, 'plugins', 'square', 'hooks', 'hooks.json')), true);
    assert.match((await doctorCodexPlugin(home, runCodex)).join('\n'), new RegExp(existing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Codex installation preserves the prior bundle when the host rejects it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-codex-stage-rollback-'));
  const marketplace = codexMarketplaceRoot(home);
  fs.mkdirSync(marketplace, { recursive: true });
  fs.writeFileSync(path.join(marketplace, 'previous.txt'), 'keep this bundle');
  const rejectPlugin = (_home, args) => ({
    status: args[0] === 'plugin' && args[1] === 'add' ? 1 : 0,
    stdout: '',
    stderr: 'activation rejected',
  });
  try {
    await assert.rejects(installCodexPlugin(home, rejectPlugin), /activation rejected/);
    assert.equal(fs.readFileSync(path.join(marketplace, 'previous.txt'), 'utf8'), 'keep this bundle');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Pi inbox helpers expose stable notification identity without invocation hints', () => {
  const inbox = sampleInbox();
  const context = renderPiInbox(inbox);
  assert.equal(pendingInbox([...inbox, { ...inbox[0], notifications: [] }]).length, 1);
  assert.deepEqual(inboxKeys(inbox), ['/tmp/SQUARE.square\u0000bob\u00007']);
  assert.match(context, /^\n<system-reminder>\nThis is an external reminder from Square, not a direct message from the user\.\n\n<square-activity square="\/tmp\/SQUARE\.square" as="Bob" id="act\/7" from="Alice">/);
  assert.match(context, /^Alice spoke your name\.$/m);
  assert.doesNotMatch(context, /^>$/m);
  assert.match(context, /<\/square-activity>\n<\/system-reminder>\n$/);
  assert.doesNotMatch(context, /catch --now/);
});

test('Pi square card collapses to who reached you, where, and their opening line, and expands to Markdown bodies', () => {
  const membership = (notifications) => ({ ...sampleInbox()[0], notifications });
  const note = (overrides = {}) => ({ actIndex: 7, actor: 'Alice', route: 'mention', body: 'hello @Bob', ...overrides });
  const theme = { fg: (_color, text) => `<${text}>` };
  const details = pendingCardDetails([membership([note({ route: 'bell', body: '\nhello **@Bob**\nsecond' }), note({ actor: 'Cara', route: 'reply', actIndex: 8 })])]);
  assert.deepEqual(details.items, [
    { square: 'SQUARE', actor: 'Alice', recipient: 'Bob', route: 'bell', act: 'act/7', preview: '\nhello **@Bob**\nsecond', description: 'Alice rang the bell', body: '\nhello **@Bob**\nsecond' },
    { square: 'SQUARE', actor: 'Cara', recipient: 'Bob', route: 'reply', act: 'act/8', preview: 'hello @Bob', description: 'Cara answered you', body: 'hello @Bob' },
  ]);
  assert.equal(pendingCardDetails([membership([])]), undefined);

  const message = { customType: 'square', content: 'model text', details };
  const card = renderSquareCard(message, { expanded: false, outputPad: 1 }, theme);
  assert.deepEqual(card.render(80), [' <■> Alice rang the bell< · SQUARE · Bob +1>', '   <hello @Bob>']);
  // Narrow terminals truncate instead of overflowing the viewport.
  const narrow = card.render(14);
  assert.match(narrow[0], /…$/);
  for (const line of narrow) {
    // The fake theme wraps styled spans in <…>; only the text counts toward width.
    assert.ok(Array.from(line.replace(/<■>/, 'x').replace(/[<>]/g, '')).reduce((n, c) => n + (c.charCodeAt(0) < 0x80 ? 1 : 2), 0) <= 14);
  }
  const expanded = renderSquareCard(message, { expanded: true, outputPad: 1 }, theme).render(100).join('\n');
  assert.match(expanded, /<●> Alice rang the bell<  SQUARE · Bob · act\/7>/);
  assert.match(expanded, /Cara answered you<  SQUARE · Bob · act\/8>/);
  assert.match(expanded, /hello @Bob/);
  assert.doesNotMatch(expanded, /model text|square-activity|\*\*/);
  // Old messages and joining context retain Pi's default renderer.
  const legacy = { ...message, details: { items: [{ square: 'SQUARE', description: 'old' }], fullText: 'old' } };
  assert.equal(renderSquareCard(legacy, { expanded: true }, theme), undefined);
  assert.equal(renderSquareCard({ ...message, details: undefined }, { expanded: false }, theme), undefined);
});

test('Pi expansion retains clipped and omitted bodies and wraps wide text without losing the tail', () => {
  const body = `${'中文🦈 long '.repeat(40)}\nEND_FULL_TEXT`;
  const inbox = [{
    ...sampleInbox()[0],
    notifications: Array.from({ length: 6 }, (_, i) => ({
      actIndex: i, actor: 'Alice', route: 'mention', body: `${body}\nnotification-${i}`,
    })),
  }];
  const content = renderPiInbox(inbox);
  assert.match(content, /\d+ more activities? not shown\./);
  assert.ok(content.length <= 1200);
  assert.equal(content.split('This is an external reminder from Square,').length - 1, 1);
  assert.equal(renderPiInbox([]), '');
  assert.doesNotMatch(content, /END_FULL_TEXT|square --|catch --/);
  const details = pendingCardDetails(inbox);
  for (const note of inbox[0].notifications) assert.ok(details.fullText.includes(note.body));
  assert.deepEqual(details.items.map(item => item.body), inbox[0].notifications.map(note => note.body));
  const card = renderSquareCard({ content, details }, { expanded: true, outputPad: 1 }, {});
  for (const width of [24, 80]) {
    const lines = card.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.equal(lines.filter(line => line.includes('END_FULL_TEXT')).length, 6);
    assert.match(lines.join('\n'), /notification-5/);
  }
});

test('the omission line names what the budget dropped and closes the reminder', () => {
  const longPath = `/tmp/${'d'.repeat(90)}.square`;
  const pending = (count) => [{ ...sampleInbox()[0], location: longPath, notifications: Array.from({ length: count }, (_, i) => ({
    actIndex: 10 + i, actor: 'Alice', route: 'mention', body: 'y'.repeat(600),
  })) }];
  const one = renderPiInbox(pending(3));
  assert.equal(one.split('<square-activity').length - 1, 2);
  assert.match(one, /\n\n1 more activity not shown\.\n<\/system-reminder>\n$/);
  assert.ok(one.length <= 1200);
  const two = renderPiInbox(pending(4));
  assert.match(two, /\n\n2 more activities not shown\.\n<\/system-reminder>\n$/);
  assert.ok(two.length <= 1200);
});

async function piFixture(sessionId, pending = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-extension-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const indexPath = path.join(root, 'index.ndjsonl');
  const aliceBody = `pi:${sessionId}-author`;
  const bobBody = `pi:${sessionId}`;
  const env = { ...process.env, SQUARE_INDEX: indexPath };
  const aliceSquare = await Square.build({ path: squarePath, markdown: 'test', env });
  try { await aliceSquare.join('Alice', { owner: aliceBody }); }
  finally { await aliceSquare.close(); }
  const bobSquare = await Square.at({ path: squarePath, env });
  try { await bobSquare.join('Bob', { owner: bobBody }); }
  finally { await bobSquare.close(); }
  if (pending) {
    const author = await Square.at({ path: squarePath, env });
    try { await (await author.participant('Alice', { owner: aliceBody })).express('hello @Bob', { force: true, mentions: ['Bob'] }); }
    finally { await author.close(); }
  }
  return { root, squarePath, indexPath, env, aliceBody, bobBody, sessionId };
}

async function withPiFixture(sessionId, fn, pending = true) {
  const item = await piFixture(sessionId, pending);
  const previous = { squareIndex: process.env.SQUARE_INDEX, piSession: process.env.PI_SESSION_ID };
  process.env.SQUARE_INDEX = item.indexPath;
  delete process.env.PI_SESSION_ID;
  try {
    await fn(item);
  } finally {
    if (previous.squareIndex === undefined) delete process.env.SQUARE_INDEX;
    else process.env.SQUARE_INDEX = previous.squareIndex;
    if (previous.piSession === undefined) delete process.env.PI_SESSION_ID;
    else process.env.PI_SESSION_ID = previous.piSession;
    // Yield while an aborted presentation releases its file handles on Windows.
    await fs.promises.rm(item.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
}

async function expressToPi(item, text) {
  const square = await Square.at({ path: item.squarePath, env: item.env });
  try {
    const alice = await square.participant('Alice', { owner: item.aliceBody });
    const result = await alice.express(text, { mentions: ['Bob'] });
    return Number(result.activity.id.slice('act/'.length));
  } finally { await square.close(); }
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function piMessageEnd(handlers, content) {
  return handlers.get('message_end')({
    message: { role: 'custom', customType: 'square', content },
  });
}

function piInputMessageEnd(handlers, role = 'user') {
  return handlers.get('message_end')({ message: { role, content: 'ordinary queued input' } });
}

function piTurnStart(handlers) {
  return handlers.get('turn_start')({});
}

function piAgentStart(handlers, ctx) {
  return handlers.get('agent_start')({}, ctx);
}

function piTurnEnd(handlers, stopReason = 'stop', ctx = {}) {
  return handlers.get('turn_end')({ message: { stopReason } }, ctx);
}

function presentationBoundaryLockPath(sessionId) {
  const index = path.resolve(process.env.SQUARE_INDEX ?? path.join(os.homedir(), '.square', 'index.ndjsonl'));
  return `${index}.boundary-${crypto.createHash('sha256').update(JSON.stringify("pi" + ":" + (sessionId))).digest('hex')}.lock`;
}

/** Hold the per-session presentation boundary lock so the next boundary must wait for it. */
async function holdBoundaryLock(sessionId) {
  let release;
  let acquired;
  const acquiredPromise = new Promise((resolve) => { acquired = resolve; });
  const held = withFileLock(presentationBoundaryLockPath(sessionId), { retryMs: 10 }, async () => {
    acquired();
    await new Promise((resolve) => { release = resolve; });
  });
  await acquiredPromise;
  return { release: () => release(), held: () => held };
}

test('Pi leaves process.env.PI_SESSION_ID to Pi across start, replacement, and shutdown', async () => {
  await withPiFixture('pi-native-identity', async () => {
    const handlers = new Map();
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      sendMessage() { return Promise.resolve(); },
    };
    squarePiExtension(pi);
    const native = '01a0912e-native-parent-session';
    process.env.PI_SESSION_ID = native;
    try {
      const child = { sessionManager: { getSessionId: () => 'pi-child-session' }, cwd: '/tmp/no-public-square' };
      await handlers.get('session_start')({}, child);
      assert.equal(process.env.PI_SESSION_ID, native, 'session_start must not overwrite the native identity');
      await handlers.get('session_start')({}, { sessionManager: { getSessionId: () => 'pi-replacement-session' }, cwd: '/tmp/no-public-square' });
      assert.equal(process.env.PI_SESSION_ID, native, 'session replacement must not overwrite the native identity');
      await handlers.get('session_shutdown')({}, child);
      assert.equal(process.env.PI_SESSION_ID, native, 'session_shutdown must not restore or delete the native identity');
    } finally {
      delete process.env.PI_SESSION_ID;
    }
  }, false);
});

test('Pi waits on a contended boundary lock and binds delivery to its ctx session, not the ancestor in process.env', async () => {
  await withPiFixture('pi-boundary-child-session', async (item) => {
    const handlers = new Map();
    const sent = [];
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      sendMessage(message, options) { sent.push({ message, options }); return Promise.resolve(); },
    };
    squarePiExtension(pi);
    const ancestor = '01a08fbf-ancestor-native-session';
    process.env.PI_SESSION_ID = ancestor;
    const lock = await holdBoundaryLock('pi-boundary-child-session');
    const notified = [];
    const context = {
      sessionManager: { getSessionId: () => 'pi-boundary-child-session' },
      cwd: '/tmp/no-public-square',
      ui: { notify: (message, level) => notified.push({ message, level }) },
    };
    try {
      await handlers.get('session_start')({}, context);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(sent.length, 0, 'a held boundary lock must make this operation wait, not fail its abort signal');
      assert.equal(process.env.PI_SESSION_ID, ancestor, 'the extension must not rewrite the process identity');
      lock.release();
      await lock.held();
      await waitUntil(() => sent.length === 1, 'Pi did not deliver after the contended boundary lock released');
      assert.match(sent[0].message.content, /hello @Bob/);
      assert.equal(sent[0].message.display, true, 'the human sees one collapsible card instead of a separate notify');
      assert.deepEqual(sent[0].message.details.items, [{ square: 'SQUARE', actor: 'Alice', recipient: 'Bob', route: 'mention', act: 'act/2', preview: 'hello @Bob', description: 'Alice spoke your name', body: 'hello @Bob' }]);
      assert.deepEqual(notified, [], 'the card replaces the transient notify');
      await piMessageEnd(handlers, sent[0].message.content);
      await waitUntil(
        async () => await hasPresentedForOwner('pi-boundary-child-session', item.squarePath, 'Bob', 2),
        'Pi did not commit the boundary delivery under its own ctx session',
      );
    } finally {
      lock.release();
      await handlers.get('session_shutdown')({}, context);
      delete process.env.PI_SESSION_ID;
    }
  });
});

test('Pi aborts a contended boundary wait on TUI cancellation without touching the ancestor process identity', async () => {
  await withPiFixture('pi-boundary-cancel-session', async (item) => {
    const handlers = new Map();
    const sent = [];
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      sendMessage(message, options) { sent.push({ message, options }); return Promise.resolve(); },
    };
    squarePiExtension(pi);
    const ancestor = '01a08fbf-ancestor-native-session';
    process.env.PI_SESSION_ID = ancestor;
    const context = { sessionManager: { getSessionId: () => 'pi-boundary-cancel-session' }, cwd: '/tmp/no-public-square' };
    try {
      await handlers.get('session_start')({}, context);
      await waitUntil(() => sent.length === 1, 'Pi did not steer the initial pending activity');
      await piMessageEnd(handlers, sent[0].message.content);
      await waitUntil(
        async () => await hasPresentedForOwner('pi-boundary-cancel-session', item.squarePath, 'Bob', 2),
        'the initial delivery did not commit',
      );

      const lock = await holdBoundaryLock('pi-boundary-cancel-session');
      const run = new AbortController();
      await piAgentStart(handlers, { mode: 'tui', signal: run.signal });
      const cancelledIndex = await expressToPi(item, 'cancelled while the boundary lock is held @Bob');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(sent.length, 1, 'the cancelled batch must not reach Pi while the boundary lock is held');
      run.abort();
      lock.release();
      await lock.held();
      await piTurnEnd(handlers, 'aborted', { mode: 'tui' });
      await handlers.get('agent_settled')({});
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(sent.length, 1, 'the cancelled batch must not be delivered after the lock releases');
      assert.equal(process.env.PI_SESSION_ID, ancestor, 'cancellation must not rewrite the ancestor identity');
      assert.equal(await hasPresentedForOwner('pi-boundary-cancel-session', item.squarePath, 'Bob', cancelledIndex), false);

      const freshIndex = await expressToPi(item, 'fresh after boundary cancellation @Bob');
      await waitUntil(() => sent.length === 2, 'Pi did not deliver new activity after cancellation');
      await piMessageEnd(handlers, sent[1].message.content);
      await waitUntil(
        async () => await hasPresentedForOwner('pi-boundary-cancel-session', item.squarePath, 'Bob', freshIndex),
        'fresh activity did not commit after cancellation',
      );
    } finally {
      await handlers.get('session_shutdown')({}, context);
      delete process.env.PI_SESSION_ID;
    }
  });
});

test('Pi steers pending activity into a running agent and commits only when it lands', async () => {
  await withPiFixture('pi-running-session', async (item) => {
    const handlers = new Map();
    const sent = [];
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      sendMessage(message, options) { sent.push({ message, options }); return Promise.resolve(); },
    };
    squarePiExtension(pi);
    const context = {
      sessionManager: { getSessionId: () => 'pi-running-session' },
      cwd: '/tmp/no-public-square',
      isIdle() { throw new Error('the watcher must not inspect idle state'); },
    };
    assert.deepEqual([...handlers.keys()].sort(), ['agent_settled', 'agent_start', 'message_end', 'session_shutdown', 'session_start', 'turn_end', 'turn_start']);
    await handlers.get('session_start')({}, context);
    try {
      const actIndex = await expressToPi(item, 'steer me while running @Bob');
      await waitUntil(() => sent.length === 1, 'Pi did not steer the new directed activity');
      assert.deepEqual(sent[0].options, { deliverAs: 'steer', triggerTurn: true });
      assert.match(sent[0].message.content, /steer me while running @Bob/);
      assert.equal(await hasPresentedForOwner('pi-running-session', item.squarePath, 'Bob', actIndex), false);
      assert.equal((await readSquareSnapshot(item.squarePath)).state.runtime.observations.Bob?.[formatActivityId(actIndex)], undefined);

      await piMessageEnd(handlers, 'another Square message');
      assert.equal(await hasPresentedForOwner('pi-running-session', item.squarePath, 'Bob', actIndex), false);
      await piMessageEnd(handlers, sent[0].message.content);
      await waitUntil(async () => await hasPresentedForOwner('pi-running-session', item.squarePath, 'Bob', actIndex), 'Pi did not commit the landed notification');
      assert.equal((await readSquareSnapshot(item.squarePath)).state.runtime.observations.Bob[formatActivityId(actIndex)].state, 'seen');
      assert.equal(sent.length, 1);
    } finally {
      await handlers.get('session_shutdown')({}, context);
    }
  }, false);
});

test('Pi retries a dropped steer after a transient evidence write failure and commits once it lands', async (t) => {
  await withPiFixture('pi-dropped-session', async (item) => {
    const handlers = new Map();
    const sent = [];
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      sendMessage(message, options) { sent.push({ message, options }); return Promise.resolve(); },
    };
    let refusedCommit = false;
    let failNextCommit = false;
    const exec = DatabaseSync.prototype.exec;
    const writing = new WeakSet();
    const artifactLocation = fs.realpathSync.native(item.squarePath);
    t.mock.method(DatabaseSync.prototype, 'exec', function (sql, ...args) {
      if (sql === 'BEGIN IMMEDIATE') writing.add(this);
      if (failNextCommit && sql === 'COMMIT' && writing.has(this) && this.location() === artifactLocation
        && this.prepare("SELECT 1 FROM delivery_evidence WHERE kind='presentation' AND outcome='failed'").get()) {
        failNextCommit = false;
        refusedCommit = true;
        throw new Error('database is locked');
      }
      const result = exec.call(this, sql, ...args);
      if (sql === 'COMMIT' || sql === 'ROLLBACK') writing.delete(this);
      return result;
    });
    squarePiExtension(pi);
    const context = { sessionManager: { getSessionId: () => 'pi-dropped-session' }, cwd: '/tmp/no-public-square' };
    await handlers.get('session_start')({}, context);
    try {
      const actIndex = await expressToPi(item, 'retry the dropped steer @Bob');
      await waitUntil(() => sent.length === 1, 'Pi did not attempt the first steer');
      await piTurnStart(handlers);
      failNextCommit = true;
      await piTurnEnd(handlers);
      assert.equal(sent.length, 1, 'the first empty turn must not drop the queued steer');
      await piTurnStart(handlers);
      await piTurnEnd(handlers);
      await waitUntil(() => refusedCommit, 'the dropped-presentation artifact commit did not encounter the injected busy');
      await waitUntil(() => failNextCommit === false, 'the artifact did not retry its transient commit');
      await piTurnStart(handlers);
      await piTurnEnd(handlers);
      await waitUntil(() => sent.length === 2, 'Pi did not re-present the dropped notification');
      assert.equal(refusedCommit, true, 'the dropped-presentation evidence commit must encounter the injected busy');
      assert.equal(await hasPresentedForOwner('pi-dropped-session', item.squarePath, 'Bob', actIndex), false);
      await piMessageEnd(handlers, sent[1].message.content);
      await waitUntil(async () => await hasPresentedForOwner('pi-dropped-session', item.squarePath, 'Bob', actIndex), 'Pi did not commit the retried notification');
      assert.equal((await readSquareSnapshot(item.squarePath)).state.runtime.observations.Bob[formatActivityId(actIndex)].state, 'seen');
      assert.equal(sent.length, 2);
    } finally {
      await handlers.get('session_shutdown')({}, context);
    }
  }, false);
});

test('Pi cancels the entire TUI pending batch without resurrecting it on later activity', async () => {
  await withPiFixture('pi-tui-aborted-session', async (item) => {
    const handlers = new Map();
    const sent = [];
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      sendMessage(message, options) { sent.push({ message, options }); return Promise.resolve(); },
    };
    squarePiExtension(pi);
    const context = { sessionManager: { getSessionId: () => 'pi-tui-aborted-session' }, cwd: '/tmp/no-public-square' };
    await handlers.get('session_start')({}, context);
    try {
      const run = new AbortController();
      await piAgentStart(handlers, { mode: 'tui', signal: run.signal });
      const actIndex = await expressToPi(item, 'retry after the TUI clears the queue @Bob');
      await waitUntil(() => sent.length === 1, 'Pi did not attempt the steer');
      const queuedIndex = await expressToPi(item, 'cancel the unsent backlog too @Bob');
      await piTurnStart(handlers);
      run.abort();
      run.abort();
      await piTurnEnd(handlers, 'aborted', { mode: 'tui' });
      assert.equal(sent.length, 1);
      await handlers.get('agent_settled')({});
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(sent.length, 1);
      await piMessageEnd(handlers, sent[0].message.content);
      await piTurnStart(handlers);
      await piInputMessageEnd(handlers);
      await piTurnEnd(handlers);
      const freshIndex = await expressToPi(item, 'only the new notification @Bob');
      await waitUntil(() => sent.length === 2, 'Pi did not deliver new activity');
      assert.doesNotMatch(sent[1].message.content, /retry after|unsent backlog/);
      await piMessageEnd(handlers, sent[1].message.content);
      await waitUntil(
        async () => await hasPresentedForOwner('pi-tui-aborted-session', item.squarePath, 'Bob', freshIndex),
        'Pi did not commit the new notification',
      );
      for (const index of [actIndex, queuedIndex]) {
        assert.equal(await hasPresentedForOwner('pi-tui-aborted-session', item.squarePath, 'Bob', index), false);
        assert.equal((await readSquareSnapshot(item.squarePath)).state.runtime.observations.Bob?.[formatActivityId(index)], undefined);
      }
      assert.equal(sent.length, 2);
    } finally {
      await handlers.get('session_shutdown')({}, context);
    }
  }, false);
});

test('Pi cancellation persists its cutoff across watcher restart and admits later activity', async () => {
  await withPiFixture('pi-durable-cancel-cutoff', async (item) => {
    const handlers = new Map();
    const sent = [];
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      sendMessage(message, options) { sent.push({ message, options }); return Promise.resolve(); },
    };
    squarePiExtension(pi);
    const context = { sessionManager: { getSessionId: () => 'pi-durable-cancel-cutoff' }, cwd: '/tmp/no-public-square' };
    await handlers.get('session_start')({}, context);
    try {
      await waitUntil(() => sent.length === 1, 'Pi did not deliver the initial activity');
      await piMessageEnd(handlers, sent[0].message.content);
      await waitUntil(async () => await hasPresentedForOwner('pi-durable-cancel-cutoff', item.squarePath, 'Bob', 2),
        'Pi did not commit the initial presentation');

      const lock = await holdBoundaryLock('pi-durable-cancel-cutoff');
      const run = new AbortController();
      await piAgentStart(handlers, { mode: 'tui', signal: run.signal });
      const cancelledIndex = await expressToPi(item, 'this pending activity belongs to the aborted run @Bob');
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(sent.length, 1, 'the held boundary must keep the pending activity from reaching Pi');

      run.abort();
      await piTurnEnd(handlers, 'aborted', { mode: 'tui' });
      const artifact = createArtifactPort(item.squarePath);
      try {
        await waitUntil(async () => (await artifact.read(facts => {
          const seat = facts.seat('Bob');
          return seat === undefined ? undefined : facts.cancelledThrough('Bob', seat.generation);
        })).value === cancelledIndex, 'Pi did not persist the cancellation cutoff');
      } finally { await artifact.close(); }

      const freshIndex = await expressToPi(item, 'this activity landed after the persisted cutoff @Bob');
      assert.ok(freshIndex > cancelledIndex);
      lock.release();
      await lock.held();
      await handlers.get('agent_settled')({});
      await waitUntil(() => sent.length === 2, 'Pi did not deliver activity newer than the cancellation cutoff');
      assert.match(sent[1].message.content, /landed after the persisted cutoff/);
      assert.doesNotMatch(sent[1].message.content, /belongs to the aborted run/);
      await piMessageEnd(handlers, sent[1].message.content);
      await waitUntil(async () => await hasPresentedForOwner('pi-durable-cancel-cutoff', item.squarePath, 'Bob', freshIndex),
        'Pi did not commit the post-cutoff activity');

      // A second session_start clears every process-local suppression set, like a watcher restart.
      await handlers.get('session_start')({}, context);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(sent.length, 2, 'the persisted cutoff must suppress cancelled work after local state resets');
      assert.equal(await hasPresentedForOwner('pi-durable-cancel-cutoff', item.squarePath, 'Bob', cancelledIndex), false);
    } finally {
      await handlers.get('session_shutdown')({}, context);
    }
  });
});

test('a failed Pi cancellation fences only its native session and does not replay that session', async (t) => {
  await withPiFixture('pi-failed-cancel-old-session', async (item) => {
    const handlers = new Map();
    const sent = [];
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      sendMessage(message, options) { sent.push({ message, options }); return Promise.resolve(); },
    };
    let failCancellation = false, failedCancellation = false;
    const exec = DatabaseSync.prototype.exec;
    const artifactLocation = fs.realpathSync.native(item.squarePath);
    t.mock.method(DatabaseSync.prototype, 'exec', function (sql, ...args) {
      if (failCancellation && sql === 'BEGIN IMMEDIATE' && this.location() === artifactLocation) {
        failCancellation = false;
        failedCancellation = true;
        throw new Error('injected cancellation write failure');
      }
      return exec.call(this, sql, ...args);
    });
    squarePiExtension(pi);
    const oldId = item.sessionId;
    const context = id => ({ sessionManager: { getSessionId: () => id }, cwd: '/tmp/no-public-square' });
    await handlers.get('session_start')({}, context(oldId));
    const run = new AbortController();
    await piAgentStart(handlers, { mode: 'tui', signal: run.signal });
    failCancellation = true;
    run.abort();
    await piTurnEnd(handlers, 'aborted', { mode: 'tui' });
    await handlers.get('agent_settled')({});
    assert.equal(failedCancellation, true, 'cancellation suppression must encounter the injected persistence failure');
    assert.equal(sent.length, 0);

    const newId = 'pi-new-session-after-old-failure';
    const newBody = "pi" + ":" + (newId);
    const recipient = await Square.at({ path: item.squarePath, env: item.env });
    try { await recipient.join('NewBob', { owner: newBody }); } finally { await recipient.close(); }
    const author = await Square.at({ path: item.squarePath, env: item.env });
    let newIndex;
    try { newIndex = Number((await (await author.participant('Alice', { owner: item.aliceBody })).express('new session remains live @NewBob', { mentions: ['NewBob'] })).activity.id.slice(4)); }
    finally { await author.close(); }

    await handlers.get('session_start')({}, context(newId));
    await waitUntil(() => sent.length === 1, 'an old-session cancellation failure disabled the new Pi watcher');
    assert.match(sent[0].message.content, /new session remains live/);
    await piMessageEnd(handlers, sent[0].message.content);
    await waitUntil(async () => await hasPresentedForOwner(newId, item.squarePath, 'NewBob', newIndex), 'the new session did not finish its notification');

    const oldAuthor = await Square.at({ path: item.squarePath, env: item.env });
    let oldIndex;
    try { oldIndex = Number((await (await oldAuthor.participant('Alice', { owner: item.aliceBody })).express('old failed session must not replay @Bob', { mentions: ['Bob'] })).activity.id.slice(4)); }
    finally { await oldAuthor.close(); }
    await handlers.get('session_start')({}, context(oldId));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(sent.length, 1, 'the failed session must not restart its watcher or replay new pending work');
    assert.equal(await hasPresentedForOwner(oldId, item.squarePath, 'Bob', oldIndex), false);

    // A later successful suppression clears the old session's failure before its watcher restarts.
    await handlers.get('session_start')({}, context(oldId));
    const retry = new AbortController();
    await piAgentStart(handlers, { mode: 'tui', signal: retry.signal });
    retry.abort();
    await piTurnEnd(handlers, 'aborted', { mode: 'tui' });
    await handlers.get('agent_settled')({});
    const artifact = createArtifactPort(item.squarePath);
    try {
      assert.ok((await artifact.read(facts => facts.cancelledThrough('Bob', facts.seat('Bob').generation))).value >= oldIndex,
        'the successful retry must persist the old session boundary');
    } finally { await artifact.close(); }
    const fresh = await Square.at({ path: item.squarePath, env: item.env });
    let freshIndex;
    try { freshIndex = Number((await (await fresh.participant('Alice', { owner: item.aliceBody })).express('fresh after suppression recovery @Bob', { mentions: ['Bob'] })).activity.id.slice(4)); }
    finally { await fresh.close(); }
    await waitUntil(() => sent.length === 2, 'a successful retry did not restore the old session watcher');
    assert.match(sent[1].message.content, /fresh after suppression recovery/);
    await piMessageEnd(handlers, sent[1].message.content);
    await waitUntil(async () => await hasPresentedForOwner(oldId, item.squarePath, 'Bob', freshIndex), 'the recovered watcher did not commit new activity');
    await handlers.get('session_shutdown')({}, context(oldId));
  });
});

test('Pi cancellation covers the captured pending head, never revives it at settled, and allows later activity', async () => {
  await withPiFixture('pi-post-abort-steer-session', async (item) => {
    const handlers = new Map();
    const sent = [];
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      sendMessage(message, options) { sent.push({ message, options }); return Promise.resolve(); },
    };
    squarePiExtension(pi);
    const context = { sessionManager: { getSessionId: () => 'pi-post-abort-steer-session' }, cwd: '/tmp/no-public-square' };
    await handlers.get('session_start')({}, context);
    const lock = await holdBoundaryLock(item.sessionId);
    try {
      const abortedRun = new AbortController();
      await piAgentStart(handlers, { mode: 'tui', signal: abortedRun.signal });
      await piTurnStart(handlers);
      // Land before cancellation; the real boundary lock prevents an earlier send.
      // A say after abort is not necessarily inside the cancellation's captured head.
      const actIndex = await expressToPi(item, 'pending at the cancellation boundary @Bob');
      assert.equal(sent.length, 0);
      abortedRun.abort();
      await piTurnEnd(handlers, 'aborted', { mode: 'tui' });
      await handlers.get('agent_settled')({});
      const artifact = createArtifactPort(item.squarePath);
      try {
        assert.ok((await artifact.read(facts => facts.cancelledThrough('Bob', facts.seat('Bob').generation))).value >= actIndex,
          'completed cancellation must durably cover the old pending activity');
      } finally { await artifact.close(); }
      lock.release();
      await lock.held();
      assert.equal(sent.length, 0);
      assert.equal(await hasPresentedForOwner(item.sessionId, item.squarePath, 'Bob', actIndex), false);
      const freshIndex = await expressToPi(item, 'fresh after cancellation @Bob');
      await waitUntil(() => sent.length === 1, 'Pi did not deliver fresh activity');
      assert.match(sent[0].message.content, /fresh after cancellation/);
      assert.doesNotMatch(sent[0].message.content, /pending at the cancellation boundary/);
      await piMessageEnd(handlers, sent[0].message.content);
      await waitUntil(
        async () => await hasPresentedForOwner(item.sessionId, item.squarePath, 'Bob', freshIndex),
        'Pi did not commit fresh activity',
      );
      assert.equal(sent.length, 1);
    } finally {
      lock.release();
      await lock.held();
      await handlers.get('session_shutdown')({}, context);
    }
  }, false);
});

test('Pi lets a steer retained past errored and RPC-aborted runs land at the next drain', async () => {
  await withPiFixture('pi-retained-session', async (item) => {
    const handlers = new Map();
    const sent = [];
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      sendMessage(message, options) { sent.push({ message, options }); return Promise.resolve(); },
    };
    squarePiExtension(pi);
    const context = { sessionManager: { getSessionId: () => 'pi-retained-session' }, cwd: '/tmp/no-public-square' };
    await handlers.get('session_start')({}, context);
    try {
      const actIndex = await expressToPi(item, 'land after the next initial drain @Bob');
      await waitUntil(() => sent.length === 1, 'Pi did not attempt the steer');
      await piTurnStart(handlers);
      await piInputMessageEnd(handlers);
      await piTurnEnd(handlers, 'error', { mode: 'tui' });
      await piTurnStart(handlers);
      await piInputMessageEnd(handlers);
      await piTurnEnd(handlers, 'aborted', { mode: 'rpc' });
      await handlers.get('agent_settled')({});
      assert.equal(sent.length, 1);
      await piTurnStart(handlers);
      await piMessageEnd(handlers, sent[0].message.content);
      await waitUntil(
        async () => await hasPresentedForOwner('pi-retained-session', item.squarePath, 'Bob', actIndex),
        'Pi did not commit the retained steer after it landed',
      );
      assert.equal(sent.length, 1);
    } finally {
      await handlers.get('session_shutdown')({}, context);
    }
  }, false);
});

test('Pi does not drop a Square steer queued behind ordinary steers', async () => {
  await withPiFixture('pi-queued-steer-session', async (item) => {
    const handlers = new Map();
    const sent = [];
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      sendMessage(message, options) { sent.push({ message, options }); return Promise.resolve(); },
    };
    squarePiExtension(pi);
    const context = { sessionManager: { getSessionId: () => 'pi-queued-steer-session' }, cwd: '/tmp/no-public-square' };
    await handlers.get('session_start')({}, context);
    try {
      const actIndex = await expressToPi(item, 'wait behind ordinary steers @Bob');
      await waitUntil(() => sent.length === 1, 'Pi did not attempt the steer');
      for (let index = 0; index < 4; index += 1) {
        await piTurnStart(handlers);
        await piInputMessageEnd(handlers);
        await piTurnEnd(handlers);
      }
      assert.equal(sent.length, 1);
      await piTurnStart(handlers);
      await piMessageEnd(handlers, sent[0].message.content);
      await waitUntil(
        async () => await hasPresentedForOwner('pi-queued-steer-session', item.squarePath, 'Bob', actIndex),
        'Pi did not commit the late queued steer',
      );
      assert.equal(sent.length, 1);
    } finally {
      await handlers.get('session_shutdown')({}, context);
    }
  }, false);
});

test('Pi releases a settled landing acknowledgment from its watcher signal', async () => {
  const NativeAbortController = globalThis.AbortController;
  const controllers = [];
  globalThis.AbortController = class extends NativeAbortController {
    constructor() {
      super();
      controllers.push(this);
    }
  };
  try {
    await withPiFixture('pi-settled-ack-session', async (item) => {
      const handlers = new Map();
      const sent = [];
      const pi = {
        on(event, handler) { handlers.set(event, handler); },
        sendMessage(message, options) { sent.push({ message, options }); return Promise.resolve(); },
      };
      squarePiExtension(pi);
      const context = { sessionManager: { getSessionId: () => 'pi-settled-ack-session' }, cwd: '/tmp/no-public-square' };
      const startedControllers = controllers.length;
      await handlers.get('session_start')({}, context);
      try {
        await expressToPi(item, 'release this ack @Bob');
        await waitUntil(() => sent.length === 1, 'Pi did not attempt the steer');
        const watcherSignal = controllers[startedControllers].signal;
        const listenersBeforeLanding = getEventListeners(watcherSignal, 'abort').length;
        await piMessageEnd(handlers, sent[0].message.content);
        await waitUntil(
          () => getEventListeners(watcherSignal, 'abort').length === listenersBeforeLanding - 1,
          'Pi retained the settled landing acknowledgment abort listener',
        );
      } finally {
        await handlers.get('session_shutdown')({}, context);
      }
    }, false);
  } finally {
    globalThis.AbortController = NativeAbortController;
  }
});

test('Pi lifecycle hooks do not wait for an unobserved native injection', async () => {
  await withPiFixture('pi-stuck-session', async () => {
    const handlers = new Map();
    let calls = 0;
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      sendMessage() {
        calls += 1;
        // Native Pi is void; the message event may never arrive.
      },
    };
    const context = {
      sessionManager: { getSessionId: () => 'pi-stuck-session' },
      cwd: '/tmp/no-public-square',
    };
    squarePiExtension(pi);
    await handlers.get('session_start')({}, context);
    await waitUntil(() => calls === 1, 'Pi did not attempt native injection');

    const shutdown = handlers.get('session_shutdown')({}, context);
    await Promise.race([
      shutdown,
      new Promise((_, reject) => setTimeout(() => reject(new Error('session_shutdown blocked on sendMessage')), 100)),
    ]);
  });
});

test('Pi defers a rejected native injection until the next Square change', async () => {
  await withPiFixture('pi-retry-session', async (item) => {
    const handlers = new Map();
    let calls = 0;
    const sent = [];
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      sendMessage(message, options) {
        calls += 1;
        sent.push({ message, options });
        if (calls === 1) throw new Error('native injection failed');
      },
    };
    const context = {
      sessionManager: { getSessionId: () => 'pi-retry-session' },
      cwd: '/tmp/no-public-square',
    };
    squarePiExtension(pi);
    await handlers.get('session_start')({}, context);
    let actIndex;
    try {
      actIndex = await expressToPi(item, 'retry me @Bob');
      await waitUntil(() => calls === 1, 'Pi did not attempt native injection');
      assert.equal(await hasPresentedForOwner('pi-retry-session', item.squarePath, 'Bob', actIndex), false);
      assert.equal((await readSquareSnapshot(item.squarePath)).state.runtime.observations.Bob?.[formatActivityId(actIndex)], undefined);

      const square = await Square.at({ path: item.squarePath, env: item.env });
      try {
        const alice = await square.participant('Alice', { owner: item.aliceBody });
        await alice.listen('Bob');
      } finally {
        await square.close();
      }
      await waitUntil(() => calls === 2, 'Pi did not retry after the next Square change');
      await piMessageEnd(handlers, sent[1].message.content);
      await waitUntil(
        async () => await hasPresentedForOwner('pi-retry-session', item.squarePath, 'Bob', actIndex),
        'successful retry did not commit presentation',
      );
      assert.equal((await readSquareSnapshot(item.squarePath)).state.runtime.observations.Bob[formatActivityId(actIndex)].state, 'seen');
    } finally {
      await handlers.get('session_shutdown')({}, context);
    }
  }, false);
});

test('Pi presents a clipped body without marking it seen after it lands', async () => {
  await withPiFixture('pi-preview-session', async (item) => {
    const handlers = new Map();
    const sent = [];
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      async sendMessage(message, options) { sent.push({ message, options }); },
    };
    const context = {
      sessionManager: { getSessionId: () => 'pi-preview-session' },
      cwd: '/tmp/no-public-square',
    };
    squarePiExtension(pi);
    await handlers.get('session_start')({}, context);
    try {
      const body = `${'x'.repeat(240)} @Bob\nFULL_BODY_TAIL`;
      const actIndex = await expressToPi(item, body);
      await waitUntil(() => sent.length === 1, 'Pi did not present clipped activity');
      assert.match(sent[0].message.content, /x{195}…/);
      assert.doesNotMatch(sent[0].message.content, /FULL_BODY_TAIL/);
      assert.equal(sent[0].message.details.items[0].body, body);
      const expanded = renderSquareCard(sent[0].message, { expanded: true }, {}).render(40).join('\n');
      assert.match(expanded, /FULL_BODY_TAIL/);
      assert.doesNotMatch(expanded, /clipped/);
      assert.equal(await hasPresentedForOwner('pi-preview-session', item.squarePath, 'Bob', actIndex), false);
      assert.equal((await readSquareSnapshot(item.squarePath)).state.runtime.observations.Bob?.[formatActivityId(actIndex)], undefined);
      await piMessageEnd(handlers, sent[0].message.content);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal((await readSquareSnapshot(item.squarePath)).state.runtime.observations.Bob?.[formatActivityId(actIndex)], undefined);
      assert.equal(sent.length, 1);
    } finally {
      await handlers.get('session_shutdown')({}, context);
    }
  }, false);
});
