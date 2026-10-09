import './sandbox-env.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import net from 'node:net'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { connectExisting, sendText, ConnectionError } from '../dist/index.js'
import { writeClaudeNative } from '../dist/claude-native.js'
import { sandbox } from './sandbox-env.js'

async function fixture(t, pause = false) {
  const root = await mkdtemp(join(sandbox, 'claude-'))
  const endpoint = join(root, 'in.sock')
  const sockets = new Set()
  const frames = []
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    if (pause) { socket.pause(); return }
    let bytes = Buffer.alloc(0)
    socket.on('data', (part) => {
      bytes = Buffer.concat([bytes, part])
      if (bytes.at(-1) === 10) { frames.push(bytes); server.emit('frame', bytes) }
    })
  })
  server.listen(endpoint)
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  return { endpoint, frames, server, root }
}
const deadline = () => Date.now() + 1000
const mac = { skip: process.platform !== 'darwin' }
const code = (expected) => (error) => error instanceof ConnectionError && error.code === expected

test('generic Claude sender and shared leaf send exact tokenless NDJSON once, never admission', mac, async (t) => {
  const f = await fixture(t)
  const target = await connectExisting({ harness: 'claude', sessionId: 'explicit-session', endpoint: f.endpoint })
  assert.deepEqual(Object.keys(target), ['harness', 'sessionId'])
  assert.ok(Object.isFrozen(target))
  const text = 'Unicode 字, newline\n"quoted" body'
  const received = once(f.server, 'frame')
  assert.deepEqual(await sendText(target, text), { harness: 'claude', sessionId: 'explicit-session', state: 'written' })
  await received
  const frame = JSON.parse(f.frames[0].toString('utf8'))
  const { msg_id, ...body } = frame
  assert.match(msg_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.deepEqual(body, { msgV: 1, type: 'user', session_id: 'explicit-session', message: { role: 'user', content: text }, priority: 'next' })
  assert.equal(f.frames[0].filter((byte) => byte === 10).length, 1)
  const receivedAgain = once(f.server, 'frame')
  assert.equal((await writeClaudeNative({ sessionId: target.sessionId, endpoint: f.endpoint }, text, { deadline: deadline() })).outcome, 'written')
  await receivedAgain
  assert.notEqual(JSON.parse(f.frames[1].toString()).msg_id, msg_id)
  assert.equal(f.frames.length, 2)
  for (const options of [{ delivery: 'queue' }, { inputId: 'msg_id' }, { inputId: '00000000-0000-4000-8000-000000000000' }]) {
    await assert.rejects(sendText(target, text, options), TypeError)
  }
  await assert.rejects(sendText({ ...target }, text), TypeError)
  await assert.rejects(sendText(target, ''), TypeError)
  assert.equal(f.frames.length, 2, 'unsupported options do not write')
  const aborted = AbortSignal.abort('private reason')
  assert.deepEqual(await sendText(target, text, { signal: aborted }), { harness: 'claude', sessionId: target.sessionId, state: 'unavailable', code: 'aborted' })
  await new Promise((resolve) => f.server.close(resolve))
  const result = await sendText(target, 'do not log this')
  assert.deepEqual(result, { harness: 'claude', sessionId: target.sessionId, state: 'unavailable', code: 'endpoint_unavailable' })
  assert.ok(!JSON.stringify(result).includes(f.endpoint))
})

test('connection checks explicit socket without sending; invalid, absent and non-socket coordinates fail closed', async (t) => {
  const f = await fixture(t)
  const options = { harness: 'claude', sessionId: 'session', endpoint: f.endpoint }
  for (const extra of [{ endpoint: 'relative' }, { endpoint: '/tmp/\0invalid' }, { sessionId: ' ' }, { timeoutMs: Infinity }, { signal: {} }]) {
    await assert.rejects(connectExisting({ ...options, ...extra }), code('invalid_arguments'))
  }
  if (process.platform !== 'darwin') {
    await assert.rejects(connectExisting(options), code('unsupported_platform'))
    return
  }
  await assert.rejects(connectExisting({ ...options, signal: AbortSignal.abort() }), code('aborted'))
  await assert.rejects(connectExisting({ ...options, endpoint: join(f.root, 'dead') }), code('service_unavailable'))
  const file = join(f.root, 'not-socket')
  await writeFile(file, 'not a socket')
  await assert.rejects(connectExisting({ ...options, endpoint: file }), code('service_unavailable'))
  await connectExisting(options)
  assert.equal(f.frames.length, 0)
})

test('filesystem connection waiting is cancellable/bounded with no late target or socket attempt', mac, async (t) => {
  const f = await fixture(t)
  const original = fs.promises.stat
  let resolveStat
  let calls = 0
  fs.promises.stat = () => { calls++; return new Promise((resolve) => { resolveStat = resolve }) }
  syncBuiltinESMExports()
  t.after(() => { fs.promises.stat = original; syncBuiltinESMExports() })
  const options = { harness: 'claude', sessionId: 'session', endpoint: f.endpoint }
  await assert.rejects(connectExisting({ ...options, signal: AbortSignal.abort() }), code('aborted'))
  assert.equal(calls, 0)
  await assert.rejects(connectExisting({ ...options, timeoutMs: 30 }), code('timeout'))
  resolveStat({ isSocket: () => true })
  const controller = new AbortController()
  const pending = connectExisting({ ...options, signal: controller.signal })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, code('aborted'))
  resolveStat({ isSocket: () => true })
  assert.equal(calls, 2)
  assert.equal(f.frames.length, 0)
})

test('native I/O distinguishes known-unsent from connected uncertainty and never retries stalled writes', async (t) => {
  const f = await fixture(t, true)
  const target = { sessionId: 'session', endpoint: f.endpoint }
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
