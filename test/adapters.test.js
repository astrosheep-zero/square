import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import squareOpenCodePlugin from '../extensions/square-opencode.js';
import squarePiExtension, {
  inboxKeys,
  pendingInbox,
  renderPiInbox,
} from '../extensions/square-pi.js';
import { emptyRuntimeState, loadSquare, writeSquareFile } from '../dist/artifact.js';
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
import { recordJoin } from '../dist/registry.js';
import { Square } from '../dist/index.js';
import { compactSquare } from '../dist/square-file-adapter.js';
import { executeTargetBatch } from '../dist/cli/harness-command.js';
import {
  installHarnessLinks,
  opencodeExtensionLink,
  skillLinks,
  verifyOpenCodeRuntime,
} from '../dist/harness-links.js';

function sampleInbox() {
  return [{
    name: 'Bob',
    squarePath: '/tmp/SQUARE.square',
    notifications: [{ actIndex: 7, actor: 'Alice', at: 8, route: 'mention', body: 'hello @Bob' }],
  }];
}

function enabledPlugins(pluginId) { return JSON.stringify({ installed: [{ pluginId, installed: true, enabled: true }] }); }
function enabledClaudePlugins(pluginId) { return JSON.stringify([{ id: pluginId, version: SQUARE_IDENTITY.packageVersion, enabled: true, installPath: '/tmp/plugin' }]); }

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

