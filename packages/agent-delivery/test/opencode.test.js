import './sandbox-env.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { connectExisting, sendText, ConnectionError } from '../dist/index.js'
import { fixture, json, sessionId, secret, authorization } from './fixture.js'
import { sandbox } from './sandbox-env.js'

const connect = (endpoint, extra = {}) => connectExisting({ harness: 'opencode', sessionId, endpoint, ...extra })
const prompts = (f) => f.requests.filter((request) => request.method === 'POST')
const errorCode = (code) => (error) => {
  assert.ok(error instanceof ConnectionError)
  assert.equal(error.code, code)
  assert.ok(!JSON.stringify(error).includes(secret))
  assert.ok(!error.message.includes(secret))
  return true
}

test('official managed discovery authenticates and matches registration, then admits steer and queue once', async (t) => {
  const f = await fixture(t)
  const file = await f.register(join(process.env.XDG_STATE_HOME, 'opencode', 'service.json'))
  t.after(() => rm(file, { force: true }))
  const target = await connectExisting({ harness: 'opencode', sessionId })
  assert.deepEqual(Object.keys(target), ['harness', 'sessionId'])
  for (const delivery of ['steer', 'queue']) {
    const inputId = `msg_${delivery}`
    const result = await sendText(target, 'native text', { delivery, inputId })
    assert.deepEqual(result, { harness: 'opencode', sessionId, inputId,
      state: 'accepted', inboxId: inputId, delivery })
    assert.deepEqual(prompts(f).at(-1).body, { text: 'native text', delivery, id: inputId, resume: true })
  }
  assert.ok(f.requests.every((request) => request.auth === authorization))
  assert.ok(f.requests.every((request) => request.path.startsWith('/api/')))
  assert.equal(prompts(f).length, 2)
  await f.register(file, { pid: process.pid + 100_000 })
  await assert.rejects(connectExisting({ harness: 'opencode', sessionId }), errorCode('service_unavailable'))
  await f.register(file, { version: '2.0.19' })
  await assert.rejects(connectExisting({ harness: 'opencode', sessionId }), errorCode('service_unavailable'))
})

test('explicit endpoints fail closed on wrong major, auth, absent session, incompatible or malformed service', async (t) => {
  const wrong = await fixture(t, (record, response) => {
    if (record.path === '/api/info') { json(response, 200, { pid: process.pid, version: '1.18.35' }); return true }
  })
  await assert.rejects(connect(wrong.endpoint), errorCode('unsupported_version'))
  assert.equal(wrong.requests.length, 1)
  const f = await fixture(t)
  await assert.rejects(connect({ ...f.endpoint, auth: { ...f.endpoint.auth, password: 'wrong' } }), errorCode('authentication_failed'))
  await assert.rejects(connect(f.endpoint, { sessionId: 'ses_absent' }), errorCode('session_not_found'))
  const incompatible = await fixture(t, (record, response) => {
    if (record.path === '/api/info') { json(response, 404, { _tag: 'NotFound' }); return true }
  })
  await assert.rejects(connect(incompatible.endpoint), errorCode('http_rejection'))
  const malformed = await fixture(t, (record, response) => {
    if (record.path === `/api/session/${sessionId}`) { json(response, 200, { data: { id: 'ses_other' } }); return true }
  })
  await assert.rejects(connect(malformed.endpoint), errorCode('invalid_response'))
  await assert.rejects(connectExisting({ harness: 'opencode', sessionId,
    registrationFile: join(sandbox, 'absent.json') }), errorCode('service_unavailable'))
  const oldRegistration = await wrong.register()
  await assert.rejects(connectExisting({ harness: 'opencode', sessionId, registrationFile: oldRegistration }), errorCode('service_unavailable'))
})

test('HTTP rejection is authoritative even with an unparseable body; secrets never become diagnostics', async (t) => {
  const f = await fixture(t, (record, response) => {
    if (record.method !== 'POST') return
    response.writeHead(409, { 'content-type': 'text/plain' })
    response.end(`${secret} ${record.body.text}`)
    return true
  })
  const target = await connect(f.endpoint)
  const result = await sendText(target, 'sensitive-input')
  assert.deepEqual(result, { harness: 'opencode', sessionId, inputId: result.inputId,
    state: 'rejected', code: 'http_rejection', status: 409 })
  assert.match(result.inputId, /^msg_/)
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.ok(!JSON.stringify(result).includes('sensitive-input'))
  assert.equal(prompts(f).length, 1)
})

test('post-dispatch timeout and transport loss are unknown and never retried', async (t) => {
  let arrival
  const received = new Promise((resolve) => { arrival = resolve })
  const f = await fixture(t, (record) => {
    if (record.method === 'POST') { arrival(); return true }
  })
  const target = await connect(f.endpoint)
  const sending = sendText(target, 'may already be durable', { timeoutMs: 100, inputId: 'msg_stable' })
  await received
  assert.deepEqual(await sending, { harness: 'opencode', sessionId, inputId: 'msg_stable', state: 'unknown', code: 'timeout' })
  assert.equal(prompts(f).length, 1)
  const lost = await fixture(t, (record, response) => {
    if (record.method === 'POST') { response.destroy(); return true }
  })
  const result = await sendText(await connect(lost.endpoint), 'text')
  assert.equal(result.state, 'unknown')
  assert.equal(result.code, 'transport')
  assert.equal(prompts(lost).length, 1)
})

