import './sandbox-env.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { connectCodex, sendCodexText } from '../dist/codex.js'
import { ConnectionError } from '../dist/errors.js'
import { sandbox } from './sandbox-env.js'

// Never discover this machine's Codex socket, even with inherited CODEX_HOME.
process.env.CODEX_HOME = join(sandbox, 'codex-does-not-exist')
const exec = promisify(execFile)
const sessionId = 'thread-fixture'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const initializeResult = { userAgent: 'codex/0.160.1', codexHome: '/fixture', platformFamily: 'unix', platformOs: 'linux' }
const thread = (turns = [], historyMode = 'legacy') => ({
  id: sessionId, historyMode, turns,
  status: turns.some((turn) => turn.status === 'inProgress') ? { type: 'active', activeFlags: [] } : { type: 'idle' },
})
const result = (socket, request, value) => socket.send(JSON.stringify({ id: request.id, result: value }))
const rejection = (socket, request, code, message) => socket.send(JSON.stringify({ id: request.id, error: { code, message } }))

/** Real WebSocket framing, either on loopback or over HTTP/UDS. No Codex
 * executable, account, thread resume, hook, or external provider is involved. */
async function fixture(t, { ipc = false, onRequest, turns = [], historyMode = 'legacy' } = {}) {
  const root = await mkdtemp('/tmp/ad-codex-fixture-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const codexHome = join(root, 'codex')
  await mkdir(join(codexHome, 'app-server-control'), { recursive: true })
  const socketPath = join(codexHome, 'app-server-control', 'app-server-control.sock')
  const server = http.createServer()
  const wss = new WebSocketServer({ server, verifyClient: (_info, done) => {
    done(state.authStatus === undefined, state.authStatus)
  } })
  const state = { requests: [], headers: [], closed: [], connections: 0, turns, historyMode, authStatus: undefined }
  wss.on('connection', (socket, request) => {
    state.connections++
    state.headers.push(request.headers)
    state.closed.push(once(socket, 'close'))
    socket.on('error', () => {})
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString())
      state.requests.push(request)
      if (onRequest?.(request, socket, state)) return
      if (request.method === 'initialized') return
      if (request.method === 'initialize') return result(socket, request, initializeResult)
      if (request.method === 'thread/read') return result(socket, request, {
        thread: { ...thread(state.turns, state.historyMode), turns: request.params.includeTurns ? state.turns : [],
          ...(state.status ? { status: state.status } : {}) },
      })
      if (request.method === 'thread/turns/list') return result(socket, request, { data: state.turns, nextCursor: null, backwardsCursor: null })
      if (request.method === 'thread/queue/add') return result(socket, request, { queuedSubmission: {
        id: 'queued-fixture', input: request.params.input, clientUserMessageId: request.params.clientUserMessageId,
      } })
      if (request.method === 'turn/steer') return result(socket, request, { turnId: request.params.expectedTurnId })
      assert.fail(`unexpected method ${request.method}`)
    })
  })
  server.listen(ipc ? socketPath : { host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate()
    await new Promise((resolve) => wss.close(resolve))
    await new Promise((resolve) => server.close(resolve))
  })
  return {
    state, codexHome, socketPath,
    endpoint: ipc ? socketPath : `ws://127.0.0.1:${server.address().port}`,
    async drained() {
      let timer
      try {
        await Promise.race([
          Promise.all(state.closed),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('client socket did not close')), 2000) }),
        ])
      } finally { clearTimeout(timer) }
      assert.equal(wss.clients.size, 0)
    },
  }
}
const address = (fixture, more = {}) => connectCodex({ harness: 'codex', sessionId, endpoint: fixture.endpoint, ...more })
const mutations = (state) => state.requests.filter((request) => request.method === 'turn/steer' || request.method === 'thread/queue/add')

function assertSafe(error, code) {
  assert.ok(error instanceof ConnectionError)
  assert.equal(error.code, code)
  assert.equal(/secret|127\.0\.0\.1|fixture|body/.test(error.message), false)
  return true
}

