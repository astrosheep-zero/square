import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import ts from 'typescript';

const root = path.join(import.meta.dirname, '..');
// This is a source fixture, not a dist copy: no Agora source is present at all.
const files = `artifact-store canonical-path channel channel-internal channel-metadata channel-artifact channel-delivery channel-domain channel-facade channel-ports channel-presentation channel-sqlite-schema channel-transport channel-values claude-transport codex-address codex-boundary-state codex-queue delivery-attempts delivery-deferral delivery-effects delivery-operations file-changes file-lock http-delivery message neutral owner participant-identity paseo-delivery paseo-state paseo-timeline receive search sqlite-channel sqlite-framing sqlite-transaction sqlite-values square-index square-location wake-sink wake-transports`.split(' ');

test('Channel compiles and operates with Agora source physically absent', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const file of files) fs.copyFileSync(path.join(root, `${file}.ts`), path.join(dir, `${file}.ts`));
  fs.cpSync(path.join(root, 'packages/agent-delivery/src'), path.join(dir, 'packages/agent-delivery/src'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(dir, 'consumer.ts'), `
    import { Channel, type MessageId } from './channel.js';
    import { DatabaseSync } from 'node:sqlite';
    const location = process.argv[2]!;
    const env = { SQUARE_INDEX: location + '.index', SQUARE_DISABLE_PASEO_WAKE: '1' };
    const channel = await Channel.create({ path: location, env });
    const alice = await channel.attach('Alice', { owner: 'owner-a' });
    const bob = await channel.attach('Bob', { owner: 'owner-b' });
    const sent = await alice.send({ to: 'Bob', body: 'hello' });
    const id: MessageId = sent.id;
    if (id !== 'msg/0' || (await channel.history()).messages[0]?.body !== 'hello') throw Error('history');
    if ((await bob.pending()).messages[0]?.id !== id || (await bob.ack([id])).consumed !== 1) throw Error('ack');
    await alice.send({ to: 'Bob', body: 'again' });
    if ((await bob.receive()).consumed !== 1) throw Error('receive');
    if (!await channel.detach('Bob', { owner: 'owner-b', generation: bob.generation })) throw Error('detach');
    const takeover = await channel.attach('Bob', { owner: 'owner-c', takeover: true });
    if (takeover.generation === bob.generation) throw Error('takeover');
    await channel.close();
    const reopened = await Channel.open({ path: location, env });
    if ((await reopened.listEndpoints()).length !== 2) throw Error('open');
    await reopened.close();
    const memory = Channel.inMemory({ env });
    const sender = await memory.attach('Sender', { owner: 'memory-sender' });
    const receiver = await memory.attach('Receiver', { owner: 'memory-receiver' });
    const first = await sender.send({ to: 'Receiver', body: 'in memory' });
    if ((await receiver.pending()).messages[0]?.id !== first.id) throw Error('memory pending');
    if ((await receiver.ack([first.id])).consumed !== 1) throw Error('memory ack');
    const second = await sender.send({ to: 'Receiver', body: 'receive in memory' });
    const received = await receiver.receive();
    if (received.consumed !== 1 || received.messages[0]?.id !== second.id) throw Error('memory receive');
    await memory.close();
    const db = new DatabaseSync(location, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name);
    if (tables.includes('activities') || tables.includes('participants') || !tables.includes('messages')) throw Error('schema');
    db.close();
  `);
  const compile = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--skipLibCheck', '--target', 'ESNext', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node', '--declaration', '--outDir', 'out', 'channel.ts', 'consumer.ts'], { cwd: dir, encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'out/channel.d.ts')));
  const entry = path.join(dir, 'out/channel.d.ts');
  const source = ts.createSourceFile(entry, fs.readFileSync(entry, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = [];
  for (const node of source.statements) {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause))
      names.push(...node.exportClause.elements.map(element => element.name.text));
    else if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isFunctionDeclaration(node))
      && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) names.push(node.name.text);
  }
  assert.deepEqual(names.sort(), `AckResult Channel ChannelCreateInput ChannelEndpoint ChannelEndpointHold ChannelEndpointSummary ChannelHistoryQuery ChannelHistoryResult ChannelMessage ChannelOpenInput ChannelPendingOptions ChannelPendingResult ChannelReceiveResult ChannelSendInput ChannelSendResult ChannelTruncate DeliveryDeferral HarnessSessionChannel MessageCursor MessageId MessageMetadata MessageQuery MessageSearch MetadataMatch OperationControl Owner ResolvedHarnessSession WakeAddress WakeTransportPort decodeHarnessOwner harnessOwner localUserOwner resolveHarnessSession`.split(' ').sort());
  for (const [name, expected] of [
    ['Channel', 'open create inMemory location attach reattach endpoint endpointsOf listEndpoints detach cancelDeliveries remove send history close'],
    ['ChannelEndpoint', 'name generation pending ack receive deferDelivery renewDeliveryDeferral releaseDeliveryDeferral send leave'],
  ]) {
    const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === name);
    assert.ok(declaration);
    const constructor = declaration.members.find(ts.isConstructorDeclaration);
    assert.ok(constructor?.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword));
    const members = declaration.members.filter(member => member.name && !ts.isPrivateIdentifier(member.name)).map(member => member.name.text);
    assert.deepEqual(members.sort(), expected.split(' ').sort());
  }
  const seen = new Set(), todo = [entry];
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const item of ts.preProcessFile(text, true, true).importedFiles) {
      if (item.fileName.startsWith('.')) todo.push(path.resolve(path.dirname(file), item.fileName.replace(/\.js$/, '.d.ts')));
    }
  }
  assert.deepEqual([...seen].map(file => path.relative(path.join(dir, 'out'), file)).sort(),
    ['channel.d.ts', 'channel-facade.d.ts', 'channel-metadata.d.ts', 'channel-transport.d.ts', 'channel-values.d.ts', 'message.d.ts', 'neutral.d.ts', 'owner.d.ts', 'participant-identity.d.ts'].sort());
  fs.writeFileSync(path.join(dir, 'public-consumer.ts'), fs.readFileSync(path.join(dir, 'consumer.ts'), 'utf8').replace("from './channel.js'", "from './out/channel.js'"));
  const check = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ESNext', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node', 'public-consumer.ts'], { cwd: dir, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const coverage = path.join(dir, 'coverage');
  const run = spawnSync(process.execPath, ['out/consumer.js', path.join(dir, 'fixture.square')], { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_V8_COVERAGE: coverage, SQUARE_HOST_LEDGER_ROOT: path.join(dir, 'ledger') } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const scripts = fs.readdirSync(coverage).flatMap(file => JSON.parse(fs.readFileSync(path.join(coverage, file), 'utf8')).result);
  const wiring = scripts.find(script => script.url.endsWith('/out/wake-transports.js'));
  const factory = wiring?.functions.find(fn => fn.functionName === 'createDefaultWakeTransport');
  assert.ok(factory?.ranges[0].count >= 2, 'create and open must execute the real default transport factory');
});
