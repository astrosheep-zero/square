import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.join(import.meta.dirname, '..');

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
}

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  return npmCli === undefined ? run('npm', args, options) : run(process.execPath, [npmCli, ...args], options);
}

test('packed ESM root typechecks, imports, and rejects deep imports', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'square-package-consumer-'));
  const packed = runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', fixture], {
    env: { ...process.env, npm_config_cache: path.join(fixture, 'npm-cache') },
  });
  assert.equal(packed.status, 0, packed.stderr);
  const [{ filename }] = JSON.parse(packed.stdout);
  const unpack = path.join(fixture, 'unpack');
  fs.mkdirSync(unpack);
  const extracted = run('tar', ['-xzf', path.join(fixture, filename), '-C', unpack]);
  assert.equal(extracted.status, 0, extracted.stderr);
  const packageRoot = path.join(fixture, 'node_modules', '@astrosheep', 'square');
  fs.mkdirSync(path.dirname(packageRoot), { recursive: true });
  fs.renameSync(path.join(unpack, 'package'), packageRoot);
  // This fixture unpacks without npm install. Supply declared dependencies and
  // required peers as the consumer/host would, without private copies in Square.
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies?.['@earendil-works/pi-tui'], undefined, 'Pi owns the TUI runtime');
  assert.equal(manifest.peerDependencies?.['@earendil-works/pi-tui'], '*', 'use the host-provided TUI without a version pin');
  const requiredPeers = Object.keys(manifest.peerDependencies ?? {})
    .filter((name) => !manifest.peerDependenciesMeta?.[name]?.optional);
  for (const name of [...Object.keys(manifest.dependencies ?? {}), ...requiredPeers]) {
    const target = path.join(fixture, 'node_modules', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.join(root, 'node_modules', name), target, 'dir');
  }
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(fixture, 'consumer.ts'), `
    import { Square, SquareError, type ActivityId, type Participant } from '@astrosheep/square';
    const square = Square.inMemory({ markdown: 'context' });
    const participant: Promise<Participant> = square.join('Alice');
    const id: ActivityId = 'act/1';
    const codes: SquareError['code'][] = ['invalid_args', 'invalid_name', 'unknown_participant', 'not_joined', 'already_joined', 'already_done', 'held', 'capped', 'throttled', 'bell_quota', 'behind', 'io', 'unavailable'];
    void participant; void id; void codes;
  `);
  const typecheck = run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--noEmit', '--strict', '--target', 'ESNext', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--types', 'node', '--typeRoots', path.join(root, 'node_modules', '@types'),
    path.join(fixture, 'consumer.ts'),
  ]);
  assert.equal(typecheck.status, 0, typecheck.stderr || typecheck.stdout || typecheck.error?.message);

  const runtime = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { Square } from '@astrosheep/square';
    const square = Square.inMemory({ markdown: 'context' });
    const alice = await square.join('Alice');
    if (alice.name !== 'Alice') process.exit(2);
    await square.close();
    // Pi renderer imports must resolve from the consumer's supplied TUI peer.
    const { default: extension } = await import('./node_modules/@astrosheep/square/plugins/pi/square-pi.js');
    const flags = [], handlers = new Map(), tools = [];
    extension({
      on(event, handler) { handlers.set(event, handler); },
      registerFlag(name) { flags.push(name); },
      registerTool(tool) { tools.push(tool); },
      getFlag() { return undefined; },
      sendMessage() { throw new Error('factory must not send'); },
    });
    if (flags.join() !== 'agent-delivery-socket') process.exit(3);
    if (!tools.some(tool => tool.name === 'square_express' && tool.parameters.properties.noMention)) process.exit(6);
    if (!handlers.has('session_start') || !handlers.has('session_shutdown')) process.exit(4);
    // The public OpenCode subpath stays stable after moving the implementation.
    const { default: plugin } = await import('@astrosheep/square/server');
    if (plugin.id !== 'square' || typeof plugin.setup !== 'function') process.exit(5);
  `], { cwd: fixture, encoding: 'utf8' });
  assert.equal(runtime.status, 0, runtime.stderr);

  const deep = spawnSync(process.execPath, ['--input-type=module', '-e', "import '@astrosheep/square/landing.js'"], {
    cwd: fixture,
    encoding: 'utf8',
  });
  assert.notEqual(deep.status, 0);
  assert.match(deep.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
});
