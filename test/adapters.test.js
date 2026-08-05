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
import { emptyRuntimeState, loadSquare, renderSquareDoc, saveRuntimeSidecar } from '../dist/artifact.js';
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
import { recordJoin } from '../dist/registry.js';
import { done, express, hold, join, resume } from '../dist/index.js';
import { execute } from '../dist/square-application.js';
import {
  installHarnessLinks,
  opencodeExtensionLink,
  skillLinks,
  verifyOpenCodeRuntime,
} from '../dist/harness-links.js';

function sampleInbox() {
  return [{
    name: 'Bob',
    squarePath: '/tmp/square.md',
    notifications: [{ actIndex: 7, actor: 'Alice', at: 8, route: 'mention', body: 'hello @Bob' }],
  }];
}

function enabledPlugins(pluginId) { return JSON.stringify({ installed: [{ pluginId, installed: true, enabled: true }] }); }
function enabledClaudePlugins(pluginId) { return JSON.stringify([{ id: pluginId, version: SQUARE_IDENTITY.packageVersion, enabled: true, installPath: '/tmp/plugin' }]); }

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

test('managed link targets retain both skills and require force even for an existing link', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-links-'));
  const links = skillLinks(home, ['.agents']);
  try {
    assert.equal(links.length, 2);
    installHarnessLinks(links);
    assert.equal(path.basename(fs.realpathSync(path.join(home, '.agents', 'skills', 'square'))), 'square');
    assert.equal(path.basename(fs.realpathSync(path.join(home, '.agents', 'skills', 'brainstorm'))), 'brainstorm');
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

test('package participant intents persist through the shared application pipeline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-api-'));
  const squarePath = path.join(dir, 'square.md');
  const doc = {
    hardCap: null,
    preamble: [],
    warmup: ['warmup'],
    acts: [],
    runtime: emptyRuntimeState(0),
  };
  fs.writeFileSync(squarePath, renderSquareDoc(doc));
  saveRuntimeSidecar(squarePath, doc.runtime);
  const previousDisableWake = process.env.SQUARE_DISABLE_PASEO_WAKE;
  process.env.SQUARE_DISABLE_PASEO_WAKE = '1';
  try {
    await join(squarePath, 'Alice');
    await express(squarePath, 'Alice', 'one', { force: true });
    await hold(squarePath, 'Alice', 'pause');
    await resume(squarePath, 'Alice');
    await done(squarePath, 'Alice', 'complete');
    const persisted = loadSquare(squarePath);
    assert.deepEqual(persisted.acts.map((item) => item.kind), ['join', 'say', 'hold', 'resume', 'done']);
    assert.deepEqual(persisted.acts.map((item) => item.index), [0, 1, 2, 3, 4]);
  } finally {
    if (previousDisableWake === undefined) delete process.env.SQUARE_DISABLE_PASEO_WAKE;
    else process.env.SQUARE_DISABLE_PASEO_WAKE = previousDisableWake;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed compact archive staging leaves the Square document unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-compact-stage-failure-'));
  const squarePath = path.join(dir, 'square.md');
  const doc = {
    hardCap: null,
    preamble: [],
    warmup: ['warmup'],
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, body: '', index: 0 },
      { kind: 'say', actor: 'Alice', at: 2, body: 'keep history', index: 1 },
    ],
    runtime: emptyRuntimeState(2),
  };
  doc.runtime.cursors.Alice = { consumedThroughIndex: 1, updatedAt: 2 };
  fs.writeFileSync(squarePath, renderSquareDoc(doc));
  saveRuntimeSidecar(squarePath, doc.runtime);
  const blockedParent = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blockedParent, 'file');
  try {
    await assert.rejects(
      execute(squarePath, { type: 'compact', keep: 1, archivePath: path.join(blockedParent, 'archive.md') }),
      /EEXIST|ENOTDIR|ENOENT/
    );
    assert.deepEqual(loadSquare(squarePath).acts.map((item) => item.index), [0, 1]);
    await assert.rejects(
      execute(squarePath, {
        type: 'repair',
        doc: { ...doc, warmup: ['repaired warmup'] },
        quarantine: { path: path.join(blockedParent, 'quarantine.md'), blocks: ['discarded fragment'] },
      }),
      /EEXIST|ENOTDIR|ENOENT/
    );
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

test('OpenCode system injection and idle wake share the native owner model', async () => {
  const item = piFixture('opencode-session');
  const previous = {
    registry: process.env.SQUARE_REGISTRY,
    presented: process.env.SQUARE_PRESENTED,
  };
  process.env.SQUARE_REGISTRY = item.registry;
  process.env.SQUARE_PRESENTED = item.presented;
  recordJoin('opencode-session', 'Bob', item.squarePath, { channel: 'opencode' });
  try {
    const prompts = [];
    const hooks = await squareOpenCodePlugin({
      client: {
        session: {
          async promptAsync(request) { prompts.push(request); },
        },
      },
    });

    const shell = { env: {} };
    await hooks['shell.env']({ sessionID: 'opencode-session', cwd: item.root }, shell);
    assert.equal(shell.env.OPENCODE_SESSION_ID, 'opencode-session');

    await hooks.event({
      event: { type: 'session.idle', properties: { sessionID: 'opencode-session' } },
    });
    await hooks.event({
      event: { type: 'session.idle', properties: { sessionID: 'opencode-session' } },
    });
    assert.equal(prompts.length, 1);
    assert.doesNotMatch(prompts[0].body.parts[0].text, /hello @Bob/);

    const rejected = { system: { push() { throw new Error('host rejected context'); } } };
    await hooks['experimental.chat.system.transform']({ sessionID: 'opencode-session' }, rejected);

    const first = { system: [] };
    await hooks['experimental.chat.system.transform']({ sessionID: 'opencode-session' }, first);
    assert.equal(first.system.length, 1);
    assert.match(first.system[0], /hello @Bob/);

    const second = { system: [] };
    await hooks['experimental.chat.system.transform']({ sessionID: 'opencode-session' }, second);
    assert.deepEqual(second.system, []);
    await hooks.dispose();
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
  assert.equal(pendingInbox([...inbox, { name: 'Cara', squarePath: '/tmp/other.md', notifications: [] }]).length, 1);
  assert.deepEqual(inboxKeys(inbox), ['/tmp/square.md\u0000bob\u00007']);
  assert.match(renderPiInbox(inbox), /1 unread Square notification/);
  assert.match(renderPiInbox(inbox), /square:\/tmp\/square\.md#act_7/);
  assert.match(renderPiInbox(inbox), /square --square-path '\/tmp\/square\.md' --as 'Bob' catch --now/);
});

function piFixture(sessionId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-extension-'));
  const squarePath = path.join(root, 'square.md');
  const registry = path.join(root, 'sessions.ndjsonl');
  const presented = path.join(root, 'presented.ndjsonl');
  const runtime = { ...emptyRuntimeState(3), nextActIndex: 3 };
  const acts = [
    { kind: 'join', actor: 'Alice', at: 1, body: '', index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, body: '', index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', index: 2 },
  ];
  fs.writeFileSync(squarePath, renderSquareDoc({ hardCap: null, preamble: [], warmup: ['test'], acts, runtime }));
  saveRuntimeSidecar(squarePath, runtime);
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
