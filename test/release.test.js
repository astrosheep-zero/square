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
  assert.deepEqual(packageJson.exports['./server'], {
    types: './dist/opencode.d.ts',
    default: './dist/opencode.js',
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
  assert.deepEqual(claudeHooks, { modules: ['./register.js'] });
  const claudeMod = fs.readFileSync(path.join(root, 'claude-plugin', 'hooks', 'register.js'), 'utf8');
  assert.match(claudeMod, /export function register\(on\)/);
  assert.match(claudeMod, /on\('session.receive'/);
  assert.match(claudeMod, /on\('session.append'/);
  assert.match(claudeMod, /on\('classic.SessionStart'/);
  assert.equal(claudePlugin.types, './types.d.ts');
  assert.equal(fs.existsSync(path.join(root, 'claude-plugin', claudePlugin.types)), true);
  assert.doesNotMatch(claudeMod, /node:|process\.env|PostToolBatch|claude-hook|MESSAGING_TOKEN/);
  assert.equal(fs.existsSync(path.join(root, 'dist', 'claude-hook.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'claude-native.ts')), false);
  assert.equal(fs.existsSync(path.join(root, 'dist', 'claude-native.js')), false);
  const leaf = path.join(root, 'dist', 'packages', 'agent-delivery', 'src', 'claude-native.js');
  assert.equal(fs.existsSync(leaf), true);
  assert.match(fs.readFileSync(path.join(root, 'dist', 'claude-delivery.js'), 'utf8'), /\.\/packages\/agent-delivery\/src\/claude-native\.js/);
  assert.doesNotMatch(fs.readFileSync(leaf, 'utf8'), /@opencode|square|\.square/);
  for (const module of ['opencode', 'claude', 'index']) assert.equal(fs.existsSync(path.join(path.dirname(leaf), `${module}.js`)), false);
  assert.equal(packageJson.dependencies['@astrosheep/agent-delivery'], undefined);
  assert.equal(packageJson.dependencies['@opencode/client'], undefined);
  assert.equal(claudeSkill, squareSkill);
  assert.match(squareSkill, /history.*only way to look back/i);
  assert.match(squareSkill, /Never read or parse the binary Square artifact directly/);
  assert.match(squareSkill, /history --before act\/12/);
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
test('packed root ships its SDK-free shared Claude transport and mod', async (t) => {
  const run = promisify(execFile);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'square-claude-pack-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const { stdout } = await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', fixture], { cwd: root, timeout: 60000 });
  const [packed] = JSON.parse(stdout);
  const leafPath = 'dist/packages/agent-delivery/src/claude-native.js';
  assert.ok(packed.files.some((entry) => entry.path === leafPath));
  assert.ok(packed.files.some((entry) => entry.path === leafPath.replace(/\.js$/, '.d.ts')));
  assert.ok(packed.files.some((entry) => entry.path === 'claude-plugin/hooks/register.js'));
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
  const received = once(server, 'frame');
  fs.writeFileSync(path.join(fixture, 'consumer.mjs'), `import {writeClaudeNative} from './package/${leafPath}';
const result = await writeClaudeNative({sessionId:'root-pack-target',endpoint:${JSON.stringify(endpoint)}},'packed root 字',{deadline:Date.now()+1000});
console.log(JSON.stringify(result));`);
  const sent = await run(process.execPath, [path.join(fixture, 'consumer.mjs')], { cwd: fixture, timeout: 5000 });
  assert.deepEqual(JSON.parse(sent.stdout), { outcome: 'written' });
  const [frame] = await received;
  assert.equal(frame.session_id, 'root-pack-target');
  assert.deepEqual(frame.message, { role: 'user', content: 'packed root 字' });
  assert.equal(frame.priority, 'next');
});
