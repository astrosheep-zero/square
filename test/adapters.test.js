import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import squareOpenCodePlugin from '../dist/opencode.js';
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
import { hasPresentedForOwner } from '../dist/presented.js';
import { formatActivityId } from '../dist/square-core.js';
import { Square } from '../dist/index.js';
import { executeTargetBatch } from '../dist/cli/harness-command.js';
import {
  installOpenCodePlugin,
  installHarnessLinks,
  uninstallOpenCodePlugin,
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
  const loaded = verifyOpenCodeRuntime(home, () => {
    return { status: 0, stdout: JSON.stringify({ config: { plugin: ['@astrosheep/square'] } }), stderr: '' };
  });
  assert.equal(loaded, '✓ OpenCode npm plugin loaded');
  assert.match(
    verifyOpenCodeRuntime(home, () => ({ status: 0, stdout: JSON.stringify({ config: { plugin: [] } }), stderr: '' })),
    /npm plugin not loaded/
  );
  assert.match(
    verifyOpenCodeRuntime(home, () => ({ status: 1, stdout: '', stderr: 'extension failed' })),
    /OpenCode debug config failed: extension failed/
  );
});

test('OpenCode installation delegates plugin ownership to OpenCode npm config', () => {
  const calls = [];
  const result = installOpenCodePlugin('/tmp/square-opencode', true, (_home, args) => {
    calls.push(args);
    return { status: 0, stdout: '', stderr: '' };
  });
  assert.deepEqual(calls, [['plugin', '@astrosheep/square', '--global', '--force']]);
  assert.deepEqual(result, ['@astrosheep/square']);
});

test('OpenCode uninstall removes only the Square npm plugin entry', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-opencode-uninstall-'));
  const config = path.join(home, '.config', 'opencode');
  fs.mkdirSync(config, { recursive: true });
  const configPath = path.join(config, 'opencode.jsonc');
  fs.writeFileSync(configPath, JSON.stringify({ plugin: ['@astrosheep/square@0.3.27', 'other-plugin'] }, null, 2));
  try {
    assert.deepEqual(uninstallOpenCodePlugin(home), ['@astrosheep/square']);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { plugin: ['other-plugin'] });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
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
  await writeSquareFile(squarePath, squareState);
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
    const persisted = await loadSquare(squarePath);
    assert.deepEqual(persisted.acts.map((item) => item.kind), ['join', 'say', 'hold', 'resume', 'done']);
    assert.deepEqual(persisted.acts.map((item) => item.index), [0, 1, 2, 3, 4]);
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
  const item = await piFixture('opencode-session');
  const previous = {
    registry: process.env.SQUARE_REGISTRY,
    presented: process.env.SQUARE_PRESENTED,
  };
  process.env.SQUARE_REGISTRY = item.registry;
  process.env.SQUARE_PRESENTED = item.presented;
  await recordJoin('opencode-session', 'Bob', item.squarePath, { channel: 'opencode' });
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
  assert.match(renderPiInbox(inbox), /✓ shown in full/);
  assert.doesNotMatch(renderPiInbox(inbox), /catch --now/);
});

async function piFixture(sessionId, pending = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-extension-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const registry = path.join(root, 'sessions.ndjsonl');
  const presented = path.join(root, 'presented.ndjsonl');
  const runtime = { ...emptyRuntimeState(pending ? 3 : 2), nextActIndex: pending ? 3 : 2 };
  const acts = [
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    ...(pending ? [{ kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', index: 2 }] : []),
  ];
  await writeSquareFile(squarePath, { hardCap: null, preamble: [], warmup: ['test'], acts, runtime });
  return { root, squarePath, registry, presented, sessionId };
}

async function withPiFixture(sessionId, fn, pending = true) {
  const item = await piFixture(sessionId, pending);
  const previous = {
    registry: process.env.SQUARE_REGISTRY,
    presented: process.env.SQUARE_PRESENTED,
    piSession: process.env.SQUARE_PI_SESSION_ID,
  };
  process.env.SQUARE_REGISTRY = item.registry;
  process.env.SQUARE_PRESENTED = item.presented;
  delete process.env.SQUARE_PI_SESSION_ID;
  await recordJoin(sessionId, 'Bob', item.squarePath, { channel: 'pi', ownerId: 'pi-owner' });
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

async function expressToPi(item, body) {
  const square = await Square.at({ path: item.squarePath });
  try {
    const alice = await square.join('Alice');
    const result = await alice.express(body);
    return Number(result.activity.id.slice('act/'.length));
  } finally {
    await square.close();
  }
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
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
    assert.match(first.message.content, /✓ shown in full/);
    assert.doesNotMatch(first.message.content, /catch --now/);
    assert.equal(await handlers.get('before_agent_start')({}, context), undefined);
    await handlers.get('session_shutdown')({}, context);
  });
});

test('Pi idle watcher wakes only after a new directed activity lands', async () => {
  await withPiFixture('pi-wake-session', async (item) => {
    const handlers = new Map();
    const sent = [];
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      async sendMessage(message, options) { sent.push({ message, options }); },
    };
    squarePiExtension(pi);
    const context = {
      sessionManager: { getSessionId: () => 'pi-wake-session' },
      cwd: '/tmp/no-public-square',
      isIdle: () => true,
    };
    await handlers.get('session_start')({}, context);
    try {
      assert.equal(sent.length, 0);
      const actIndex = await expressToPi(item, 'native wake @Bob');
      await waitUntil(() => sent.length === 1, 'Pi did not wake for new directed activity');
      await waitUntil(async () => await hasPresentedForOwner('pi-owner', item.squarePath, 'Bob', actIndex), 'Pi did not commit presentation');
      await waitUntil(async () => (await loadSquare(item.squarePath)).runtime.observations.Bob?.[formatActivityId(actIndex)]?.state === 'seen', 'Pi did not mark notification seen');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].message.customType, 'square');
      assert.equal(sent[0].options.triggerTurn, true);
      assert.match(sent[0].message.content, /source="square"/);
      assert.match(sent[0].message.content, /native wake @Bob/);
      assert.equal(await hasPresentedForOwner('pi-owner', item.squarePath, 'Bob', actIndex), true);
      assert.equal((await loadSquare(item.squarePath)).runtime.observations.Bob[formatActivityId(actIndex)].state, 'seen');
    } finally {
      await handlers.get('session_shutdown')({}, context);
    }
  }, false);
});

