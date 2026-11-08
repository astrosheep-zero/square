import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'jsonc-parser';
import squarePiExtension from '../plugins/pi/square-pi.js';
import { readSquareSnapshot } from '../dist/artifact.js';
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
import { Square } from '../dist/square-api.js';
import { executeHarnessTarget } from '../dist/harness.js';
import { executeTargetBatch } from '../dist/cli/harness-command.js';
import {
  installOpenCodePlugin,
  uninstallOpenCodePlugin,
  verifyOpenCodeRuntime,
} from '../dist/harness-links.js';

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

test('Pi lifecycle keeps the harness-owned environment identity unchanged', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-identity-'));
  const previousSession = process.env.PI_SESSION_ID, previousLedger = process.env.SQUARE_DELIVERY;
  process.env.PI_SESSION_ID = 'native-parent';
  process.env.SQUARE_DELIVERY = path.join(root, 'delivery.sqlite');
  const handlers = new Map();
  squarePiExtension({
    registerTool() {}, registerFlag() {}, getFlag() {}, sendMessage() {},
    on(event, callback) {
      const previous = handlers.get(event);
      handlers.set(event, async (...args) => { await previous?.(...args); await callback(...args); });
    },
  });
  const context = session => ({ cwd: root, sessionManager: { getSessionId: () => session } });
  const first = context('child'), second = context('replacement');
  try {
    await handlers.get('session_start')({}, first);
    assert.equal(process.env.PI_SESSION_ID, 'native-parent');
    await handlers.get('session_start')({}, second);
    assert.equal(process.env.PI_SESSION_ID, 'native-parent');
    await handlers.get('session_shutdown')({}, second);
    assert.equal(process.env.PI_SESSION_ID, 'native-parent');
  } finally {
    if (previousSession === undefined) delete process.env.PI_SESSION_ID; else process.env.PI_SESSION_ID = previousSession;
    if (previousLedger === undefined) delete process.env.SQUARE_DELIVERY; else process.env.SQUARE_DELIVERY = previousLedger;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
    if (args[0] === '--version') { calls.push(args); return { status: 0, stdout: '2.0.20', stderr: '' }; }
    calls.push(args);
    // Native add sees its exact entry and does not rewrite the entire array.
    assert.deepEqual(parse(fs.readFileSync(target, 'utf8')).plugins, ['other', '@astrosheep/square']);
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.deepEqual(installOpenCodePlugin(home, true, run), ['@astrosheep/square']);
  const installed = fs.readFileSync(target, 'utf8');
  installOpenCodePlugin(home, false, run);
  assert.deepEqual(calls, [
    ['--version'], ['plugin', 'add', '@astrosheep/square'], ['plugin', 'update', '@astrosheep/square'],
    ['--version'], ['plugin', 'update', '@astrosheep/square'],
  ]);
  assert.deepEqual(parse(installed), { plugins: ['other', '@astrosheep/square'], model: 'provider/model' });
  for (const comment of source.matchAll(/\/\/[^\n]*/g)) assert.ok(installed.includes(comment[0]));
  assert.equal(fs.readFileSync(target, 'utf8'), installed);
});

test('OpenCode installation selects the CLI major from bare and prefixed version output', (t) => {
  const { home, config } = openCodeHome(t);
  const target = path.join(config, 'opencode.json');
  for (const [version, major] of [
    ['1.19.5', 1], ['opencode v1.19.5', 1],
    ['2.0.20', 2], ['v2.0.20', 2], ['opencode 2.0.20', 2],
    ['opencode v2.0.20\n', 2], ['opencode v2.1.0-rc.1+build.2', 2],
  ]) {
    const calls = [];
    installOpenCodePlugin(home, false, (_home, args) => {
      calls.push(args);
      return { status: 0, stdout: args[0] === '--version' ? version : '', stderr: '' };
    });
    assert.deepEqual(calls, major === 1 ? [['--version']]
      : [['--version'], ['plugin', 'add', '@astrosheep/square'], ['plugin', 'update', '@astrosheep/square']], version);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), major === 1
      ? { plugin: [new URL('../dist/plugins/opencode-v1/index.js', import.meta.url).href] }
      : { plugins: ['@astrosheep/square'] }, version);
    fs.rmSync(target);
  }
});

