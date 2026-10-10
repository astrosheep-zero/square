// Explicit isolated actual-runtime proof, not part of the portable unit suite.
// Usage (after root npm run build): node packages/agent-delivery/test/pi-runtime.mjs <Pi1.1.0-package-root>
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { appendFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const exec = promisify(execFile)
const piRoot = resolve(process.argv[2] ?? '')
assert.equal(JSON.parse(await readFile(join(piRoot, 'package.json'), 'utf8')).version, '1.1.0')
assert.equal(process.platform, 'darwin')
const repo = resolve(import.meta.dirname, '../../..')
const root = await mkdtemp('/tmp/pi-shared-final-')
for (const dir of ['home', 'agent', 'cwd', 'ipc', 'sessions', 'consumer']) await mkdir(join(root, dir), { mode: 0o700 })
const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: root,
  XDG_CONFIG_HOME: join(root, 'home/config'), XDG_DATA_HOME: join(root, 'home/data'),
  XDG_STATE_HOME: join(root, 'home/state'), XDG_CACHE_HOME: join(root, 'home/cache'),
  PI_CODING_AGENT_DIR: join(root, 'agent'), PI_CODING_AGENT_SESSION_DIR: join(root, 'sessions'),
  SQUARE_REGISTRY: join(root, 'sessions.ndjsonl'), SQUARE_PRESENTED: join(root, 'presented.ndjsonl'),
  SQUARE_PARTICIPANT_NAME: 'PiFixture', npm_config_cache: join(root, 'npm-cache'), NO_COLOR: '1' }
const run = (command, args, cwd) => exec(command, args, { cwd, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
const deliveryPack = JSON.parse((await run('npm', ['pack', '--json', '--pack-destination', root], join(repo, 'packages/agent-delivery'))).stdout)[0]
const squarePack = JSON.parse((await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], repo)).stdout)[0]
assert.ok(squarePack.files.some((f) => f.path === 'dist/packages/agent-delivery/src/pi.js'))
assert.ok(squarePack.files.some((f) => f.path === 'dist/packages/agent-delivery/src/pi-send.js'))
assert.ok(!squarePack.files.some((f) => f.path === 'dist/packages/agent-delivery/src/opencode.js'))
const consumer = join(root, 'consumer')
await writeFile(join(consumer, 'package.json'), JSON.stringify({ type: 'module', private: true }))
await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(root, deliveryPack.filename), join(root, squarePack.filename)], consumer)
const packageRoot = join(consumer, 'node_modules/@astrosheep/agent-delivery')
const squareRoot = join(consumer, 'node_modules/@astrosheep/square')
const { connect, DeliveryError } = await import(pathToFileURL(join(packageRoot, 'dist/index.js')))
const { Square } = await import(pathToFileURL(join(squareRoot, 'dist/index.js')))
await mkdir(join(root, 'cwd/.square'))
const squarePath = join(root, 'cwd/.square/PUBLIC.square')
const square = await Square.build({ path: squarePath, markdown: 'Isolated Pi fixture', env: {} })
const alice = await square.join('Alice')
await writeFile(join(root, 'cwd/probe.txt'), 'isolated tool result')
const eventsFile = join(root, 'events.jsonl')
await writeFile(eventsFile, '')
const extension = `import squareExtension from ${JSON.stringify(pathToFileURL(join(squareRoot, 'extensions/square-pi.js')).href)};
import { appendFileSync } from 'node:fs';
export default function(pi) {
  squareExtension(pi);
  pi.registerProvider('validation-local', { baseUrl: process.env.LOCAL_PROVIDER_URL,
    api: 'openai-completions', apiKey: 'dummy-local-not-a-credential', models: [{ id: 'dummy', name: 'Dummy',
    reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  pi.on('message_end', (e,ctx) => appendFileSync(process.env.VALIDATION_EVENTS,
    JSON.stringify({message:e.message,sessionId:ctx.sessionManager.getSessionId()})+'\\n'));
}`
await writeFile(join(consumer, 'extension.js'), extension)
await writeFile(join(consumer, 'external-client.mjs'), `import {connect} from '@astrosheep/agent-delivery';
const {sessionId,endpoint,text}=JSON.parse(process.argv[2]);
const agent=await connect({harness:'pi',sessionId,endpoint});
console.log(JSON.stringify(await agent.steer(text)));`)
const checks = [], requests = [], records = [], held = new Map()
const log = (data) => appendFileSync(join(root, 'runtime.jsonl'), JSON.stringify(data) + '\n')
const texts = (item) => item.body.messages.filter((m) => m.role === 'user').flatMap((m) => typeof m.content === 'string'
  ? [m.content] : m.content.filter((c) => c.type === 'text').map((c) => c.text))