test('Pi keeps directed activity pending while busy and wakes after agent_settled', async () => {
  await withPiFixture('pi-busy-session', async (item) => {
    const handlers = new Map();
    const sent = [];
    let idle = false;
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      async sendMessage(message, options) { sent.push({ message, options }); },
    };
    const context = {
      sessionManager: { getSessionId: () => 'pi-busy-session' },
      cwd: '/tmp/no-public-square',
      isIdle: () => idle,
    };
    squarePiExtension(pi);
    await handlers.get('session_start')({}, context);
    try {
      await expressToPi(item, 'wait until settled @Bob');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(sent.length, 0);
      idle = true;
      await handlers.get('agent_settled')({}, context);
      await waitUntil(() => sent.length === 1, 'Pi did not wake after agent_settled');
      assert.match(sent[0].message.content, /wait until settled @Bob/);
    } finally {
      await handlers.get('session_shutdown')({}, context);
    }
  }, false);
});

test('Pi lifecycle hooks do not wait for a stuck native injection', async () => {
  await withPiFixture('pi-stuck-session', async () => {
    const handlers = new Map();
    let calls = 0;
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      sendMessage() {
        calls += 1;
        return new Promise(() => {});
      },
    };
    const context = {
      sessionManager: { getSessionId: () => 'pi-stuck-session' },
      cwd: '/tmp/no-public-square',
      isIdle: () => true,
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

test('Pi retries failed native injection without committing presented or seen', async () => {
  await withPiFixture('pi-retry-session', async (item) => {
    const handlers = new Map();
    let calls = 0;
    let releaseSecond;
    const secondSend = new Promise((resolve) => { releaseSecond = resolve; });
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      sendMessage() {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('native injection failed'));
        return secondSend;
      },
    };
    const context = {
      sessionManager: { getSessionId: () => 'pi-retry-session' },
      cwd: '/tmp/no-public-square',
      isIdle: () => true,
    };
    squarePiExtension(pi);
    await handlers.get('session_start')({}, context);
    let actIndex;
    try {
      actIndex = await expressToPi(item, 'retry me @Bob');
      await waitUntil(() => calls === 1, 'Pi did not attempt native injection');
      assert.equal(await hasPresentedForOwner('pi-owner', item.squarePath, 'Bob', actIndex), false);
      assert.equal((await loadSquare(item.squarePath)).runtime.observations.Bob?.[formatActivityId(actIndex)], undefined);

      await new Promise((resolve) => setTimeout(resolve, 100));
      const square = await Square.at({ path: item.squarePath });
      try {
        const alice = await square.join('Alice');
        await alice.listen('Bob');
      } finally {
        await square.close();
      }
      await waitUntil(() => calls === 2, 'Pi did not retry after the next Square change');
      releaseSecond();
      await waitUntil(
        async () => await hasPresentedForOwner('pi-owner', item.squarePath, 'Bob', actIndex),
        'successful retry did not commit presentation',
      );
      assert.equal((await loadSquare(item.squarePath)).runtime.observations.Bob[formatActivityId(actIndex)].state, 'seen');
    } finally {
      releaseSecond();
      await handlers.get('session_shutdown')({}, context);
    }
  }, false);
});

test('Pi presents a clipped body once without marking it seen', async () => {
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
      isIdle: () => true,
    };
    squarePiExtension(pi);
    await handlers.get('session_start')({}, context);
    try {
      const actIndex = await expressToPi(item, `${'x'.repeat(140)} @Bob`);
      await waitUntil(() => sent.length === 1, 'Pi did not present clipped activity');
      await waitUntil(async () => await hasPresentedForOwner('pi-owner', item.squarePath, 'Bob', actIndex), 'Pi did not commit clipped presentation');
      assert.match(sent[0].message.content, /… preview only/);
      assert.doesNotMatch(sent[0].message.content, /shown in full/);
      assert.equal(await hasPresentedForOwner('pi-owner', item.squarePath, 'Bob', actIndex), true);
      assert.equal((await loadSquare(item.squarePath)).runtime.observations.Bob?.[formatActivityId(actIndex)], undefined);

      const square = await Square.at({ path: item.squarePath });
      try {
        const alice = await square.join('Alice');
        await alice.listen('Bob');
      } finally {
        await square.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(sent.length, 1);
    } finally {
      await handlers.get('session_shutdown')({}, context);
    }
  }, false);
});
