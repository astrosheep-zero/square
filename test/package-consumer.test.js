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
  fs.writeFileSync(path.join(fixture, 'attention-consumer.ts'), `
    import { resolveAudience, type AudienceInput, type AudienceRecipient, type AudienceRoute } from '@astrosheep/square/attention';
    const input: AudienceInput = { actor: 'a:one', recipients: ['b:two'] };
    const audience: readonly AudienceRecipient[] = resolveAudience(input);
    const route: AudienceRoute | undefined = audience[0]?.route;
    void route;
  `);
  fs.writeFileSync(path.join(fixture, 'consumer.ts'), `
    import { Square, SquareError, type Activity, type PerceivedActivity, type ActivityId, type Participant, type JoinResult, type HistoryResult } from '@astrosheep/square';
    const body = "test" + ":" + ('consumer');
    const square: Square = Square.inMemory({ markdown: 'context', wakeTransport: false });
    const opened: Promise<Square> = Square.at({ path: './test.square' });
    const built: Promise<Square> = Square.build({ path: './new.square', markdown: '', wakeTransport: false });
    const injected: Promise<Square> = Square.at({ path: './test.square', wakeTransport: { attempt: async () => ({ outcome: 'accepted' }) } });
    void opened; void built; void injected;
    const joined: Promise<JoinResult> = square.join('Alice', { owner: body });
    const webhook: Promise<JoinResult> = square.join('Bob', { owner: 'example:bob', wakeAddress: {
      kind: 'http', address: { url: 'https://example.com/square/wake', tokenEnv: 'BOB_WAKE_TOKEN' },
    } });
    void webhook;
    // @ts-expect-error caller identity is required on join, not the resource
    square.join('NoBody');
    // @ts-expect-error the resource never captures caller identity
    Square.inMemory({ markdown: 'context', body });
    // @ts-expect-error participant selection requires a name and caller identity
    square.participant('Alice');
    const participant: Promise<Participant> = joined.then(result => result.participant);
    const history: Promise<HistoryResult> = square.history({ limit: null });
    const id: ActivityId = 'act/1';
    const stream: AsyncIterable<Activity> = square.stream({ start: { kind: 'after', after: id } });
    const directed: AsyncIterable<PerceivedActivity> = square.stream({ recipient: 'Alice' });
    // @ts-expect-error stream cursors are activity ids, not raw indexes
    square.stream({ start: { kind: 'after', after: 1 } });
    // @ts-expect-error old join count is not a public fact
    joined.then(result => result.participantCount);
    // @ts-expect-error old stream fields are not public facts
    ({} as Activity).seq;
    const codes: SquareError['code'][] = ['invalid_args', 'invalid_name', 'unknown_participant', 'not_joined', 'already_joined', 'already_done', 'capped', 'throttled', 'bell_quota', 'behind', 'io', 'unavailable'];
    void participant; void history; void stream; void directed; void codes;
  `);
  const typecheck = run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--noEmit', '--strict', '--target', 'ESNext', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--types', 'node', '--typeRoots', path.join(root, 'node_modules', '@types'),
    path.join(fixture, 'consumer.ts'),
    path.join(fixture, 'attention-consumer.ts'),
  ]);
  assert.equal(typecheck.status, 0, typecheck.stderr || typecheck.stdout || typecheck.error?.message);

  const attention = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { resolveAudience } from '@astrosheep/square/attention';
    import assert from 'node:assert/strict';
    const first = resolveAudience({ actor: 'east:alice', recipients: ['east:bob', 'west:bob'], mentions: ['west:bob'] });
    const second = resolveAudience({ actor: 'west:bob', recipients: ['west:alice', 'east:alice'], reach: 'bell' });
    assert.deepEqual(first, [{ recipient: 'west:bob', route: 'mention' }]);
    assert.deepEqual(second, [{ recipient: 'west:alice', route: 'bell' }, { recipient: 'east:alice', route: 'bell' }]);
  `], { cwd: fixture, encoding: 'utf8' });
  assert.equal(attention.status, 0, attention.stderr);

  const runtime = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import * as api from '@astrosheep/square';
    const { Square } = api;
    if (Object.hasOwn(api, 'withDefault' + 'WakeTransport')) process.exit(7);
    if (['at', 'build', 'inMemory'].some(key => typeof Square[key] !== 'function')) process.exit(8);
    const body = "test" + ":" + ('consumer');
    const square = Square.inMemory({ markdown: 'context' });
    const { participant: alice } = await square.join('Alice', { owner: body });
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
