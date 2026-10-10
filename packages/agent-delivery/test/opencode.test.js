import './sandbox-env.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { connect, DeliveryError } from '../dist/index.js'
import { fixture, sessionId, secret } from './fixture.js'
import { sandbox } from './sandbox-env.js'

const prompts = (f) => f.requests.filter((request) => request.method === 'POST')
const code = (expected) => (error) => {
  assert.ok(error instanceof DeliveryError, `expected DeliveryError, got ${error}`)
  assert.equal(error.code, expected)
  assert.ok(!JSON.stringify(error).includes(secret))
  assert.ok(!error.message.includes(secret))
  return true
}

test('connect exposes steer and queue, both returning admitted receipts with the caller id', async (t) => {
  const f = await fixture(t)
  const agent = await connect({ harness: 'opencode', sessionId, endpoint: f.endpoint })
  assert.equal(Object.isFrozen(agent), true)
  assert.deepEqual(Object.keys(agent), ['harness', 'sessionId', 'steer', 'queue'])
  assert.equal(agent.harness, 'opencode')
  assert.equal(agent.sessionId, sessionId)

  assert.deepEqual(await agent.steer('native text', { id: 'msg_steer' }), { id: 'msg_steer', proof: 'admitted' })
  assert.deepEqual(await agent.queue('later text', { id: 'msg_queue' }), { id: 'msg_queue', proof: 'admitted' })
  assert.deepEqual(prompts(f).map((request) => request.body), [
    { text: 'native text', delivery: 'steer', id: 'msg_steer', resume: true },
    { text: 'later text', delivery: 'queue', id: 'msg_queue', resume: true },
  ])
  assert.ok(f.requests.every((request) => request.path.startsWith('/api/')))

  const generated = await agent.steer('no caller id')
  assert.match(generated.id, /^msg_/)
  assert.deepEqual(generated.proof, 'admitted')
  // A reused caller id is the caller's idempotency coordinate; native admission wins.
  assert.deepEqual(await agent.steer('same logical input', { id: 'msg_steer' }), { id: 'msg_steer', proof: 'admitted' })
  assert.equal(prompts(f).length, 4)
})

test('official managed discovery authenticates and matches registration', async (t) => {
  const f = await fixture(t)
  const file = await f.register(join(process.env.XDG_STATE_HOME, 'opencode', 'service.json'))
  t.after(() => rm(file, { force: true }))
  const agent = await connect({ harness: 'opencode', sessionId })
  assert.deepEqual(await agent.steer('discovered', { id: 'msg_discovered' }), { id: 'msg_discovered', proof: 'admitted' })
  assert.ok(f.requests.every((request) => request.auth !== undefined))
  await f.register(file, { pid: process.pid + 100_000 })
  await assert.rejects(connect({ harness: 'opencode', sessionId }), code('unavailable'))
})

test('preconditions reject before HTTP: arguments, platform, version, auth, session', async (t) => {
  const f = await fixture(t)
  for (const extra of [{ timeoutMs: 0 }, { timeoutMs: NaN }, { timeoutMs: 2_147_483_648 }, { signal: {} },
    { sessionId: '' }, { harness: 'claude' }, { registrationFile: '/unused' },
    { endpoint: { url: `${f.endpoint.url}?password=${secret}` } },
    { endpoint: { url: `http://user:${secret}@localhost` } },
    { endpoint: { url: 'ftp://127.0.0.1' } }]) {
    await assert.rejects(connect({ harness: 'opencode', sessionId, endpoint: f.endpoint, ...extra }), code('invalid_arguments'))
  }
  assert.equal(f.requests.length, 0)
  await assert.rejects(connect({ harness: 'opencode' }), code('invalid_arguments'))

  await assert.rejects(connect({ harness: 'opencode', sessionId, endpoint: { ...f.endpoint, auth: { ...f.endpoint.auth, password: 'wrong' } } }), code('authentication_failed'))
  await assert.rejects(connect({ harness: 'opencode', sessionId: 'ses_absent', endpoint: f.endpoint }), code('session_not_found'))
  const wrong = await fixture(t, (record, response) => {
    if (record.path === '/api/info') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ pid: process.pid, version: '1.18.35' })); return true }
  })
  await assert.rejects(connect({ harness: 'opencode', sessionId, endpoint: wrong.endpoint }), code('unsupported_version'))
  const malformed = await fixture(t, (record, response) => {
    if (record.path === `/api/session/${sessionId}`) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: { id: 'ses_other' } })); return true }
  })
  await assert.rejects(connect({ harness: 'opencode', sessionId, endpoint: malformed.endpoint }), code('invalid_response'))
  await assert.rejects(connect({ harness: 'opencode', sessionId, registrationFile: join(sandbox, 'absent.json') }), code('unavailable'))
})

test('HTTP rejection is authoritative; post-dispatch timeout stays unknown and is never retried', async (t) => {
  const f = await fixture(t, (record, response) => {
    if (record.method !== 'POST') return
    response.writeHead(409, { 'content-type': 'text/plain' })
    response.end(`${secret} ${record.body.text}`)
    return true
  })
  const agent = await connect({ harness: 'opencode', sessionId, endpoint: f.endpoint })
  await assert.rejects(agent.steer('rejected text', { id: 'msg_rejected' }), (error) => {
    assert.ok(error instanceof DeliveryError)
    assert.equal(error.code, 'rejected')
    assert.equal(error.maybeDelivered, false)
    assert.equal(error.id, 'msg_rejected')
    assert.equal(error.status, 409)
    assert.ok(!JSON.stringify(error).includes('rejected text'))
    return true
  })
  assert.equal(prompts(f).length, 1)

  let arrival
  const received = new Promise((resolve) => { arrival = resolve })
  const held = await fixture(t, (record) => {
    if (record.method === 'POST') { arrival(); return true }
  })
  const sending = (await connect({ harness: 'opencode', sessionId, endpoint: held.endpoint }))
    .steer('may already be durable', { timeoutMs: 100, id: 'msg_stable' })
  await received
  await assert.rejects(sending, (error) => {
    assert.equal(error.code, 'timeout')
    assert.equal(error.maybeDelivered, true)
    assert.equal(error.id, 'msg_stable')
    return true
  })
  assert.equal(prompts(held).length, 1)
})

test('preabort and unparsable coordinates never reach the network', async (t) => {
  const f = await fixture(t)
  const controller = new AbortController()
  controller.abort(secret)
  await assert.rejects(connect({ harness: 'opencode', sessionId, endpoint: f.endpoint, signal: controller.signal }), code('aborted'))
  assert.equal(f.requests.length, 0)
  const agent = await connect({ harness: 'opencode', sessionId, endpoint: f.endpoint })
  await assert.rejects(agent.steer('never sent', { signal: controller.signal }), (error) => {
    assert.equal(error.code, 'aborted')
    assert.equal(error.maybeDelivered, false)
    return true
  })
  await assert.rejects(agent.steer('', { id: 'msg_empty' }), code('invalid_arguments'))
  await assert.rejects(agent.steer('text', { id: 'not-prefixed' }), code('invalid_arguments'))
  await assert.rejects(agent.steer('text', { id: 5 }), code('invalid_arguments'))
  await assert.rejects(agent.steer('text', null), code('invalid_arguments'))
  assert.equal(prompts(f).length, 0)
})