test('OpenCode installation distinguishes unknown output from an unsupported major before changing configuration', (t) => {
  const { home, config } = openCodeHome(t);
  const target = path.join(config, 'opencode.json');
  const source = '{"plugins":["other"],"model":"provider/model"}';
  fs.writeFileSync(target, source);
  for (const [version, diagnostic] of [
    ['', /Could not determine OpenCode version/],
    ['nightly', /Could not determine OpenCode version/],
    ['other v2.0.20', /Could not determine OpenCode version/],
    ['warning: requires 2.0.20', /Could not determine OpenCode version/],
    ['opencode v2.0.20\nupdate available', /Could not determine OpenCode version/],
    ['opencode v3.0.0', /Unsupported OpenCode version/],
  ]) {
    const calls = [];
    assert.throws(() => installOpenCodePlugin(home, false, (_home, args) => {
      calls.push(args);
      return { status: 0, stdout: version, stderr: '' };
    }), diagnostic, version);
    assert.deepEqual(calls, [['--version']]);
    assert.equal(fs.readFileSync(target, 'utf8'), source);
  }
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
  const run = (_home, args) => { calls.push(args); return { status: 0, stdout: args[0] === '--version' ? '2.0.20' : '', stderr: '' }; };
  installOpenCodePlugin(home, false, run);
  const installed = fs.readFileSync(target, 'utf8');
  const installedOther = fs.readFileSync(otherTarget, 'utf8');
  assert.deepEqual(parse(installed), { plugin: ['keiyaku'], plugins: ['other'], model: 'provider/model' });
  assert.deepEqual(parse(installedOther), { plugins: ['other-json', { package: '@astrosheep/square', options }], setting: true });
  for (const comment of source.matchAll(/\/\/[^\n]*/g)) assert.ok(installed.includes(comment[0]));
  installOpenCodePlugin(home, true, run);
  assert.deepEqual(calls, [['--version'], ['plugin', 'update', '@astrosheep/square'], ['--version'], ['plugin', 'update', '@astrosheep/square']]);
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
      if (args[0] === '--version') return { status: 0, stdout: '2.0.20', stderr: '' };
      assert.deepEqual(parse(fs.readFileSync(target, 'utf8')).plugins, [{ package: '@astrosheep/square', options }]);
      return { status: 0, stdout: '', stderr: '' };
    });
    assert.deepEqual(calls, [['--version'], ['plugin', 'add', '@astrosheep/square'], ['plugin', 'update', '@astrosheep/square']]);
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
  assert.throws(() => installOpenCodePlugin(home, false, (_home, args) => { assert.deepEqual(args, ['--version']); return { status: 0, stdout: '2.0.20', stderr: '' }; }), /Conflicting Square plugin options.*reconcile/);
  targets.forEach((target, index) => assert.equal(fs.readFileSync(target, 'utf8'), sources[index]));
});

test('OpenCode installation propagates native add and update failures', (t) => {
  const { home, config } = openCodeHome(t);
  const target = path.join(config, 'opencode.jsonc');
  for (const failing of ['add', 'update']) {
    const source = JSON.stringify({ plugins: failing === 'update' ? ['@astrosheep/square'] : [] });
    fs.writeFileSync(target, source);
    const run = (_home, args) => ({ status: args[1] === failing ? 1 : 0, stdout: args[0] === '--version' ? '2.0.20' : '', stderr: 'external failure' });
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
    assert.throws(() => installOpenCodePlugin(home, false, (_home, args) => { assert.deepEqual(args, ['--version']); return { status: 0, stdout: '2.0.20', stderr: '' }; }), /Invalid OpenCode/);
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
  try {
    const alice = (await square.join('Alice', { owner: body })).participant;
    await alice.express('one @Alice', { force: true, mentions: ['Alice'] });
    await alice.done();
    await square.close();
    const persisted = (await readSquareSnapshot(squarePath)).state;
    assert.deepEqual(persisted.acts.map((item) => item.kind), ['join', 'say', 'done']);
    assert.deepEqual(persisted.acts.map((item) => item.index), [0, 1, 2]);
  } finally {
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