test('connect proves thread existence; queue preserves exact text idle and busy, on fresh sockets', async (t) => {
  const f = await fixture(t)
  const target = await address(f, { token: 'explicit-secret' })
  assert.equal(Object.isFrozen(target), true)
  assert.deepEqual(target, { harness: 'codex', sessionId })
  assert.equal(mutations(f.state).length, 0)
  assert.deepEqual(f.state.requests.map((r) => r.method), ['initialize', 'initialized', 'thread/read'])
  const text = '  exact\ntext\r\n\t@literal `` [brackets] `` 🦈\u0000  '
  const idle = await sendCodexText(target, text, { delivery: 'queue' })
  f.state.turns = [{ id: 'turn-busy', status: 'inProgress' }]
  const busy = await sendCodexText(target, text, { delivery: 'queue' })
  for (const receipt of [idle, busy]) {
    assert.deepEqual(receipt, { harness: 'codex', sessionId, inputId: receipt.inputId, state: 'admitted' })
    assert.match(receipt.inputId, uuid)
  }
  assert.notEqual(idle.inputId, busy.inputId) // correlation only, not deduplication
  assert.deepEqual(mutations(f.state).map((r) => r.params), [idle, busy].map((r) => ({
    threadId: sessionId, clientUserMessageId: r.inputId, input: [{ type: 'text', text, text_elements: [] }],
  })))
  assert.equal(f.state.connections, 3)
  assert.ok(f.state.headers.every((headers) => headers.authorization === 'Bearer explicit-secret'))
  assert.ok(f.state.requests.filter((r) => r.method === 'initialize').every((r) => r.params.capabilities.experimentalApi === true))
  assert.ok(f.state.requests.every((r) => !['thread/resume', 'turn/start', 'thread/queue/list'].includes(r.method)))
  await f.drained()
})

test('steer discovers and fences the active turn; idle steer never starts or resumes', async (t) => {
  const f = await fixture(t, { turns: [{ id: 'old', status: 'completed' }, { id: 'active', status: 'inProgress' }] })
  const target = await address(f)
  const sent = await sendCodexText(target, ' steer verbatim ')
  assert.equal(sent.state, 'admitted')
  assert.deepEqual(mutations(f.state)[0].params, {
    threadId: sessionId, clientUserMessageId: sent.inputId,
    input: [{ type: 'text', text: ' steer verbatim ', text_elements: [] }], expectedTurnId: 'active',
  })
  f.state.turns = []
  f.state.status = { type: 'idle' } // no materialized history; do not hydrate it
  const historyReads = f.state.requests.filter((r) => r.method === 'thread/read' && r.params.includeTurns).length
  const idle = await sendCodexText(target, 'do not start')
  assert.equal(idle.state, 'rejected')
  assert.equal(idle.code, 'refused')
  assert.equal(mutations(f.state).length, 1)
  assert.equal(f.state.requests.filter((r) => r.method === 'thread/read' && r.params.includeTurns).length, historyReads)
  assert.ok(f.state.requests.every((r) => ['initialize', 'initialized', 'thread/read', 'turn/steer'].includes(r.method)))
  await f.drained()
})

test('paginated discovery prefers a fresh live turn; pages are only an active-thread fallback', async (t) => {
  let needsPages = false
  const f = await fixture(t, { historyMode: 'paginated', turns: [{ id: 'fresh-live', status: 'inProgress' }], onRequest(request, socket) {
    if (request.method === 'thread/read' && request.params.includeTurns && needsPages) {
      result(socket, request, { thread: { ...thread([], 'paginated'), status: { type: 'active', activeFlags: [] } } })
      return true
    }
    if (request.method !== 'thread/turns/list') return false
    assert.equal(request.params.threadId, sessionId)
    assert.equal(request.params.sortDirection, 'desc')
    result(socket, request, request.params.cursor === undefined
      ? { data: [{ id: 'last', status: 'completed' }], nextCursor: 'opaque-page' }
      : { data: [{ id: 'paged-active', status: 'inProgress' }], nextCursor: null })
    return true
  } })
  const target = await address(f)
  assert.equal((await sendCodexText(target, 'fresh')).state, 'admitted')
  assert.equal(mutations(f.state)[0].params.expectedTurnId, 'fresh-live')
  assert.equal(f.state.requests.filter((r) => r.method === 'thread/turns/list').length, 0)
  needsPages = true
  assert.equal((await sendCodexText(target, 'fallback')).state, 'admitted')
  assert.equal(mutations(f.state)[1].params.expectedTurnId, 'paged-active')
  assert.equal(f.state.requests.filter((r) => r.method === 'thread/turns/list').length, 2)
  needsPages = false
  f.state.turns = []
  assert.equal((await sendCodexText(target, 'idle')).state, 'rejected')
  assert.equal(f.state.requests.filter((r) => r.method === 'thread/turns/list').length, 2)
  await f.drained()
})

test('default Codex home and explicit Unix endpoints use WebSocket over existing UDS', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t, { ipc: true })
  const saved = process.env.CODEX_HOME
  t.after(() => { process.env.CODEX_HOME = saved })
  process.env.CODEX_HOME = f.codexHome
  const targets = [
    await connectCodex({ harness: 'codex', sessionId }),
    await connectCodex({ harness: 'codex', sessionId, codexHome: f.codexHome }),
    await address(f),
    await address(f, { endpoint: `unix://${f.socketPath}` }),
  ]
  for (const target of targets) assert.equal((await sendCodexText(target, 'UDS', { delivery: 'queue' })).state, 'admitted')
  assert.equal(f.state.connections, 8)
  await f.drained()
  await assert.rejects(connectCodex({ harness: 'codex', sessionId, codexHome: join(f.codexHome, 'absent') }), (e) => assertSafe(e, 'transport'))
})

