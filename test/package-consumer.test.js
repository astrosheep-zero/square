import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
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

test('packed ESM and types expose the real Square and delivery ledger APIs', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'square-package-consumer-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
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
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies?.['@earendil-works/pi-tui'], undefined);
  assert.equal(manifest.peerDependencies?.['@earendil-works/pi-tui'], '*');
  const requiredPeers = Object.keys(manifest.peerDependencies ?? {})
    .filter(name => !manifest.peerDependenciesMeta?.[name]?.optional);
  for (const name of [...Object.keys(manifest.dependencies ?? {}), ...requiredPeers]) {
    const target = path.join(fixture, 'node_modules', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.join(root, 'node_modules', name), target, 'dir');
  }
  assert.equal(fs.existsSync(path.join(fixture, 'node_modules', '@getpaseo', 'client')), false);
  assert.throws(() => createRequire(path.join(packageRoot, 'dist/packages/agent-delivery/src/paseo-native.js'))
    .resolve('@getpaseo/client/internal/daemon-client'), { code: 'MODULE_NOT_FOUND' });
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(fixture, 'consumer.ts'), `
    import { Square, requireJoinName, DeliveryLedger as RootLedger, type ActivityId, type Participant,
      type ActivityQuery, type MetadataMatch, type SendResult } from '@astrosheep/square';
    import { DeliveryLedger, type DeliveryCard, type DeliveryRoute } from '@astrosheep/square/delivery-ledger';
    import { resolveAudience, type AudienceInput } from '@astrosheep/square/attention';
    const same: typeof DeliveryLedger = RootLedger;
    const route: DeliveryRoute = {kind:'native', address:{session:'abc'}};
    const match: MetadataMatch = {fields:[{path:['job','id'],equals:7}]};
    const query: ActivityQuery = {at:['act/1'],match};
    const audience: AudienceInput = {actor:'alice',recipients:['bob']};
    const id: ActivityId = 'act/1';
    const name: string = requireJoinName('cli/name');
    async function use(participant: Participant, ledger: DeliveryLedger) {
      const pending = await participant.pending(query);
      await participant.ack(pending.activities.map(item => item.id));
      await participant.ack({from:'sender',match,future:'exact'});
      const cards: readonly DeliveryCard[] = await ledger.pending('owner', {generation:'generation'});
      return cards;
    }
    async function send(square: ReturnType<typeof Square.inMemory>): Promise<SendResult> {
      await square.participants({local:true,observe:true});
      return square.send({from:'sender',to:'alice',body:'notice',metadata:{job:{id:7}}});
    }
    void same; void route; void audience; void id; void name; void use; void send; void resolveAudience;
  `);
  const typecheck = run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--outDir', path.join(fixture, 'compiled'), '--strict', '--target', 'ESNext', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--types', 'node', '--typeRoots', path.join(root, 'node_modules', '@types'),
    path.join(fixture, 'consumer.ts')]);
  assert.equal(typecheck.status, 0, typecheck.stderr || typecheck.stdout || typecheck.error?.message);

  const runtime = run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {Square, requireJoinName, DeliveryLedger as RootLedger} from '@astrosheep/square';
    import {DeliveryLedger} from '@astrosheep/square/delivery-ledger';
    import {resolveAudience} from '@astrosheep/square/attention';
    assert.equal(RootLedger, DeliveryLedger);
    assert.equal(requireJoinName('cli/name'), 'cli/name');
    assert.throws(() => requireJoinName('bad name'));
    assert.deepEqual(resolveAudience({actor:'alice',recipients:['bob'],mentions:['bob']}), [{recipient:'bob',route:'mention'}]);
    const ledger = await DeliveryLedger.open({location:${JSON.stringify(path.join(fixture, 'delivery.sqlite'))}});
    try {
      const session = await ledger.attach({owner:'test:owner',expectedGeneration:null,routes:[]});
      assert.ok(session);
      assert.equal((await ledger.post({owner:'test:owner',key:'producer:1',text:'hello'})).status, 'posted');
      const claim = await ledger.claimPresentation('test:owner',{generation:session.generation,budgetChars:1000});
      assert.equal(claim.cards[0].text,'hello');
      assert.equal(await claim.settle('presented'),true);
      assert.equal((await ledger.receipts('test:owner')).length,1);
    } finally { await ledger.close(); }
    const square = Square.inMemory({markdown:'context'});
    try {
      const {participant} = await square.join('Alice',{owner:'test:consumer'});
      assert.equal(participant.name,'Alice');
      assert.equal((await square.participants({local:true})).participants[0].name,'Alice');
    }
    finally { await square.close(); }
    const {default: extension} = await import('./node_modules/@astrosheep/square/plugins/pi/square-pi.js');
    const flags=[], handlers=new Map(), tools=[];
    extension({on(event,handler){handlers.set(event,handler)},registerFlag(name){flags.push(name)},
      registerTool(tool){tools.push(tool)},getFlag(){return undefined},sendMessage(){throw Error('unexpected send')}});
    assert.deepEqual(flags,['agent-delivery-socket']);
    assert.ok(tools.some(tool => tool.name === 'square_express' && tool.parameters.properties.noMention));
    assert.ok(handlers.has('session_start') && handlers.has('session_shutdown'));
    const {default: v2} = await import('@astrosheep/square/server');
    const v1 = await import('@astrosheep/square/opencode-v1');
    assert.equal(v2.id,'square'); assert.equal(typeof v2.setup,'function');
    assert.equal(typeof v1.default,'function');
  `], { cwd: fixture });
  assert.equal(runtime.status, 0, runtime.stderr);
  for (const subpath of ['landing.js', 'channel', 'delivery']) {
    const deep = run(process.execPath, ['--input-type=module', '-e', `import '@astrosheep/square/${subpath}'`], { cwd: fixture });
    assert.notEqual(deep.status, 0);
    assert.match(deep.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
  }

  // The shipped example is executable from outside the checkout, not just present in the tarball.
  const examplePath = path.join(fixture, 'symmetric-domains.mjs');
  fs.copyFileSync(path.join(packageRoot, 'examples', 'symmetric-domains.mjs'), examplePath);
  const example = run(process.execPath, [examplePath], { cwd: fixture });
  assert.equal(example.status, 0, example.stderr);
  const result = JSON.parse(example.stdout);
  assert.match(result.notice.id, /^notice\/\d+$/);
  assert.equal(result.notice.from, 'Coordinator');
  assert.deepEqual(result.notice.metadata, { job: { id: 7 } });
  assert.equal(result.presented.length, 1);
  assert.match(result.presented[0], /The work is ready\./);
  assert.equal(result.receipts.length, 1);
});
