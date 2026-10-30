import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { harnessTargets } from '../dist/harness.js';
import { SQUARE_IDENTITY } from '../dist/identity.js';

const root = path.join(import.meta.dirname, '..');

test('generated release artifacts expose the current identity and supported hosts', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const claudePlugin = JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'claude', '.claude-plugin', 'plugin.json'), 'utf8'));
  const claudeHooks = JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'claude', 'hooks', 'hooks.json'), 'utf8'));
  const claudeMcp = JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'claude', '.mcp.json'), 'utf8'));
  const codexPlugin = JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'codex', '.codex-plugin', 'plugin.json'), 'utf8'));
  const codexHooks = JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'codex', 'hooks', 'hooks.json'), 'utf8'));
  for (const event of ['SessionStart', 'SessionResume', 'UserPromptSubmit', 'SessionEnd', 'PostToolUse', 'Stop']) {
    assert.equal(codexHooks.hooks[event][0].hooks[0].command, 'square codex-hook');
  }
  const paseoPlugin = JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'paseo', 'paseo-plugin.json'), 'utf8'));
  const squareSkill = fs.readFileSync(path.join(root, 'skills', 'square', 'SKILL.md'), 'utf8');
  const claudeSkill = fs.readFileSync(path.join(root, 'plugins', 'claude', 'skills', 'square', 'SKILL.md'), 'utf8');

  assert.equal(packageJson.name, '@astrosheep/square');
  assert.equal(packageJson.dependencies['@getpaseo/client'], undefined);
  assert.equal(packageJson.dependencies.ws, undefined);
  assert.equal(packageJson.devDependencies['@getpaseo/client'], '0.11.2');
  assert.equal(packageJson.peerDependencies['@getpaseo/client'], '0.11.2');
  // Square compiles the shared package source, including its OpenCode leaf, so the
  // SDK must resolve at build time; it is never a runtime dependency of Square.
  assert.equal(packageJson.devDependencies['@opencode/client'], '2.0.20');
  assert.deepEqual(packageJson.exports['./channel'], {
    types: './dist/channel.d.ts',
    default: './dist/channel.js',
  });
  assert.deepEqual(packageJson.exports['./paseo'], {
    types: './dist/paseo.d.ts',
    default: './dist/paseo.js',
  });
  assert.deepEqual(packageJson.exports['./server'], {
    types: './dist/plugins/opencode/index.d.ts',
    default: './dist/plugins/opencode/index.js',
  });
  assert.equal(packageJson.peerDependenciesMeta['@getpaseo/client'].optional, true);
  assert.equal(packageJson.peerDependenciesMeta.ws.optional, true);
  assert.equal(SQUARE_IDENTITY.packageName, packageJson.name);
  assert.equal(SQUARE_IDENTITY.packageVersion, packageJson.version);
  assert.equal(packageJson.files.includes('plugins'), true);
  assert.equal(claudePlugin.version, packageJson.version);
  assert.equal(codexPlugin.version, packageJson.version);
  assert.equal(paseoPlugin.requirements.paseo, '>=0.11.2');
  assert.equal(fs.existsSync(path.join(root, 'skills', 'square', '.claude-plugin')), false);
  assert.equal(fs.existsSync(path.join(root, 'skills', 'square', 'hooks')), false);
  assert.deepEqual(claudeHooks, { modules: ['./register.js'] });
  assert.deepEqual(claudeMcp, { mcpServers: { square: {
    command: 'square', args: ['mcp-server'], env: { SQUARE_CLAUDE_MCP_CONTEXT: '1' },
  } } });
  const claudeMod = fs.readFileSync(path.join(root, 'plugins', 'claude', 'hooks', 'register.js'), 'utf8');
  assert.match(claudeMod, /export function register\(on\)/);
  assert.match(claudeMod, /on\('session.receive'/);
  assert.match(claudeMod, /on\('session.append'/);
  assert.match(claudeMod, /on\('classic.SessionStart'/);
  assert.equal(claudePlugin.types, './types.d.ts');
  assert.equal(fs.existsSync(path.join(root, 'plugins', 'claude', claudePlugin.types)), true);
  assert.doesNotMatch(claudeMod, /node:|process\.env|PostToolBatch|claude-hook|MESSAGING_TOKEN|tool\.register/);
  assert.equal(fs.existsSync(path.join(root, 'dist', 'claude-hook.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'claude-native.ts')), false);
  assert.equal(fs.existsSync(path.join(root, 'dist', 'claude-native.js')), false);
  const leaf = path.join(root, 'dist', 'packages', 'agent-delivery', 'src', 'claude-native.js');
  assert.equal(fs.existsSync(leaf), true);
  assert.doesNotMatch(fs.readFileSync(leaf, 'utf8'), /@opencode|square|\.square/);
  const entry = path.join(root, 'dist', 'packages', 'agent-delivery', 'src', 'index.js');
  assert.equal(fs.existsSync(entry), true);
  assert.match(fs.readFileSync(path.join(root, 'dist', 'claude-delivery.js'), 'utf8'), /\.\/packages\/agent-delivery\/src\/claude-native\.js/);
  assert.match(fs.readFileSync(path.join(root, 'dist', 'wake-sink.js'), 'utf8'), /\.\/packages\/agent-delivery\/src\/index\.js/);
  // Paseo wakes steer through the shared entry; the CLI spawn is gone for good.
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'dist', 'wake-sink.js'), 'utf8'), /spawnSync|SQUARE_PASEO_BIN/);
  assert.equal(packageJson.dependencies['@astrosheep/agent-delivery'], undefined);
  assert.equal(packageJson.dependencies['@opencode/client'], undefined);
  const openCodeLeaf = path.join(path.dirname(leaf), 'opencode-native.js');
  assert.equal(fs.existsSync(openCodeLeaf), true);
  assert.match(fs.readFileSync(path.join(root, 'dist', 'plugins', 'opencode', 'delivery.js'), 'utf8'), /\.\.\/\.\.\/packages\/agent-delivery\/src\/opencode-native\.js/);
  assert.doesNotMatch(fs.readFileSync(openCodeLeaf, 'utf8'), /@opencode|square|\.square/);
  const openCodePlugin = fs.readFileSync(path.join(root, 'dist', 'plugins', 'opencode', 'index.js'), 'utf8');
  assert.match(openCodePlugin, /async setup\(ctx\)/);
  assert.doesNotMatch(openCodePlugin, /tool\.execute\.after|shell\.env|presentPendingAtBoundary/);
  assert.equal(claudeSkill, squareSkill);
  assert.match(squareSkill, /history.*only way to look back/i);
  assert.match(squareSkill, /Never read or parse the binary Square artifact directly/);
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

// An actual root tarball, outside the checkout, must contain the same leaf that
// its coordinator imports. This is socket/pack evidence, not live scheduling.
test('packed root ships its plugin entries and SDK-free shared transports', async (t) => {
  const run = promisify(execFile);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'square-claude-pack-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const { stdout } = await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', fixture], { cwd: root, timeout: 60000 });
  const [packed] = JSON.parse(stdout);
  const leafPath = 'dist/packages/agent-delivery/src/claude-native.js';
  const entryPath = 'dist/packages/agent-delivery/src/index.js';
  assert.ok(packed.files.some((entry) => entry.path === leafPath));
  assert.ok(packed.files.some((entry) => entry.path === leafPath.replace(/\.js$/, '.d.ts')));
  assert.ok(packed.files.some((entry) => entry.path === entryPath));
  for (const file of [
    'plugins/claude/.mcp.json',
    'plugins/claude/hooks/register.js',
    'plugins/claude/.claude-plugin/plugin.json',
    'plugins/codex/.codex-plugin/plugin.json',
    'plugins/codex/hooks/hooks.json',
    'dist/codex-hook.js',
    'dist/channel.js',
    'dist/channel.d.ts',
    'dist/codex-queue.js',
    ...['codex', 'codex-cli', 'codex-hook', 'codex-boundary', 'codex-endpoint', 'codex-queue', 'file-lock']
      .flatMap((name) => ['js', 'd.ts'].map((ext) => `dist/packages/agent-delivery/src/${name}.${ext}`)),
    'plugins/pi/square-pi.js',
    'plugins/paseo/paseo-plugin.json',
    'plugins/paseo/index.client.tsx',
    'plugins/paseo/client/square-message.tsx',
    'dist/plugins/opencode/index.js',
    'dist/plugins/opencode/index.d.ts',
  ]) assert.ok(packed.files.some((entry) => entry.path === file), `missing packed plugin: ${file}`);
  assert.equal(packed.files.some((entry) => entry.path.includes('/node_modules/')), false);
  assert.equal(packed.files.some((entry) => /^(?:claude-plugin|codex-plugin|extensions)\//.test(entry.path)), false);
  assert.equal(packed.files.some((entry) => entry.path === 'dist/opencode.js' || entry.path === 'dist/opencode-delivery.js'), false);
  assert.equal(packed.files.some((entry) => entry.path === 'dist/claude-native.js' || entry.path === 'dist/claude-hook.js'), false);
  await run('tar', ['-xzf', path.join(fixture, packed.filename), '-C', fixture]);
  const shipped = path.join(fixture, 'package');
  assert.match(fs.readFileSync(path.join(shipped, 'dist/claude-delivery.js'), 'utf8'), /\.\/packages\/agent-delivery\/src\/claude-native\.js/);
  assert.equal(fs.readFileSync(path.join(shipped, leafPath), 'utf8'), fs.readFileSync(path.join(root, leafPath), 'utf8'));
  const endpoint = path.join(fixture, 'in.sock');
  const server = net.createServer((socket) => {
    let bytes = '';
    socket.on('data', (part) => { bytes += part.toString('utf8'); if (bytes.endsWith('\n')) server.emit('frame', JSON.parse(bytes)); });
  });
  server.listen(endpoint);
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  // Neither the packed public entry nor the internal OpenCode leaf may initialize the
  // OpenCode SDK; this guard fails the child process if either does.
  fs.writeFileSync(path.join(fixture, 'no-sdk.mjs'), `export async function resolve(specifier,context,next) {
if(specifier.includes('@opencode/') || context.parentURL?.includes('/@opencode/')) throw new Error('SDK initialized');
return next(specifier,context);
}`);
  fs.writeFileSync(path.join(fixture, 'register.mjs'), `import {register} from 'node:module';register('./no-sdk.mjs',import.meta.url);`);
  // Resolve the public subpath as an outside consumer, without any installed SDKs.
  fs.mkdirSync(path.join(fixture, 'node_modules', '@astrosheep'), { recursive: true });
  fs.symlinkSync(shipped, path.join(fixture, 'node_modules', '@astrosheep', 'square'), 'dir');
  fs.writeFileSync(path.join(fixture, 'channel.mjs'), `import {Channel, ChannelEndpoint, resolveHarnessSession, harnessOwner} from '@astrosheep/square/channel';
const channel = Channel.inMemory();
try {
  const recipient = await channel.attach('Worker', {owner:harnessOwner({channel:'pi',session:'packed'})});
  if (!(recipient instanceof ChannelEndpoint)) throw new Error('missing endpoint export');
  const sent = await channel.send({from:'Coordinator',to:'Worker',body:'packed channel'});
  console.log(JSON.stringify({sent,identity:resolveHarnessSession({PI_SESSION_ID:'packed'})}));
} finally {await channel.close();}`);
  const channel = JSON.parse((await run(process.execPath, ['--import', './register.mjs', 'channel.mjs'], { cwd: fixture, timeout: 5000 })).stdout);
  assert.deepEqual(channel.sent.to, ['Worker']);
  assert.equal(channel.sent.from, 'Coordinator');
  assert.equal(channel.identity.owner, 'pi:packed');
  const received = once(server, 'frame');
  fs.writeFileSync(path.join(fixture, 'consumer.mjs'), `import {connect} from './package/${entryPath}';
const agent = await connect({harness:'claude',sessionId:'root-pack-target',endpoint:${JSON.stringify(endpoint)},timeoutMs:1000});
console.log(JSON.stringify(await agent.steer('packed root 字')));`);
  const sent = await run(process.execPath, ['--import', './register.mjs', path.join(fixture, 'consumer.mjs')], { cwd: fixture, timeout: 5000 });
  const receipt = JSON.parse(sent.stdout);
  assert.equal(receipt.proof, 'written');
  const [frame] = await received;
  assert.equal(frame.msg_id, receipt.id);
  assert.equal(frame.session_id, 'root-pack-target');
  assert.deepEqual(frame.message, { role: 'user', content: 'packed root 字' });
  assert.equal(frame.priority, 'next');
  const nativePath = 'dist/packages/agent-delivery/src/opencode-native.js';
  assert.ok(packed.files.some((entry) => entry.path === nativePath));
  assert.ok(packed.files.some((entry) => entry.path === 'dist/plugins/opencode/delivery.js'));
  fs.writeFileSync(path.join(fixture, 'native.mjs'), `import {connectNative,sendNativeText} from './package/${nativePath}';
const session={async get({sessionID}){return {id:sessionID}},async prompt(input){return {id:input.id,sessionID:input.sessionID,type:'user',delivery:input.delivery,payload:{text:input.text},time:{created:Date.now()}}}};
const target=await connectNative({sessionId:'root-packed-native',session});
console.log(JSON.stringify(await sendNativeText(target,'packed native',{inputId:'msg_root_pack'})));`);
  const native = await run(process.execPath, ['--import', './register.mjs', 'native.mjs'], { cwd: fixture, timeout: 5000 });
  assert.equal(JSON.parse(native.stdout).state, 'accepted');

  assert.match(fs.readFileSync(path.join(shipped, 'dist/codex-hook.js'), 'utf8'), /\.\/packages\/agent-delivery\/src\/codex-hook\.js/);
  fs.writeFileSync(path.join(fixture, 'queue.cjs'), "require('node:fs').writeFileSync('cli.json',JSON.stringify(process.argv.slice(2)))");
  fs.writeFileSync(path.join(fixture, 'codex.mjs'), `import {connect} from './package/${entryPath}';
import {createCodexBoundaryStore,handleCodexHook} from './package/dist/packages/agent-delivery/src/codex-hook.js';
const boundaries=createCodexBoundaryStore('./codex-boundaries.json');
await handleCodexHook({session_id:'root-packed-codex',hook_event_name:'Stop'},{boundaries});
const eligible=await boundaries.queueEligible('root-packed-codex');
const hook=await handleCodexHook({session_id:'root-packed-codex',hook_event_name:'PostToolUse'},{boundaries,pull:async()=>'/packed Codex 字'});
const stillEligible=await boundaries.queueEligible('root-packed-codex');
await handleCodexHook({session_id:'root-packed-codex',hook_event_name:'Stop'},{boundaries});
const cli=await connect({harness:'codex',transport:'cli',sessionId:'root-packed-codex',boundaries,bin:process.execPath,args:['./queue.cjs'],codexHome:process.cwd()});
const receipt=await cli.queue('/packed CLI 字');
await handleCodexHook({session_id:'root-packed-codex',hook_event_name:'SessionEnd'},{boundaries});
let endCode;
try {await cli.queue('must not send');} catch(error) {endCode=error.code;}
console.log(JSON.stringify({eligible,hook,stillEligible,receipt,endCode}));`);
  const codex = JSON.parse((await run(process.execPath, ['--import', './register.mjs', 'codex.mjs'], { cwd: fixture, timeout: 5000 })).stdout);
  assert.equal(codex.eligible, true);
  assert.equal(codex.hook.hookSpecificOutput.additionalContext, '/packed Codex 字');
  assert.equal(codex.stillEligible, false);
  assert.equal(codex.receipt.proof, 'admitted');
  assert.equal(codex.endCode, 'session_inactive');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture, 'cli.json'), 'utf8')), ['queue', '--thread', 'root-packed-codex', '--message', '/packed CLI 字']);
});
