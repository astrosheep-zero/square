import './sandbox-env.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { DeliveryError } from '../dist/errors.js'
import { resolveClaudeToken } from '../dist/claude-auth.js'
import { writeClaudeNative } from '../dist/claude-native.js'
import { sandbox } from './sandbox-env.js'

const token = (fill) => fill.repeat(32)
const deadline = () => Date.now() + 1_000
const digest = (endpoint) => createHash('sha256').update(resolve(endpoint)).digest('hex')

async function inbox(t) {
  const root = await mkdtemp(join(sandbox, 'claude-'))
  const endpoint = join(root, 'in.sock')
  const frames = []
  const sockets = new Set()
  let connections = 0
  const server = net.createServer((socket) => {
    connections++
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
    await new Promise((done) => server.close(done))
  })
  return { endpoint, frames, get connections() { return connections } }
}

async function received(f, count) {
  for (let i = 0; i < 200 && f.frames.length < count; i++) await new Promise((done) => setTimeout(done, 5))
  assert.equal(f.frames.length, count)
}

async function claudeHome(t) {
  const home = await mkdtemp(join(sandbox, 'claude-home-'))
  await mkdir(join(home, 'sessions'), { recursive: true, mode: 0o700 })
  return home
}

async function peerKey(home, endpoint, pid, value, at = Date.now()) {
  const file = join(home, 'sessions', `${pid}.${digest(endpoint)}.key`)
  await writeFile(file, JSON.stringify({ peerToken: value }), { mode: 0o600 })
  await utimes(file, new Date(at), new Date(at))
  return file
}

test('an explicit token becomes the first frame, before the user frame', async (t) => {
  const f = await inbox(t)
  const messageId = '00000000-0000-4000-8000-000000000000'
  const result = await writeClaudeNative({ sessionId: 'target', endpoint: f.endpoint, token: token('a'), messageId }, 'body', { deadline: deadline() })
  assert.deepEqual(result, { outcome: 'written' })
  await received(f, 2)
  assert.deepEqual(f.frames, [
    { type: 'auth', token: token('a') },
    { msgV: 1, msg_id: messageId, type: 'user', session_id: 'target', message: { role: 'user', content: 'body' }, priority: 'next' },
  ])
})

test('a malformed explicit token fails as authentication before any socket work', async (t) => {
  const f = await inbox(t)
  const result = await writeClaudeNative({ sessionId: 'target', endpoint: f.endpoint, token: 'not-a-token' }, 'body', { deadline: deadline() })
  assert.equal(result.outcome, 'unavailable')
  assert.equal(result.code, 'authentication_failed')
  assert.equal(f.connections, 0)
})

test('the environment token is used only for its own canonical endpoint', async (t) => {
  const f = await inbox(t)
  const home = await claudeHome(t)
  const matched = await writeClaudeNative({ sessionId: 'target', endpoint: f.endpoint, claudeHome: home,
    env: { CLAUDE_CODE_MESSAGING_SOCKET: f.endpoint, CLAUDE_CODE_MESSAGING_TOKEN: token('b') } }, 'body', { deadline: deadline() })
  assert.equal(matched.outcome, 'written')
  await received(f, 2)
  assert.deepEqual(f.frames.map((frame) => frame.type), ['auth', 'user'])
  assert.equal(f.frames[0].token, token('b'))

  const other = await writeClaudeNative({ sessionId: 'target', endpoint: f.endpoint, claudeHome: home,
    env: { CLAUDE_CODE_MESSAGING_SOCKET: join(f.endpoint, 'other'), CLAUDE_CODE_MESSAGING_TOKEN: token('c') } }, 'body', { deadline: deadline() })
  assert.equal(other.outcome, 'written')
  await received(f, 3)
  assert.equal(f.frames[2].type, 'user')
  assert.equal(f.frames.length, 3)
})

test('canonical pipe spellings match across forms; a token is required on win32', async (t) => {
  const home = await claudeHome(t)
  const env = { CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\Claude-Inbox', CLAUDE_CODE_MESSAGING_TOKEN: token('d') }
  assert.equal(await resolveClaudeToken({ endpoint: '//?/pipe/LOCAL/claude-INBOX', claudeHome: home, env, platform: 'win32' }), token('d'))

  for (const spelling of ['\\\\.\\pipe\\Claude-Inbox', '//./pipe/claude-inbox']) {
    await assert.rejects(resolveClaudeToken({ endpoint: spelling, claudeHome: home, env: {}, platform: 'win32' }), (error) => {
      assert.ok(error instanceof DeliveryError)
      assert.equal(error.code, 'authentication_failed')
      assert.equal(error.maybeDelivered, false)
      assert.ok(!error.message.includes('pipe'))
      return true
    })
    const result = await writeClaudeNative({ sessionId: 'target', endpoint: spelling, claudeHome: home, env: {}, platform: 'win32' }, 'body', { deadline: deadline() })
    assert.equal(result.outcome, 'unavailable')
    assert.equal(result.code, 'authentication_failed')
  }
})

test('a peer key for this endpoint supplies the token; other endpoints and malformed keys do not', async (t) => {
  const f = await inbox(t)
  const home = await claudeHome(t)
  await writeFile(join(home, 'sessions', `999999999.${digest(f.endpoint)}.key`), '{not json')
  await peerKey(home, f.endpoint, 999_999_998, 'short')
  await peerKey(home, join(f.endpoint, 'other'), process.pid, token('e'))
  const empty = await writeClaudeNative({ sessionId: 'target', endpoint: f.endpoint, claudeHome: home, env: {} }, 'body', { deadline: deadline() })
  assert.equal(empty.outcome, 'written')
  await received(f, 1)
  assert.equal(f.frames[0].type, 'user')

  await peerKey(home, f.endpoint, process.pid, token('f'))
  const keyed = await writeClaudeNative({ sessionId: 'target', endpoint: f.endpoint, claudeHome: home, env: {} }, 'body', { deadline: deadline() })
  assert.equal(keyed.outcome, 'written')
  await received(f, 3)
  assert.deepEqual(f.frames.slice(1).map((frame) => frame.type), ['auth', 'user'])
  assert.equal(f.frames[1].token, token('f'))
})

test('the newest readable key wins, and a live pid outranks a newer dead one', async (t) => {
  const f = await inbox(t)
  const home = await claudeHome(t)
  await peerKey(home, f.endpoint, 999_999_999, token('1'), Date.now() - 60_000)
  await peerKey(home, f.endpoint, 999_999_998, token('2'), Date.now() - 30_000)
  assert.equal(await resolveClaudeToken({ endpoint: f.endpoint, claudeHome: home, env: {} }), token('2'))
  await peerKey(home, f.endpoint, process.pid, token('3'), Date.now() - 90_000)
  assert.equal(await resolveClaudeToken({ endpoint: f.endpoint, claudeHome: home, env: {} }), token('3'))
})

test('POSIX sends the user frame alone when nothing resolves a token', async (t) => {
  const f = await inbox(t)
  const home = await claudeHome(t)
  assert.equal(await resolveClaudeToken({ endpoint: f.endpoint, claudeHome: home, env: {} }), undefined)
  const result = await writeClaudeNative({ sessionId: 'target', endpoint: f.endpoint, claudeHome: home, env: {} }, 'body', { deadline: deadline() })
  assert.equal(result.outcome, 'written')
  await received(f, 1)
  assert.deepEqual(Object.keys(f.frames[0]).sort(), ['message', 'msgV', 'msg_id', 'priority', 'session_id', 'type'])
})
