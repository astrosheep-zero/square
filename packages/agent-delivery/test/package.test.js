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

test('packed package installs, typechecks its capability API and delivers from a consumer outside Square', async (t) => {
  const consumer = await mkdtemp(join(sandbox, 'consumer-'))
  const packed = JSON.parse((await exec('npm', ['pack', '--json', '--pack-destination', consumer], {
    ...options, cwd: packageRoot,
  })).stdout)[0]
  for (const file of ['dist/index.js', 'dist/index.d.ts', 'dist/pi.js', 'README.md', 'LICENSE', 'VALIDATION.md']) {
    assert.ok(packed.files.some((entry) => entry.path === file), `missing ${file}`)
  }
  assert.ok(packed.files.every((file) => /^(dist\/|README\.md$|VALIDATION\.md$|LICENSE$|package\.json$)/.test(file.path)))
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(consumer, packed.filename)], {
    ...options, cwd: consumer,
  })
  const manifest = JSON.parse(await readFile(join(consumer, 'node_modules/@astrosheep/agent-delivery/package.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.exports), ['.', './pi-receiver'])
  assert.deepEqual(manifest.dependencies, { '@opencode/client': '2.0.20' })
  const lock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'))
  assert.equal(lock.packages['node_modules/@opencode/client'].version, '2.0.20')
  assert.ok(Object.keys(lock.packages).every((path) => !path.includes('@astrosheep/square')))

  await writeFile(join(consumer, 'consumer.mts'), `import { connect, DeliveryError, type Agent, type ClaudeAgent, type OpenCodeAgent, type PiAgent, type Receipt } from '@astrosheep/agent-delivery';
const opencodeAgent = await connect({ harness: 'opencode', sessionId: 'ses_example' });
const claudeAgent: ClaudeAgent = await connect({ harness: 'claude', sessionId: 'uuid', endpoint: '/tmp/explicit.sock' });
const piAgent: PiAgent = await connect({ harness: 'pi', sessionId: 'native-id', endpoint: '/private/p.sock' });
const agents: Agent[] = [opencodeAgent, claudeAgent, piAgent];
const keyed: OpenCodeAgent = opencodeAgent;
const admitted: Receipt = await keyed.steer('text', { id: 'msg_caller', timeoutMs: 1000 });
const queued: Receipt = await opencodeAgent.queue('text');
const written: Receipt = await claudeAgent.steer('text', { signal: AbortSignal.timeout(1000) });
const observed: Receipt = await piAgent.steer('text');
const proof: 'written' | 'admitted' | 'observed' = admitted.proof;
if (proof === 'admitted') { const id: string = admitted.id; console.log(id, queued.id, written.id, observed.id, agents.length); }
// @ts-expect-error Claude has no queue capability
await claudeAgent.queue('text');
// @ts-expect-error Claude has no caller idempotency id
await claudeAgent.steer('text', { id: 'msg_caller' });
// @ts-expect-error Pi has no caller idempotency id
await piAgent.steer('text', { id: 'msg_caller' });
// @ts-expect-error the public connect never takes an injected platform
await connect({ harness: 'claude', sessionId: 'uuid', endpoint: '/tmp/explicit.sock', platform: 'win32' });
// @ts-expect-error the public connect never takes an injected environment
await connect({ harness: 'claude', sessionId: 'uuid', endpoint: '/tmp/explicit.sock', env: {} });
const failure = new DeliveryError('rejected', false, 'msg_caller', 409);
const code: string = failure.code;
const delivered: boolean = failure.maybeDelivered;
if (failure instanceof Error) { const name: 'DeliveryError' = failure.name as 'DeliveryError'; console.log(code, delivered, name); }
import { createPiReceiver, sendPiMessage, type PiReceiverAPI } from '@astrosheep/agent-delivery/pi-receiver';
const pi = {} as PiReceiverAPI;
createPiReceiver(pi, { endpoint: '/private/p.sock' });
sendPiMessage(pi, { customType: 'caller', content: 'exact', display: false }, { deliverAs: 'nextTurn' });
`)
  await exec(process.execPath, [join(packageRoot, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023',
    '--typeRoots', join(packageRoot, 'node_modules/@types'), 'consumer.mts'], { ...options, cwd: consumer })

  const f = await fixture(t)
  await writeFile(join(consumer, 'consumer.mjs'), `import { connect, DeliveryError } from '@astrosheep/agent-delivery';
const agent = await connect({ harness: 'opencode', sessionId: '${sessionId}', endpoint: JSON.parse(process.argv[2]) });
try { console.log(JSON.stringify(await agent.steer('independent consumer', { id: 'msg_pack_consumer' }))); }
catch (error) { console.log(JSON.stringify({ name: error.name, code: error.code, maybeDelivered: error.maybeDelivered })); }`)
  const result = JSON.parse((await exec(process.execPath, ['consumer.mjs', JSON.stringify(f.endpoint)], { ...options, cwd: consumer })).stdout)
  assert.deepEqual(result, { id: 'msg_pack_consumer', proof: 'admitted' })
  const prompt = f.requests.find((request) => request.method === 'POST')
  assert.equal(prompt.auth, authorization)
  assert.deepEqual(prompt.body, { id: 'msg_pack_consumer', text: 'independent consumer', delivery: 'steer', resume: true })

  await writeFile(join(consumer, 'exports.mjs'), `const paths = ['@astrosheep/agent-delivery/claude-native', '@astrosheep/agent-delivery/opencode-native'];
const closed = [];
for (const path of paths) await import(path).then(() => closed.push(path + ':open'), (error) => closed.push(path + ':' + error.code));
console.log(JSON.stringify(closed));`)
  assert.deepEqual(JSON.parse((await exec(process.execPath, ['exports.mjs'], { ...options, cwd: consumer })).stdout),
    ['@astrosheep/agent-delivery/claude-native:ERR_PACKAGE_PATH_NOT_EXPORTED',
      '@astrosheep/agent-delivery/opencode-native:ERR_PACKAGE_PATH_NOT_EXPORTED'])

  // Block SDK module loading, not merely a request: the Claude capability must work
  // without initializing OpenCode's runtime graph.
  await writeFile(join(consumer, 'no-sdk.mjs'), `export async function resolve(specifier, context, next) {
if (specifier.includes('@opencode/') || context.parentURL?.includes('/@opencode/')) throw new Error('OpenCode SDK loaded');
return next(specifier, context);
}`)
  await writeFile(join(consumer, 'register.mjs'), `import { register } from 'node:module'; register('./no-sdk.mjs', import.meta.url);`)
  const root = await mkdtemp(join(sandbox, 'c-'))
  const endpoint = join(root, 'in.sock')
  const frames = []
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let bytes = ''
    socket.on('data', (part) => {
      bytes += part.toString('utf8')
      for (let index = bytes.indexOf('\n'); index >= 0; index = bytes.indexOf('\n')) {
        frames.push(JSON.parse(bytes.slice(0, index)))
        bytes = bytes.slice(index + 1)
      }
    })
  })
  server.listen(endpoint)
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  await writeFile(join(consumer, 'claude.mjs'), `import { connect } from '@astrosheep/agent-delivery';
const agent = await connect({ harness: 'claude', sessionId: 'external-claude', endpoint: ${JSON.stringify(endpoint)}, claudeHome: ${JSON.stringify(root)} });
console.log(JSON.stringify({ keys: Object.keys(agent), receipt: await agent.steer('packed 字') }));`)
  const claude = JSON.parse((await exec(process.execPath, ['--import', './register.mjs', 'claude.mjs'], { ...options, cwd: consumer })).stdout)
  assert.deepEqual(claude.keys, ['harness', 'sessionId', 'steer'])
  assert.equal(claude.receipt.proof, 'written')
  for (let i = 0; i < 200 && frames.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(frames, [{ msgV: 1, msg_id: claude.receipt.id, type: 'user', session_id: 'external-claude',
    message: { role: 'user', content: 'packed 字' }, priority: 'next' }])

  // Core types must remain suitable for later leaf adapters without SDK dependencies.
  const types = await readFile(join(packageRoot, 'dist/types.d.ts'), 'utf8')
  assert.ok(!types.includes('@opencode'))
  const indexTypes = await readFile(join(packageRoot, 'dist/index.d.ts'), 'utf8')
  assert.ok(!indexTypes.includes('@opencode'))
})
