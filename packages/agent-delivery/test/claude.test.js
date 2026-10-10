import './sandbox-env.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import net from 'node:net'
import { once } from 'node:events'
import { connect, DeliveryError } from '../dist/index.js'
import { writeClaudeNative } from '../dist/claude-native.js'
import { sandbox } from './sandbox-env.js'

const deadline = () => Date.now() + 1_000
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

async function fixture(t, pause = false) {
  const root = await mkdtemp(join(sandbox, 'claude-'))
  const endpoint = join(root, 'in.sock')
  const home = join(root, 'home')
  const sockets = new Set()
  const frames = []
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    if (pause) { socket.pause(); return }
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
  return { endpoint, home, frames, server, root }
}

async function received(f, count) {
  for (let i = 0; i < 200 && f.frames.length < count; i++) await new Promise((done) => setTimeout(done, 5))
  assert.equal(f.frames.length, count)
}

const connectClaude = (f, extra = {}) => connect({ harness: 'claude', sessionId: 'explicit-session', endpoint: f.endpoint, claudeHome: f.home, ...extra })
const code = (expected) => (error) => {
  assert.ok(error instanceof DeliveryError, `expected DeliveryError, got ${error}`)
  assert.equal(error.code, expected)
  return true
}

test('connect exposes one capability: steer writes exactly one user frame and returns its message id', async (t) => {
  const f = await fixture(t)
  const agent = await connectClaude(f)
  assert.equal(Object.isFrozen(agent), true)
  assert.deepEqual(Object.keys(agent), ['harness', 'sessionId', 'steer'])
  assert.equal('queue' in agent, false)
  assert.equal(agent.harness, 'claude')
  assert.equal(agent.sessionId, 'explicit-session')

  const text = 'Unicode 字, newline\n"quoted" body'
  const receipt = await agent.steer(text)
  assert.equal(receipt.proof, 'written')
  assert.match(receipt.id, uuid)
  await received(f, 1)
  const { msg_id, ...body } = f.frames[0]
  assert.equal(msg_id, receipt.id)
  assert.deepEqual(body, { msgV: 1, type: 'user', session_id: 'explicit-session', message: { role: 'user', content: text }, priority: 'next' })

  const second = await agent.steer('again')
  await received(f, 2)
  assert.notEqual(second.id, receipt.id)
  assert.equal(f.frames[1].msg_id, second.id)
})

test('connect preconditions reject before any socket work', async (t) => {
  const f = await fixture(t)
  for (const extra of [{ endpoint: 'relative' }, { endpoint: '/tmp/\0invalid' }, { sessionId: ' ' },
    { timeoutMs: Infinity }, { timeoutMs: 0 }, { signal: {} }, { endpoint: 42 }]) {
    await assert.rejects(connectClaude(f, extra), code('invalid_arguments'))
  }
  if (process.platform !== 'win32') {
    // A named pipe is a Windows coordinate; this host has no platform injection to offer.
    await assert.rejects(connectClaude(f, { endpoint: '\\\\.\\pipe\\claude-inbox' }), code('invalid_arguments'))
  }
  await assert.rejects(connect({ harness: 'claude' }), code('invalid_arguments'))
  assert.equal(f.frames.length, 0)
})

test('send failures are DeliveryErrors: unavailable endpoint, invalid arguments, abort before write', async (t) => {
  const f = await fixture(t)
  const agent = await connectClaude(f)
  await assert.rejects(agent.steer(''), code('invalid_arguments'))
  await assert.rejects(agent.steer('text', { timeoutMs: NaN }), code('invalid_arguments'))
  await assert.rejects(agent.steer('text', { signal: {} }), code('invalid_arguments'))
  await assert.rejects(agent.steer('text', 'nonsense'), code('invalid_arguments'))
  const aborted = AbortSignal.abort('private reason')
  await assert.rejects(agent.steer('never sent', { signal: aborted }), (error) => {
    assert.equal(error.code, 'aborted')
    assert.equal(error.maybeDelivered, false)
    return true
  })
  assert.equal(f.frames.length, 0)

  const absent = await connectClaude(f, { endpoint: join(f.root, 'dead.sock') })
  await assert.rejects(absent.steer('nowhere'), (error) => {
    assert.equal(error.code, 'unavailable')
    assert.equal(error.maybeDelivered, false)
    assert.ok(!error.message.includes(f.root))
    return true
  })
  const file = join(f.root, 'not-a-socket')
  await writeFile(file, 'not a socket')
  await assert.rejects((await connectClaude(f, { endpoint: file })).steer('nowhere'), code('unavailable'))
  assert.equal(f.frames.length, 0)
})

test('native I/O distinguishes known-unsent from connected uncertainty and never retries stalled writes', async (t) => {
  const f = await fixture(t, true)
  const target = { sessionId: 'session', endpoint: f.endpoint, claudeHome: f.home, env: {} }
  for (const control of [{ deadline: NaN }, { deadline: Infinity }, { deadline: Date.now() + 2_147_483_648 }]) {
    assert.equal((await writeClaudeNative(target, 'body', control)).code, 'invalid_arguments')
  }
  assert.equal((await writeClaudeNative(target, 'body', { deadline: deadline(), signal: AbortSignal.abort() })).code, 'aborted')
  assert.equal((await writeClaudeNative(target, 'body', { deadline: Date.now() - 1 })).code, 'timeout')
  assert.equal((await writeClaudeNative({ ...target, endpoint: join(f.root, 'dead.sock') }, 'body', { deadline: deadline() })).outcome, 'unavailable')
  let connections = 0
  f.server.on('connection', () => connections++)
  // A paused real UDS receiver applies backpressure; the end callback cannot complete.
  const text = 'x'.repeat(4 * 1024 * 1024)
  const timeout = await writeClaudeNative(target, text, { deadline: Date.now() + 200 })
  assert.equal(timeout.outcome, 'unknown')
  assert.equal(timeout.code, 'timeout')
  const controller = new AbortController()
  const connected = once(f.server, 'connection')
  const sending = writeClaudeNative(target, text, { deadline: deadline(), signal: controller.signal })
  await connected
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort('private reason')
  const aborted = await sending
  assert.equal(aborted.outcome, 'unknown')
  assert.equal(aborted.code, 'aborted')
  assert.equal(connections, 2)
  assert.ok(!JSON.stringify([timeout, aborted]).includes(f.endpoint))
})
