import './sandbox-env.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import net from 'node:net'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { sandbox } from './sandbox-env.js'
import { fixture, sessionId, authorization } from './fixture.js'

const exec = promisify(execFile)
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const options = { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }

test('packed package installs, typechecks, discovers and sends from a consumer outside Square', async (t) => {
  const consumer = await mkdtemp(join(sandbox, 'consumer-'))
  const packed = JSON.parse((await exec('npm', ['pack', '--json', '--pack-destination', consumer], {
    ...options, cwd: packageRoot,
  })).stdout)[0]
  assert.ok(packed.files.some((file) => file.path === 'dist/index.js'))
  assert.ok(packed.files.some((file) => file.path === 'dist/index.d.ts'))
  assert.ok(packed.files.some((file) => file.path === 'dist/pi.js'))
  assert.ok(packed.files.some((file) => file.path === 'dist/claude-native.js'))
  assert.ok(packed.files.some((file) => file.path === 'dist/claude-native.d.ts'))
  assert.ok(packed.files.some((file) => file.path === 'README.md'))
  assert.ok(packed.files.some((file) => file.path === 'LICENSE'))
  assert.ok(packed.files.some((file) => file.path === 'VALIDATION.md'))
  assert.ok(packed.files.every((file) => /^(dist\/|README\.md$|VALIDATION\.md$|LICENSE$|package\.json$)/.test(file.path)))
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(consumer, packed.filename)], {
    ...options, cwd: consumer,
  })
  const manifest = JSON.parse(await readFile(join(consumer, 'node_modules/@astrosheep/agent-delivery/package.json'), 'utf8'))
  assert.deepEqual(manifest.dependencies, { '@opencode/client': '2.0.20' })
  const lock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'))
  assert.equal(lock.packages['node_modules/@opencode/client'].version, '2.0.20')
  assert.equal(lock.packages['node_modules/effect'].version, '4.0.0-rc.112')
  assert.equal(lock.packages['node_modules/solid-js'], undefined)
  assert.ok(Object.keys(lock.packages).every((path) => !path.includes('@astrosheep/square')))
  const f = await fixture(t)
  await f.register(join(process.env.XDG_STATE_HOME, 'opencode', 'service.json'))
  const program = `import { connectExisting, sendText } from '@astrosheep/agent-delivery';
const target = await connectExisting({ harness: 'opencode', sessionId: '${sessionId}' });
const result = await sendText(target, 'independent consumer', { delivery: 'queue', inputId: 'msg_pack_consumer' });
console.log(JSON.stringify(result));`
  await writeFile(join(consumer, 'consumer.mjs'), program)
  await writeFile(join(consumer, 'consumer.mts'), `import { connectExisting, sendText, type DeliveryResult } from '@astrosheep/agent-delivery';
const target = await connectExisting({ harness: 'opencode', sessionId: 'ses_example' });
const result: DeliveryResult = await sendText(target, 'text');
if (result.state === 'accepted') { const id: string = result.inboxId; console.log(id); }
import { createPiReceiver, sendPiMessage, type PiReceiverAPI } from '@astrosheep/agent-delivery/pi';
const pi = {} as PiReceiverAPI;
createPiReceiver(pi, { endpoint: '/private/p.sock' });
sendPiMessage(pi, { customType: 'caller', content: 'exact', display: false }, { deliverAs: 'nextTurn' });
const piTarget = await connectExisting({ harness: 'pi', sessionId: 'native-id', endpoint: '/private/p.sock' });
const piResult = await sendText(piTarget, 'exact', { delivery: 'queue' });
if (piResult.state === 'observed') { const evidence: 'message_end' = piResult.evidence; console.log(evidence); }
// @ts-expect-error Pi does not support caller input IDs
await sendText(piTarget, 'text', { inputId: 'caller' });
const claude = await connectExisting({ harness: 'claude', sessionId: 'uuid', endpoint: '/tmp/explicit.sock' });
const written = await sendText(claude, 'text', { delivery: 'steer' });
if (written.state === 'written') { const h: 'claude' = written.harness; }
// @ts-expect-error Claude has no queue mode
await sendText(claude, 'text', { delivery: 'queue' });
// @ts-expect-error Claude has no caller input ID/reconciliation
await sendText(claude, 'text', { inputId: 'msg_fake' });
// @ts-expect-error Claude socket writes cannot be accepted inbox receipts
const accepted: 'accepted' = written.state;
import { writeClaudeNative, type ClaudeNativeControl } from '@astrosheep/agent-delivery/claude-native';
const control: ClaudeNativeControl = { deadline: Date.now() + 1000 };
await writeClaudeNative({ sessionId: 'uuid', endpoint: '/tmp/explicit.sock' }, 'text', control);
`)
  await exec(process.execPath, [join(packageRoot, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023',
    '--typeRoots', join(packageRoot, 'node_modules/@types'), 'consumer.mts'], { ...options, cwd: consumer })
  const result = JSON.parse((await exec(process.execPath, ['consumer.mjs'], { ...options, cwd: consumer })).stdout)
  assert.deepEqual(result, { harness: 'opencode', sessionId, inputId: 'msg_pack_consumer',
    state: 'accepted', inboxId: 'msg_pack_consumer', delivery: 'queue' })
  const prompt = f.requests.find((request) => request.method === 'POST')
  assert.equal(prompt.auth, authorization)
  assert.deepEqual(prompt.body, { id: 'msg_pack_consumer', text: 'independent consumer', delivery: 'queue', resume: true })
  // Block SDK module loading, not merely a request: both leaf and generic Claude
  // imports must work without initializing OpenCode's runtime graph.
  await writeFile(join(consumer, 'no-sdk.mjs'), `export async function resolve(specifier, context, next) {
if (specifier.includes('@opencode/') || context.parentURL?.includes('/@opencode/')) throw new Error('OpenCode SDK loaded');
return next(specifier, context);
}`)
  await writeFile(join(consumer, 'register.mjs'), `import { register } from 'node:module'; register('./no-sdk.mjs', import.meta.url);`)
  const endpoint = join(consumer, 'in.sock')
  const frames = []
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let bytes = ''
    socket.on('data', (part) => { bytes += part.toString('utf8'); if (bytes.endsWith('\n')) frames.push(JSON.parse(bytes)) })
  })
  server.listen(endpoint)
  await once(server, 'listening')
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)) })
  await writeFile(join(consumer, 'claude.mjs'), `import { writeClaudeNative } from '@astrosheep/agent-delivery/claude-native';
import { connectExisting, sendText } from '@astrosheep/agent-delivery';
const target = { sessionId: 'external-claude', endpoint: ${JSON.stringify(endpoint)} };
const leaf = await writeClaudeNative(target, 'packed leaf 字', { deadline: Date.now() + 1000 });
let generic;
if (process.platform === 'darwin') {
  const handle = await connectExisting({ harness: 'claude', ...target });
  generic = await sendText(handle, 'packed generic', { delivery: 'steer' });
}
console.log(JSON.stringify({ leaf, generic }));`)
  const claude = JSON.parse((await exec(process.execPath, ['--import', './register.mjs', 'claude.mjs'], { ...options, cwd: consumer })).stdout)
  assert.equal(claude.leaf.outcome, 'written')
  assert.equal(frames[0].message.content, 'packed leaf 字')
  if (process.platform === 'darwin') {
    assert.deepEqual(claude.generic, { harness: 'claude', sessionId: 'external-claude', state: 'written' })
    assert.equal(frames[1].message.content, 'packed generic')
  }
  assert.ok(frames.every((frame) => frame.session_id === 'external-claude' && frame.priority === 'next'))
  // Core types must remain suitable for later leaf adapters without SDK dependencies.
  const types = await readFile(join(packageRoot, 'dist/types.d.ts'), 'utf8')
  assert.ok(!types.includes('@opencode'))
})