test('abort, timeout and close are unknown only after mutation dispatch', async (t) => {
  for (const [phase, stop] of [
    ['initialize', 'transport'], ['thread/read', 'timeout'],
    ['thread/queue/add', 'timeout'], ['thread/queue/add', 'aborted'], ['thread/queue/add', 'transport'],
  ]) {
    await t.test(`${phase}: ${stop}`, async (t) => {
      let sending = false
      const controller = new AbortController()
      const f = await fixture(t, { onRequest(request, socket) {
        if (!sending || request.method !== phase) return false
        if (stop === 'aborted') controller.abort()
        if (stop === 'transport') socket.terminate()
        return true
      } })
      const target = await address(f)
      sending = true
      const sent = await sendCodexText(target, 'body-secret', { delivery: 'queue', timeoutMs: 100, signal: controller.signal })
      assert.equal(sent.state, phase === 'thread/queue/add' ? 'unknown' : 'unavailable')
      assert.equal(sent.code, stop)
      assert.match(sent.inputId, uuid)
      assert.equal(mutations(f.state).length, phase === 'thread/queue/add' ? 1 : 0)
      await f.drained()
    })
  }
})

test('pre-aborted calls open no socket and dispose their deadlines', async (t) => {
  const f = await fixture(t)
  const target = await address(f)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(address(f, { signal: controller.signal }), (e) => assertSafe(e, 'aborted'))
  const sent = await sendCodexText(target, 'text', { signal: controller.signal })
  assert.equal(sent.state, 'unavailable')
  assert.equal(sent.code, 'aborted')
  assert.equal(f.state.connections, 1)
  assert.equal(mutations(f.state).length, 0)
  await f.drained()
})

test('native refusal, method support and internal errors retain honest admission uncertainty', async (t) => {
  for (const [nativeCode, message, state, code] of [
    [-32601, 'Method not found', 'rejected', 'unsupported_version'],
    [-32600, 'Invalid request: unknown variant `turn/steer`, expected one of ...', 'rejected', 'unsupported_version'],
    [-32600, 'expected active turn id `old` but found `new`', 'rejected', 'refused'],
    [-32603, 'failed after storage write: secret', 'unknown', 'transport'],
  ]) {
    await t.test(`${nativeCode}: ${code}`, async (t) => {
      const f = await fixture(t, { turns: [{ id: 'active', status: 'inProgress' }], onRequest(request, socket) {
        if (request.method !== 'turn/steer') return false
        rejection(socket, request, nativeCode, message)
        return true
      } })
      const sent = await sendCodexText(await address(f), 'body-secret')
      assert.equal(sent.state, state)
      assert.equal(sent.code, code)
      assert.equal(mutations(f.state).length, 1)
      assert.equal(JSON.stringify(sent).includes('secret'), false)
      await f.drained()
    })
  }
})

test('missing or malformed thread preconditions never dispatch', async (t) => {
  for (const mode of ['missing', 'wrong_thread', 'bad_initialize']) {
    await t.test(mode, async (t) => {
      let sending = false
      const f = await fixture(t, { onRequest(request, socket) {
        if (!sending) return false
        if (mode === 'bad_initialize' && request.method === 'initialize') { result(socket, request, {}); return true }
        if (request.method !== 'thread/read') return false
        if (mode === 'missing') rejection(socket, request, -32600, 'no rollout found for thread id secret')
        else if (mode === 'wrong_thread') result(socket, request, { thread: { id: 'other' } })
        else return false
        return true
      } })
      const target = await address(f)
      sending = true
      const sent = await sendCodexText(target, 'body-secret')
      assert.equal(sent.state, mode === 'missing' ? 'rejected' : 'unavailable')
      assert.equal(sent.code, mode === 'missing' ? 'not_found' : 'transport')
      assert.equal(mutations(f.state).length, 0)
      await assert.rejects(address(f), (e) => assertSafe(e, mode === 'missing' ? 'session_not_found' : 'invalid_response'))
      await f.drained()
    })
  }
})

