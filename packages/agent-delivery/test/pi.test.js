import './sandbox-env.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, lstat, chmod, unlink, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { once } from 'node:events'
import { connectExisting, sendText, ConnectionError } from '../dist/index.js'
import { createPiReceiver, sendPiMessage } from '../dist/pi.js'
import { sandbox } from './sandbox-env.js'

const mac = { skip: process.platform !== 'darwin' }
async function fixture(t) {
  const directory = await mkdtemp(join(sandbox, 'pi-'))
  const endpoint = join(directory, 'p.sock')
  const handlers = new Map()
  const sent = []
  let configured
  const pi = {
    on(event, callback) {
      const list = handlers.get(event) ?? []
      list.push(callback); handlers.set(event, list)
    },
    sendMessage(message, options) { sent.push({ message, options }) },
  }
  const receiver = createPiReceiver(pi, { get endpoint() { return configured } })
  const context = (id) => ({ sessionManager: { getSessionId: () => id } })
  let ctx = context('pi-test-session')
  const emit = async (event, body = {}, eventCtx = ctx) => {
    for (const callback of handlers.get(event) ?? []) await callback(body, eventCtx)
  }
  await emit('session_start')
  await assert.rejects(lstat(endpoint), { code: 'ENOENT' })
  configured = endpoint
  await emit('session_start')
  t.after(() => receiver.close())
  return { pi, endpoint, sent, ctx, emit, receiver,
    async replace(id) { await emit('session_shutdown'); ctx = context(id); await emit('session_start'); return ctx },
    observe(message, eventCtx) { return emit('message_end', { message: { role: 'custom', ...message } }, eventCtx) },
  }
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('Expected native invocation')
}
const connect = (f, extra = {}) => connectExisting({ harness: 'pi', sessionId: 'pi-test-session', endpoint: f.endpoint, ...extra })

test('native leaf preserves objects and options and has no scheduling or receipt behavior', () => {
  const message = { customType: 'custom', content: [{ type: 'text', text: 'unchanged' }], display: false, details: { a: 1 } }
  const options = { deliverAs: 'nextTurn' }
  let calls = 0
  const pi = { sendMessage(m, o) { calls++; assert.equal(m, message); assert.equal(o, options) } }
  assert.equal(sendPiMessage(pi, message, options), undefined)
  assert.equal(calls, 1)
})

test('receiver resolves endpoint lazily; identity and event correlation protect exact concurrent attempts', mac, async (t) => {
  const f = await fixture(t)
  assert.equal((await lstat(f.endpoint)).mode & 0o777, 0o600)
  await f.emit('session_start') // identical start does not reset receiver
  await assert.rejects(connect(f, { sessionId: 'wrong' }), (e) => e instanceof ConnectionError && e.code === 'session_not_found')
  const target = await connect(f)
  assert.deepEqual(Object.keys(target), ['harness', 'sessionId'])
  const text = ' /literal-command\n  中文🦈\u2028\u2029\t '
  const a = sendText(target, text)
  const b = sendText(target, text, { delivery: 'queue' })
  await until(() => f.sent.length === 2)
  assert.notEqual(f.sent[0].message.details.agentDelivery.deliveryId, f.sent[1].message.details.agentDelivery.deliveryId)
  assert.equal(f.sent[0].message.content, text)
  assert.deepEqual(f.sent.map((s) => s.options), [{ deliverAs: 'steer', triggerTurn: true }, { deliverAs: 'followUp', triggerTurn: true }])
  let resolved = false
  a.then(() => { resolved = true })
  await f.observe({ ...f.sent[0].message, content: 'wrong' })
  await f.observe({ ...f.sent[0].message, customType: 'square' })
  await f.observe(f.sent[0].message, { sessionManager: { getSessionId: () => 'old' } })
  await new Promise((r) => setImmediate(r))
  assert.equal(resolved, false, 'void return or mismatched event is never an observation')
  await f.observe(f.sent[0].message)
  await f.observe(f.sent[1].message)
  const receipts = await Promise.all([a, b])
  for (const [i, receipt] of receipts.entries()) {
    assert.deepEqual(receipt, { harness: 'pi', sessionId: target.sessionId,
      inputId: f.sent[i].message.details.agentDelivery.deliveryId, state: 'observed', evidence: 'message_end', delivery: i ? 'queue' : 'steer' })
    assert.equal('entryId' in receipt, false)
  }
})