test('backend failure after a recorded submission is unknown, with its stable ID and no retry', async (t) => {
  const admitted = new Set()
  const f = await fixture(t, (record, response) => {
    if (record.method !== 'POST') return
    admitted.add(record.body.id)
    json(response, 503, { message: `${secret}: failed after admission` })
    return true
  })
  const target = await connect(f.endpoint)
  const result = await sendText(target, 'text', { inputId: 'msg_server_failure' })
  assert.deepEqual(result, { harness: 'opencode', sessionId, inputId: 'msg_server_failure',
    state: 'unknown', code: 'transport' })
  assert.ok(admitted.has(result.inputId))
  assert.equal(prompts(f).length, 1)
  assert.ok(!JSON.stringify(result).includes(secret))
})

test('abort before dispatch is known not sent; abort after dispatch is unknown', async (t) => {
  const preabort = new AbortController()
  preabort.abort(secret)
  const f = await fixture(t)
  await assert.rejects(connect(f.endpoint, { signal: preabort.signal }), errorCode('aborted'))
  assert.equal(f.requests.length, 0)
  const target = await connect(f.endpoint)
  const result = await sendText(target, 'text', { signal: preabort.signal })
  assert.equal(result.state, 'unavailable')
  assert.equal(result.code, 'aborted')
  assert.equal(prompts(f).length, 0)
  const controller = new AbortController()
  const after = await fixture(t, (record) => {
    if (record.method === 'POST') { controller.abort(secret); return true }
  })
  const afterResult = await sendText(await connect(after.endpoint), 'text', { signal: controller.signal })
  assert.equal(afterResult.state, 'unknown')
  assert.equal(afterResult.code, 'aborted')
  assert.equal(prompts(after).length, 1)
})

test('bounded uncancellable discovery does not continue to session.get or prompt after timeout', async (t) => {
  let respond
  const f = await fixture(t, (record, response) => {
    if (record.path === '/api/info') {
      respond = () => json(response, 200, { version: '2.0.20', pid: process.pid })
      return true
    }
  })
  const file = await f.register()
  await assert.rejects(connectExisting({ harness: 'opencode', sessionId, registrationFile: file, timeoutMs: 100 }), errorCode('timeout'))
  assert.equal(f.requests.length, 1)
  // Drain the still-running official SDK probe; a later success must have no continuation.
  respond()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(f.requests.length, 1)
})

test('success must contain a matching native inbox admission, not just an HTTP 200', async (t) => {
  let envelope
  const f = await fixture(t, (record, response) => {
    if (record.method === 'POST') { json(response, 200, envelope(record.body)); return true }
  })
  const target = await connect(f.endpoint)
  for (const mutation of [
    () => ({}),
    () => ({ data: { id: 'msg_wrong' } }),
    (body) => ({ data: { id: body.id, sessionID: 'ses_other', type: 'user', delivery: 'steer', payload: { text: 'x' }, time: { created: 1 } } }),
    (body) => ({ data: { id: body.id, sessionID: sessionId, type: 'user', delivery: 'steer', payload: {}, time: { created: 1 } } }),
  ]) {
    envelope = mutation
    const result = await sendText(target, 'text')
    assert.equal(result.state, 'unknown')
    assert.equal(result.code, 'invalid_response')
  }
  // Native ID reconciliation may return the original delivery/payload; not equality validation.
  envelope = (body) => ({ data: { id: body.id, sessionID: sessionId, type: 'user', delivery: 'queue', payload: { text: 'original' }, time: { created: 1 } } })
  const result = await sendText(target, 'same logical input', { inputId: 'msg_reconciled' })
  assert.equal(result.state, 'accepted')
  assert.equal(result.delivery, 'queue')
  assert.equal(prompts(f).length, 5)
})

test('invalid arguments and forged handles cannot trigger network work', async (t) => {
  const f = await fixture(t)
  for (const extra of [ { timeoutMs: NaN }, { timeoutMs: 0 }, { timeoutMs: Infinity },
    { timeoutMs: 2_147_483_648 }, { signal: {} }, { sessionId: '' }, { harness: 'claude' },
    { registrationFile: '/unused' }, { endpoint: { url: `${f.endpoint.url}?password=${secret}` } },
    { endpoint: { url: `http://user:${secret}@localhost` } },
  ]) await assert.rejects(connect(f.endpoint, extra), errorCode('invalid_arguments'))
  assert.equal(f.requests.length, 0)
  const target = await connect(f.endpoint)
  for (const options of [ { inputId: 'bad' }, { delivery: 'interrupt' }, { timeoutMs: -1 }, { signal: {} } ]) {
    await assert.rejects(sendText(target, 'text', options), TypeError)
  }
  await assert.rejects(sendText(target, ''), TypeError)
  await assert.rejects(sendText({ ...target }, 'text'), TypeError)
  assert.equal(prompts(f).length, 0)
})

test('targets retain private endpoint copies and concurrent sends have independent transport evidence', async (t) => {
  const f = await fixture(t, (record, response) => {
    if (record.method === 'POST' && record.body.text === 'reject') {
      json(response, 400, { _tag: 'BadRequest', message: secret }); return true
    }
  })
  const endpoint = structuredClone(f.endpoint)
  const target = await connect(endpoint)
  endpoint.auth.password = 'changed'
  endpoint.url = 'http://invalid.invalid'
  const [yes, no] = await Promise.all([sendText(target, 'accept'), sendText(target, 'reject')])
  assert.equal(yes.state, 'accepted')
  assert.equal(no.state, 'rejected')
  assert.notEqual(yes.inputId, no.inputId)
  assert.equal(prompts(f).length, 2)
})
