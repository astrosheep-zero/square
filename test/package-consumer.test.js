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

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

test('packed ESM root typechecks, imports, and rejects deep imports', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'square-package-consumer-'));
  const packed = run(npmCommand, ['pack', '--json', '--ignore-scripts', '--pack-destination', fixture], {
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
  `], { cwd: fixture, encoding: 'utf8' });
  assert.equal(runtime.status, 0, runtime.stderr);

  const deep = spawnSync(process.execPath, ['--input-type=module', '-e', "import '@astrosheep/square/landing.js'"], {
    cwd: fixture,
    encoding: 'utf8',
  });
  assert.notEqual(deep.status, 0);
  assert.match(deep.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
});