test('malformed mutation acknowledgements cannot claim admission; unrelated notifications are not receipts', async (t) => {
  for (const mode of ['wrong_id', 'wrong_turn', 'wrong_input_id']) {
    await t.test(mode, async (t) => {
      const f = await fixture(t, { turns: [{ id: 'active', status: 'inProgress' }], onRequest(request, socket) {
        if (!['turn/steer', 'thread/queue/add'].includes(request.method)) return false
        socket.send(JSON.stringify({ method: 'item/completed', params: { threadId: 'other', item: { type: 'userMessage' } } }))
        if (mode === 'wrong_id') socket.send(JSON.stringify({ id: 'other', result: {} }))
        else if (mode === 'wrong_turn') result(socket, request, { turnId: 'other' })
        else result(socket, request, { queuedSubmission: {
          id: 'queued', clientUserMessageId: 'other', input: request.params.input,
        } })
        return true
      } })
      const sent = await sendCodexText(await address(f), 'body-secret', { delivery: mode === 'wrong_turn' ? 'steer' : 'queue' })
      assert.equal(sent.state, 'unknown')
      assert.equal(sent.code, 'invalid_response')
      assert.equal(mutations(f.state).length, 1)
      await f.drained()
    })
  }
})

test('invalid arguments and forged targets fail locally; diagnostics never include endpoint or token', async (t) => {
  const f = await fixture(t)
  for (const more of [
    { endpoint: 'not-an-endpoint' }, { endpoint: 'http://localhost' }, { endpoint: 'ws://user:secret@localhost' },
    { endpoint: 'unix://relative' }, { endpoint: 'ws://localhost/#secret' }, { sessionId: ' ' }, { token: 'secret\r\nheader' },
    { token: '' }, { timeoutMs: 0 }, { signal: {} },
  ]) await assert.rejects(address(f, more), (e) => assertSafe(e, process.platform === 'win32' && more.endpoint === 'unix://relative' ? 'unsupported_platform' : 'invalid_arguments'))
  const target = await address(f)
  for (const [candidate, text, options] of [
    [{ harness: 'codex', sessionId }, 'text', {}], [target, '', {}], [target, 123, {}], [target, 'text', null],
    [target, 'text', { inputId: 'not-supported' }], [target, 'text', { delivery: 'start' }],
    [target, 'text', { timeoutMs: Infinity }], [target, 'text', { signal: {} }],
  ]) await assert.rejects(sendCodexText(candidate, text, options), TypeError)
  assert.equal(f.state.connections, 1)
  await f.drained()
})

test('WebSocket 401/403 authentication refusal is known-unsent and has sanitized diagnostics', async (t) => {
  for (const status of [401, 403]) {
    await t.test(String(status), async (t) => {
      const f = await fixture(t)
      const target = await address(f, { token: 'explicit-secret' })
      f.state.authStatus = status
      await assert.rejects(address(f, { token: 'wrong-secret' }), (e) => assertSafe(e, 'authentication_failed'))
      const sent = await sendCodexText(target, 'body-secret', { delivery: 'queue' })
      assert.equal(sent.state, 'unavailable')
      assert.equal(sent.code, 'authentication_failed')
      assert.equal(mutations(f.state).length, 0)
      assert.equal(f.state.connections, 1)
      await f.drained()
    })
  }
})

test('unfinished WebSocket handshakes are bounded and destroyed on timeout or abort', async (t) => {
  for (const stop of ['timeout', 'aborted']) {
    await t.test(stop, async (t) => {
      const controller = new AbortController()
      const server = http.createServer()
      const sockets = new Set()
      const closed = []
      server.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('error', () => {})
        closed.push(once(socket, 'close'))
        socket.on('close', () => sockets.delete(socket))
      })
      server.on('upgrade', (_request, socket) => {
        // HTTP upgrade sockets are half-open; acknowledge the client's FIN so
        // this deliberately incomplete fixture can close its own server side.
        socket.on('end', () => socket.end())
        socket.resume()
        if (stop === 'aborted') controller.abort()
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      t.after(async () => {
        for (const socket of sockets) socket.destroy()
        await new Promise((resolve) => server.close(resolve))
      })
      await assert.rejects(connectCodex({ harness: 'codex', sessionId,
        endpoint: `ws://127.0.0.1:${server.address().port}`, timeoutMs: 100, signal: controller.signal,
      }), (e) => assertSafe(e, stop))
      await Promise.all(closed)
      assert.equal(sockets.size, 0)
    })
  }
})

test('one-shot caller exits without lingering WebSocket, close, or deadline timers', async (t) => {
  const f = await fixture(t)
  const script = `import { connectCodex, sendCodexText } from ${JSON.stringify(new URL('../dist/codex.js', import.meta.url).href)};
const target = await connectCodex({harness:'codex', sessionId:${JSON.stringify(sessionId)}, endpoint:process.argv[1]});
console.log(JSON.stringify(await sendCodexText(target, 'one shot', {delivery:'queue'})));`
  const child = await exec(process.execPath, ['--input-type=module', '-e', script, f.endpoint], { timeout: 5000 })
  assert.equal(JSON.parse(child.stdout).state, 'admitted')
  assert.equal(mutations(f.state).length, 1)
  await f.drained()
})
