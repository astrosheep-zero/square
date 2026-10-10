import './sandbox-env.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { connectLocal, LocalEndpointError, parseLocalEndpoint, writeFrames } from '../dist/local-endpoint.js'
import { sandbox } from './sandbox-env.js'

const pipe = (name) => `\\\\.\\pipe\\${name}`
const untilClosed = (socket) => socket.closed ? Promise.resolve() : once(socket, 'close')
async function socketAt(t, name, onConnection) {
  const directory = await mkdtemp(join(sandbox, 'local-'))
  const path = join(directory, name)
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    onConnection?.(socket)
  })
  server.listen(path)
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((done) => server.close(done))
  })
  return path
}

test('named pipes canonicalize to Claude\'s spelling regardless of platform', () => {
  assert.deepEqual(parseLocalEndpoint(pipe('Claude-Inbox')), {
    kind: 'pipe', path: '\\\\.\\pipe\\claude-inbox', canonical: '\\\\.\\pipe\\claude-inbox',
  })
  for (const spelling of ['//./pipe/LOCAL/Mixed', '\\\\?\\pipe\\mixed', '//?/pipe/MIXED']) {
    assert.deepEqual(parseLocalEndpoint(spelling), {
      kind: 'pipe', path: '\\\\.\\pipe\\mixed', canonical: '\\\\.\\pipe\\mixed',
    })
  }
  for (const invalid of [pipe(''), pipe('a\\b'), '\\\\.\\pipe', '\\.\\pipe\\x', './pipe/x']) {
    assert.throws(() => parseLocalEndpoint(invalid))
  }
  // Only the pipe regex makes a pipe; anything else must be an absolute path.
  if (process.platform !== 'win32') assert.equal(parseLocalEndpoint('//./pipe/LOCAL/a/b').kind, 'unix')
})

test('unix endpoints must be absolute, NUL-free and within the platform sun_path limit', () => {
  assert.deepEqual(parseLocalEndpoint('/private/tmp/./a/../in.sock'), {
    kind: 'unix', path: '/private/tmp/in.sock', canonical: resolve('/private/tmp/./a/../in.sock'),
  })
  for (const invalid of ['in.sock', './in.sock', '', '/tmp/\0in.sock', undefined, 42]) {
    assert.throws(() => parseLocalEndpoint(invalid))
  }
  const limit = process.platform === 'darwin' ? 103 : process.platform === 'linux' ? 107 : undefined
  if (limit !== undefined) {
    const prefix = '/tmp/'
    assert.equal(parseLocalEndpoint(prefix + 'a'.repeat(limit - prefix.length)).kind, 'unix')
    assert.throws(() => parseLocalEndpoint(prefix + 'a'.repeat(limit - prefix.length + 1)))
  }
})

test('connecting is the existence check: absent endpoints are unavailable, not written', async (t) => {
  const directory = await mkdtemp(join(sandbox, 'local-'))
  await assert.rejects(connectLocal(parseLocalEndpoint(join(directory, 'dead.sock'))), (error) => {
    assert.ok(error instanceof LocalEndpointError)
    assert.equal(error.code, 'unavailable')
    assert.equal(error.maybeDelivered, false)
    return true
  })
  const controller = new AbortController()
  controller.abort('private reason')
  await assert.rejects(connectLocal(parseLocalEndpoint(join(directory, 'dead.sock')), { signal: controller.signal }), (error) => {
    assert.equal(error.code, 'aborted')
    assert.equal(error.maybeDelivered, false)
    return true
  })
  await assert.rejects(connectLocal(parseLocalEndpoint(join(directory, 'dead.sock')), { timeoutMs: 1_000 }), { code: 'unavailable' })
})

test('frames are LF-delimited JSON and any post-write failure is maybe-delivered', async (t) => {
  const frames = []
  const path = await socketAt(t, 'in.sock', (socket) => {
    let bytes = ''
    socket.on('data', (chunk) => {
      bytes += chunk.toString('utf8')
      if (bytes.endsWith('\n')) frames.push(bytes)
    })
  })
  const socket = await connectLocal(parseLocalEndpoint(path))
  await writeFrames(socket, [{ type: 'auth', token: 'a'.repeat(32) }, { type: 'user', message: { content: '字\nline' } }])
  for (let i = 0; i < 200 && frames.length === 0; i++) await new Promise((done) => setTimeout(done, 5))
  socket.destroy()
  await untilClosed(socket)
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0].split('\n').slice(0, 2).map((line) => JSON.parse(line)), [
    { type: 'auth', token: 'a'.repeat(32) },
    { type: 'user', message: { content: '字\nline' } },
  ])

  const closed = await socketAt(t, 'closed.sock', (peer) => peer.destroy())
  const dead = await connectLocal(parseLocalEndpoint(closed))
  await untilClosed(dead)
  await assert.rejects(writeFrames(dead, [{ a: 1 }]), (error) => {
    assert.ok(error instanceof LocalEndpointError)
    assert.equal(error.maybeDelivered, true)
    return true
  })
})