test('managed link targets are idempotent and still require force for another owner', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-links-'));
  const links = skillLinks(home, ['.agents']);
  try {
    assert.equal(links.length, 2);
    installHarnessLinks(links);
    assert.equal(path.basename(fs.realpathSync(path.join(home, '.agents', 'skills', 'square'))), 'square');
    assert.equal(path.basename(fs.realpathSync(path.join(home, '.agents', 'skills', 'brainstorm'))), 'brainstorm');
    assert.equal(installHarnessLinks(links).length, 2);
    fs.rmSync(links[0].target, { force: true });
    fs.writeFileSync(links[0].target, 'another owner');
    assert.throws(() => installHarnessLinks(links), /Pass -f to replace it/);
    assert.equal(installHarnessLinks(links, true).length, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('managed link installation preflights every target before replacing any target', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-link-preflight-'));
  const links = skillLinks(home, ['.agents']);
  try {
    fs.mkdirSync(path.dirname(links[1].target), { recursive: true });
    fs.writeFileSync(links[1].target, 'unmanaged conflict');
    assert.throws(() => installHarnessLinks(links), /Refusing to overwrite existing link/);
    assert.equal(fs.existsSync(links[0].target), false);
    assert.equal(fs.readFileSync(links[1].target, 'utf8'), 'unmanaged conflict');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('managed link installation validates sources before replacing forced targets', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-link-source-preflight-'));
  const target = path.join(home, 'target');
  const source = path.join(home, 'source');
  fs.writeFileSync(target, 'preserve me');
  fs.writeFileSync(source, 'available');
  try {
    assert.throws(
      () => installHarnessLinks([
        { source, target },
        { source: path.join(home, 'missing-source'), target: path.join(home, 'missing-target') },
      ], true),
      /Harness link source is missing/
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'preserve me');
    assert.equal(fs.existsSync(path.join(home, 'missing-target')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('OpenCode doctor runs debug config through its runtime boundary', () => {
  const home = '/tmp/square-opencode';
  const pluginUrl = pathToFileURL(opencodeExtensionLink(home).target).href;
  const loaded = verifyOpenCodeRuntime(home, () => {
    return { status: 0, stdout: JSON.stringify({ config: { plugin: [pluginUrl] } }), stderr: '' };
  });
  assert.equal(loaded, '✓ OpenCode debug config loaded');
  assert.match(
    verifyOpenCodeRuntime(home, () => ({ status: 0, stdout: JSON.stringify({ config: { plugin: [] } }), stderr: '' })),
    /plugin not loaded/
  );
  assert.match(
    verifyOpenCodeRuntime(home, () => ({ status: 1, stdout: '', stderr: 'extension failed' })),
    /OpenCode debug config failed: extension failed/
  );
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
    pi: { extensions: ['./extensions/square-pi.js'] },
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

test('package facade participant verbs persist through the shared application engine', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-api-'));
  const squarePath = path.join(dir, 'SQUARE.square');
  const squareState = {
    hardCap: null,
    preamble: [],
    warmup: ['warmup'],
    acts: [],
    runtime: emptyRuntimeState(0),
  };
  writeSquareFile(squarePath, squareState);
  const previousDisableWake = process.env.SQUARE_DISABLE_PASEO_WAKE;
  process.env.SQUARE_DISABLE_PASEO_WAKE = '1';
  try {
    const square = await Square.at({ path: squarePath });
    const alice = await square.join('Alice');
    await alice.express('one @Alice', { force: true });
    await alice.hold('pause');
    await alice.resume();
    await alice.done('complete');
    await square.close();
    const persisted = loadSquare(squarePath);
    assert.deepEqual(persisted.acts.map((item) => item.kind), ['join', 'say', 'hold', 'resume', 'done']);
    assert.deepEqual(persisted.acts.map((item) => item.index), [0, 1, 2, 3, 4]);
  } finally {
    if (previousDisableWake === undefined) delete process.env.SQUARE_DISABLE_PASEO_WAKE;
    else process.env.SQUARE_DISABLE_PASEO_WAKE = previousDisableWake;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed compact archive staging leaves the Square state unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-compact-stage-failure-'));
  const squarePath = path.join(dir, 'SQUARE.square');
  const squareState = {
    hardCap: null,
    preamble: [],
    warmup: ['warmup'],
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, index: 0 },
      { kind: 'say', actor: 'Alice', at: 2, body: 'keep history', index: 1 },
    ],
    runtime: emptyRuntimeState(2),
  };
  squareState.runtime.cursors.Alice = { consumedThroughIndex: 1, updatedAt: 2 };
  writeSquareFile(squarePath, squareState);
  const blockedParent = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blockedParent, 'file');
  try {
    await assert.rejects(
      compactSquare(squarePath, 1, path.join(blockedParent, 'archive.square')),
      /EEXIST|ENOTDIR|ENOENT/
    );
    assert.deepEqual(loadSquare(squarePath).acts.map((item) => item.index), [0, 1]);
    assert.deepEqual(loadSquare(squarePath).warmup, ['warmup']);
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
    assert.equal(fs.existsSync(path.join(installed.pluginRoot, 'SKILL.md')), true);
    const marketplace = JSON.parse(fs.readFileSync(path.join(installed.marketplaceRoot, '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.deepEqual(marketplace.owner, { name: 'Square' });
    assert.match((await doctorClaudePlugin(home, runClaude)).join('\n'), /✓ square@astrosheep installed/);
    await uninstallClaudePlugin(home, runClaude);
    assert.equal(fs.existsSync(installed.marketplaceRoot), false);
  } finally {
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

test('OpenCode admits pending attention after a tool without replacing its output', async () => {
  const item = piFixture('opencode-session');
  const previous = {
    registry: process.env.SQUARE_REGISTRY,
    presented: process.env.SQUARE_PRESENTED,
  };
  process.env.SQUARE_REGISTRY = item.registry;
  process.env.SQUARE_PRESENTED = item.presented;
  recordJoin('opencode-session', 'Bob', item.squarePath, { channel: 'opencode' });
  try {
    const hooks = await squareOpenCodePlugin({});

    const shell = { env: {} };
    await hooks['shell.env']({ sessionID: 'opencode-session', cwd: item.root }, shell);
    assert.equal(shell.env.OPENCODE_SESSION_ID, 'opencode-session');

    const rejected = {};
    Object.defineProperty(rejected, 'output', {
      get() { return 'first tool result'; },
      set() { throw new Error('host rejected context'); },
    });
    await hooks['tool.execute.after'](
      { sessionID: 'opencode-session', tool: 'read', callID: 'call-1', args: {} },
      rejected
    );

    const first = { title: 'read', output: 'second tool result', metadata: {} };
    await hooks['tool.execute.after'](
      { sessionID: 'opencode-session', tool: 'read', callID: 'call-2', args: {} },
      first
    );
    assert.match(first.output, /^second tool result/);
    assert.match(first.output, /hello @Bob/);

    const second = { title: 'read', output: 'third tool result', metadata: {} };
    await hooks['tool.execute.after'](
      { sessionID: 'opencode-session', tool: 'read', callID: 'call-3', args: {} },
      second
    );
    assert.equal(second.output, 'third tool result');
  } finally {
    if (previous.registry === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previous.registry;
    if (previous.presented === undefined) delete process.env.SQUARE_PRESENTED;
    else process.env.SQUARE_PRESENTED = previous.presented;
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('Pi inbox helpers expose stable notification identity and commands', () => {
  const inbox = sampleInbox();
  assert.equal(pendingInbox([...inbox, { name: 'Cara', squarePath: '/tmp/other.square', notifications: [] }]).length, 1);
  assert.deepEqual(inboxKeys(inbox), ['/tmp/SQUARE.square\u0000bob\u00007']);
  assert.match(renderPiInbox(inbox), /1 unread Square notification/);
  assert.match(renderPiInbox(inbox), /square:\/tmp\/SQUARE\.square#act\/7/);
  assert.match(renderPiInbox(inbox), /square --location '\/tmp\/SQUARE\.square' --as 'Bob' catch --now/);
});

function piFixture(sessionId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-extension-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const registry = path.join(root, 'sessions.ndjsonl');
  const presented = path.join(root, 'presented.ndjsonl');
  const runtime = { ...emptyRuntimeState(3), nextActIndex: 3 };
  const acts = [
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', index: 2 },
  ];
  writeSquareFile(squarePath, { hardCap: null, preamble: [], warmup: ['test'], acts, runtime });
  return { root, squarePath, registry, presented, sessionId };
}

async function withPiFixture(sessionId, fn) {
  const item = piFixture(sessionId);
  const previous = {
    registry: process.env.SQUARE_REGISTRY,
    presented: process.env.SQUARE_PRESENTED,
    piSession: process.env.SQUARE_PI_SESSION_ID,
  };
  process.env.SQUARE_REGISTRY = item.registry;
  process.env.SQUARE_PRESENTED = item.presented;
  delete process.env.SQUARE_PI_SESSION_ID;
  recordJoin(sessionId, 'Bob', item.squarePath, { channel: 'pi' });
  try {
    await fn(item);
  } finally {
    if (previous.registry === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previous.registry;
    if (previous.presented === undefined) delete process.env.SQUARE_PRESENTED;
    else process.env.SQUARE_PRESENTED = previous.presented;
    if (previous.piSession === undefined) delete process.env.SQUARE_PI_SESSION_ID;
    else process.env.SQUARE_PI_SESSION_ID = previous.piSession;
    fs.rmSync(item.root, { recursive: true, force: true });
  }
}

test('Pi presents each pending notification once to the current owner', async () => {
  await withPiFixture('pi-session-id', async () => {
    const handlers = new Map();
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
    };
    squarePiExtension(pi);
    const context = {
      sessionManager: { getSessionId: () => 'pi-session-id' },
      isIdle: () => false,
    };

    await handlers.get('session_start')({}, context);
    assert.equal(process.env.SQUARE_PI_SESSION_ID, 'pi-session-id');
    const first = await handlers.get('before_agent_start')({}, context);
    assert.equal(first.message.customType, 'square');
    assert.match(first.message.content, /catch --now/);
    assert.equal(await handlers.get('before_agent_start')({}, context), undefined);
    await handlers.get('session_shutdown')({}, context);
  });
});