const contains = (item, text) => texts(item).includes(text)
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  assert.equal(req.url, '/v1/chat/completions')
  assert.equal(req.headers.authorization, 'Bearer dummy-local-not-a-credential')
  const item = { body: JSON.parse(raw), index: requests.length }; requests.push(item); log({ type: 'model', ...item })
  const marker = texts(item).findLast((text) => text.startsWith('BUSY_') || text.startsWith('HOLD_'))
  const first = marker && !requests.slice(0, -1).some((r) => contains(r, marker))
  const finish = () => {
    if (res.destroyed) return
    const tool = first && marker.startsWith('BUSY_')
    const delta = tool ? { role: 'assistant', content: null, tool_calls: [{ id: 'probe', type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ path: join(root, 'cwd/probe.txt') }) } }] }
      : { role: 'assistant', content: 'dummy-ok' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ id: 'dummy-' + item.index, object: 'chat.completion.chunk', created: 1,
      model: 'dummy', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  }
  if (first) held.set(marker, { finish, res }); else finish()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
env.LOCAL_PROVIDER_URL = `http://127.0.0.1:${server.address().port}/v1`
env.VALIDATION_EVENTS = eventsFile
const endpoint = join(root, 'ipc/p.sock')
const child = spawn(process.execPath, [join(piRoot, 'dist/bundle/cli.js'), '--offline', '--no-context-files', '--mode', 'rpc',
  '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '--tools', 'read',
  '--provider', 'validation-local', '--model', 'dummy', '-e', join(consumer, 'extension.js'), '--agent-delivery-socket', endpoint],
{ cwd: join(root, 'cwd'), env, stdio: ['pipe', 'pipe', 'pipe'] })
let buffer = '', stderr = ''
child.stderr.on('data', (c) => { stderr += c })
child.stdout.setEncoding('utf8')
child.stdout.on('data', (c) => {
  buffer += c
  while (buffer.includes('\n')) {
    const n = buffer.indexOf('\n'), line = buffer.slice(0, n); buffer = buffer.slice(n + 1)
    if (!line.trim()) continue
    const value = JSON.parse(line); records.push(value); log({ type: 'rpc', value })
  }
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function wait(predicate, label, timeout = 15_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await sleep(5) }
  throw new Error('Timed out: ' + label + '\n' + stderr)
}
let id = 0
async function rpc(type, fields = {}) {
  const command = 'c-' + ++id
  child.stdin.write(JSON.stringify({ id: command, type, ...fields }) + '\n')
  const response = await wait(() => records.find((r) => r.type === 'response' && r.id === command), type)
  assert.equal(response.success, true, JSON.stringify(response)); return response.data
}
const settled = () => records.filter((r) => r.type === 'agent_settled').length
const awaitSettled = (n) => wait(() => settled() > n, 'settled')
const messages = async () => (await readFile(eventsFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
const dispatched = async () => {
  // Native busy custom queues don't emit message_end yet. The active socket proves request was written;
  // allow one event-loop boundary for the local receiver, then the test releases its held HTTP request.
  await sleep(50)
}
try {
  const state = await rpc('get_state')
  await wait(() => existsSync(endpoint), 'socket')
  assert.equal((await stat(endpoint)).mode & 0o777, 0o600)
  const agent = await connect({ harness: 'pi', sessionId: state.sessionId, endpoint })
  await assert.rejects(connect({ harness: 'pi', sessionId: 'wrong', endpoint }),
    (e) => e instanceof DeliveryError && e.code === 'session_not_found')
  let n = settled()
  const exact = '/not-a-command\n  exact 多字节 🦈\u2028line\u2029paragraph\n'
  const external = JSON.parse((await run(process.execPath, [join(consumer, 'external-client.mjs'),
    JSON.stringify({ sessionId: state.sessionId, endpoint, text: exact })], consumer)).stdout)
  assert.equal(external.proof, 'observed')
  await awaitSettled(n)
  assert.ok(requests.some((r) => contains(r, exact)))
  assert.ok(!JSON.stringify(requests).includes(external.id))
  await writeFile(join(root, 'external-receipt.json'), JSON.stringify(external, null, 2))
  checks.push('fresh standalone tarball external process: exact idle steer, correlated message_end, metadata absent from model')
  n = settled(); assert.equal((await agent.queue('IDLE_QUEUE')).proof, 'observed')
  await awaitSettled(n); assert.ok(requests.some((r) => contains(r, 'IDLE_QUEUE')))
  checks.push('idle queue wakes model work')
  for (const delivery of ['steer', 'queue']) {
    const marker = 'BUSY_' + delivery; n = settled(); const from = requests.length
    await rpc('prompt', { message: marker }); await wait(() => held.has(marker), 'held request')
    let finished = false
    const sending = (delivery === 'steer' ? agent.steer('INJECT_' + delivery) : agent.queue('INJECT_' + delivery))
      .then((r) => { finished = true; return r })
    await dispatched(); assert.equal(finished, false)
    held.get(marker).finish()
    assert.equal((await sending).proof, 'observed'); await awaitSettled(n)
    const batch = requests.slice(from)
    assert.equal(contains(batch[0], 'INJECT_' + delivery), false)
    assert.ok(batch[1].body.messages.some((m) => m.role === 'tool'))
    if (delivery === 'steer') { assert.equal(batch.length, 2); assert.ok(contains(batch[1], 'INJECT_steer')) }
    else { assert.equal(batch.length, 3); assert.equal(contains(batch[1], 'INJECT_queue'), false); assert.ok(contains(batch[2], 'INJECT_queue')) }
    checks.push('busy ' + delivery + ': native placement at correct continuation boundary')
  }
  // The actual packed Square extension, not a stand-in direct caller, sends a directed activity.
  await wait(async () => (await square.participants()).some((p) => p.name === 'PiFixture'), 'automatic Square join')
  n = settled()
  await alice.express('real shared Square leaf @PiFixture')
  await awaitSettled(n)
  const nativeSquare = (await messages()).find((e) => e.message.customType === 'square' && e.message.content.includes('real shared Square leaf'))
  assert.ok(nativeSquare); assert.equal(nativeSquare.message.display, false)
  assert.ok(requests.some((r) => texts(r).some((text) => text.includes('real shared Square leaf'))))
  checks.push('one packed actual Square extension handles both shared native activity and optional external receiver')
  const pre = await agent.steer('NEVER_SENT', { signal: AbortSignal.abort() })
    .then(() => assert.fail('preabort must reject'), (error) => error)
  assert.ok(pre instanceof DeliveryError); assert.equal(pre.code, 'aborted'); assert.equal(pre.maybeDelivered, false)
  for (const kind of ['abort', 'timeout']) {
    const marker = 'HOLD_' + kind; n = settled()
    await rpc('prompt', { message: marker }); await wait(() => held.has(marker), marker)
    const controller = new AbortController()
    const pending = agent.steer('LATE_' + kind, { timeoutMs: kind === 'timeout' ? 70 : 5_000, signal: controller.signal })
      .then(() => assert.fail('late ' + kind + ' must reject'), (error) => error)
    await dispatched()
    if (kind === 'abort') controller.abort()
    const result = await pending; assert.ok(result instanceof DeliveryError)
    assert.equal(result.code, kind === 'abort' ? 'aborted' : 'timeout'); assert.equal(result.maybeDelivered, true)
    held.get(marker).finish(); await awaitSettled(n)
    assert.ok(requests.some((r) => contains(r, 'LATE_' + kind)))
  }
  checks.push('preabort never sends; postdispatch abort/timeout unknown without stopping model or retracting native text')
  await rpc('prompt', { message: 'HOLD_replace' }); await wait(() => held.has('HOLD_replace'), 'replacement hold')
  const outgoing = agent.steer('OUTGOING_MUST_NOT_CROSS').then(() => assert.fail('retired attempt must not observe'), (error) => error)
  await dispatched()
  await rpc('new_session')
  assert.ok((await outgoing) instanceof DeliveryError)
  const next = await rpc('get_state'); assert.notEqual(next.sessionId, state.sessionId)
  await assert.rejects(agent.steer('STALE'), (error) => error instanceof DeliveryError && error.code === 'rejected')
  const fresh = await connect({ harness: 'pi', sessionId: next.sessionId, endpoint })
  n = settled(); assert.equal((await fresh.steer('NEW_SESSION_TEXT')).proof, 'observed'); await awaitSettled(n)
  assert.ok(!requests.some((r) => contains(r, 'OUTGOING_MUST_NOT_CROSS')))
  checks.push('actual new_session retires waiting delivery, rebinds endpoint and rejects stale target')
  child.stdin.end(); await wait(() => child.exitCode !== null, 'shutdown')
  assert.equal(child.exitCode, 0, stderr); assert.equal(existsSync(endpoint), false)
  checks.push('orderly shutdown removes own endpoint')
  const evidence = { checks, passed: checks.length, requests: requests.length, host: process.platform + '/' + process.arch,
    node: process.version, version: '1.1.0', sessionIds: [state.sessionId, next.sessionId], root }
  await writeFile(join(root, 'checks.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
} catch (error) {
  console.error(error); console.error('Evidence root: ' + root); child.kill('SIGTERM'); process.exitCode = 1
} finally {
  await writeFile(join(root, 'stderr.log'), stderr)
  for (const item of held.values()) item.res.destroy()
  server.closeAllConnections(); await new Promise((r) => server.close(r))
  await square.close()
}