test('preabort and invalid requests never dispatch; postdispatch abort/timeout retire waits without retracting native custody', mac, async (t) => {
  const f = await fixture(t)
  const target = await connect(f)
  const aborted = AbortSignal.abort('secret')
  const pre = await sendText(target, 'not sent', { signal: aborted })
  assert.equal(pre.state, 'unavailable'); assert.equal(pre.code, 'aborted')
  for (const options of [{ inputId: 'caller-id' }, { timeoutMs: Infinity }, { timeoutMs: 30_001 }, { delivery: 'nextTurn' }]) {
    await assert.rejects(sendText(target, 'invalid', options), TypeError)
  }
  await assert.rejects(sendText({ ...target }, 'forged'), TypeError)
  assert.equal(f.sent.length, 0)
  const controller = new AbortController()
  const sending = sendText(target, 'native may retain this', { signal: controller.signal })
  await until(() => f.sent.length === 1)
  controller.abort('secret')
  const post = await sending
  assert.equal(post.state, 'unknown'); assert.equal(post.code, 'aborted')
  const timeout = await sendText(target, 'late event', { timeoutMs: 25 })
  assert.equal(timeout.state, 'unknown'); assert.equal(timeout.code, 'timeout')
  assert.equal(f.sent.length, 2)
  await f.observe(f.sent[0].message)
  await f.observe(f.sent[1].message)
  // No abort/clearQueue interface was supplied and no retry happened.
  assert.equal(f.sent.length, 2)
})

test('replacement closes connections, rebinds identity and rejects stale targets; close is idempotent', mac, async (t) => {
  const f = await fixture(t)
  const target = await connect(f)
  const pending = sendText(target, 'old pending')
  await until(() => f.sent.length === 1)
  const oldCtx = f.ctx
  const newCtx = await f.replace('new-session')
  assert.equal((await pending).state, 'unknown')
  const stale = await sendText(target, 'must not dispatch')
  assert.equal(stale.state, 'rejected'); assert.equal(stale.code, 'wrong_session')
  const fresh = await connect(f, { sessionId: 'new-session' })
  const sending = sendText(fresh, 'new pending')
  await until(() => f.sent.length === 2)
  await f.observe(f.sent[0].message, oldCtx)
  await f.observe(f.sent[1].message, newCtx)
  assert.equal((await sending).state, 'observed')
  // Closing must not delete a replacement file at the published endpoint.
  await unlink(f.endpoint)
  await writeFile(f.endpoint, 'replacement')
  await f.receiver.close(); await f.receiver.close()
  assert.equal(await readFile(f.endpoint, 'utf8'), 'replacement')
  assert.deepEqual(await readdir(f.endpoint.slice(0, f.endpoint.lastIndexOf('/'))), ['p.sock'])
})

test('occupied endpoint fails closed, private parents and bounded malformed framing admit no native send', mac, async (t) => {
  const f = await fixture(t)
  // Use a separate registration object so the original listener remains untouched.
  let start
  const other = createPiReceiver({ sendMessage() { assert.fail('collision cannot send') }, on(e, cb) { if (e === 'session_start') start = cb } }, { endpoint: f.endpoint })
  t.after(() => other.close())
  await assert.rejects(start({}, f.ctx), /listener unavailable/)
  assert.equal((await lstat(f.endpoint)).isSocket(), true)
  await connect(f)
  const publicParent = await mkdtemp(join(sandbox, 'public-'))
  await chmod(publicParent, 0o755)
  let unsafeStart
  const unsafe = createPiReceiver({ sendMessage() {}, on(e, cb) { if (e === 'session_start') unsafeStart = cb } },
    { endpoint: join(publicParent, 'p.sock') })
  t.after(() => unsafe.close())
  await assert.rejects(unsafeStart({}, f.ctx), /listener unavailable/)
  assert.equal((await lstat(publicParent)).mode & 0o777, 0o755, 'receiver must not chmod the parent')
  for (const payload of [Buffer.from('{invalid}\n'), Buffer.alloc(256 * 1024 + 1, 65), Buffer.from([0xff, 10])]) {
    const socket = createConnection(f.endpoint)
    socket.on('error', () => {})
    await once(socket, 'connect')
    const closed = once(socket, 'close')
    socket.write(payload)
    await closed
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const partial = createConnection(f.endpoint)
  partial.on('error', () => {})
  await once(partial, 'connect')
  partial.write('{')
  const partialClosed = once(partial, 'close')
  t.mock.timers.tick(5_000)
  await partialClosed
  t.mock.timers.reset()
  await f.receiver.close()
  assert.equal(f.sent.length, 0)
})
