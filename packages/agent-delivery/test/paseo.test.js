import './sandbox-env.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WebSocketServer } from 'ws'
import { connect, DeliveryError } from '../dist/index.js'
import { sandbox } from './sandbox-env.js'

const exec = promisify(execFile)

const LOCAL_CREDENTIAL = 'b'.repeat(43)
const CONTROLLED = ['PASEO_HOST', 'PASEO_HOME', 'PASEO_PASSWORD']

/** This machine's real Paseo environment must not reach any test. */
function environment(t, patch = {}) {
  const saved = new Map(CONTROLLED.map((name) => [name, process.env[name]]))
  for (const name of CONTROLLED) delete process.env[name]
  Object.assign(process.env, patch)
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

function frame(socket, message) {
  socket.send(JSON.stringify({ type: 'session', message }))
}

/**
 * A daemon stand-in: it speaks the client's own hello/status frames, records
 * what it was asked, and answers sends with `onSend`.
 */
async function daemon(t, { onSend, onHello, ipc = false } = {}) {
  const state = { hellos: [], sends: [], headers: [] }
  const handle = (socket, request) => {
    state.headers.push(request?.headers ?? {})
    socket.on('error', () => {})
    socket.on('message', (raw) => {
      const envelope = JSON.parse(raw.toString())
      if (envelope.type === 'ping') return void socket.send(JSON.stringify({ type: 'pong' }))
      if (envelope.type === 'hello') {
        state.hellos.push(envelope)
        if (onHello) return void onHello(socket, envelope, state)
        return void frame(socket, { type: 'status', payload: { status: 'server_info', serverId: 'srv_test', version: '0.11.2' } })
      }
      const message = envelope.message
      state.sends.push(message)
      const answer = onSend?.(message, socket, state)
      if (answer !== undefined) frame(socket, answer)
    })
  }
  const sockets = new Set()

  let endpoint
  let close
  let server
  if (ipc) {
    const home = await mkdtemp(join(sandbox, 'ipc-'))
    const socketPath = join(home, 'daemon.sock')
    const listening = http.createServer()
    const socketsOn = new WebSocketServer({ server: listening })
    socketsOn.on('connection', (socket, request) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); handle(socket, request) })
    listening.listen(socketPath)
    await once(listening, 'listening')
    endpoint = socketPath
    server = socketsOn
    close = () => new Promise((done) => { for (const socket of sockets) socket.terminate(); socketsOn.close(); listening.close(done) })
  } else {
    const socketsOn = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    socketsOn.on('connection', (socket, request) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); handle(socket, request) })
    await once(socketsOn, 'listening')
    endpoint = `tcp://127.0.0.1:${socketsOn.address().port}`
    server = socketsOn
    close = () => new Promise((done) => { for (const socket of sockets) socket.terminate(); socketsOn.close(done) })
  }
  t.after(close)
  return { state, endpoint, server, close }
}

const until = async (predicate) => {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise((done) => setTimeout(done, 5))
  return predicate()
}

const accepted = (message) => ({
  type: 'send_agent_message_response',
  payload: { requestId: message.requestId, agentId: message.agentId, accepted: true, error: null },
})
const refused = (message, error) => ({
  type: 'send_agent_message_response',
  payload: { requestId: message.requestId, agentId: message.agentId, accepted: false, error },
})
const home = (name) => mkdtemp(join(sandbox, name))

test('a Paseo send steers with the caller id and never interrupts', async (t) => {
  environment(t)
  const { state, endpoint } = await daemon(t, { onSend: accepted })
  const agent = await connect({ harness: 'paseo', agentId: 'agent-one', endpoint, password: 'pw' })

  assert.deepEqual(Object.keys(agent), ['harness', 'agentId', 'steer'])
  assert.equal('queue' in agent, false)
  assert.deepEqual(await agent.steer('exact text', { id: 'msg_caller' }), { id: 'msg_caller', proof: 'admitted' })

  const generated = await agent.steer('second text')
  assert.match(generated.id, /^[0-9a-f-]{36}$/)

  assert.deepEqual(state.sends, [
    { type: 'send_agent_message_request', requestId: state.sends[0].requestId, agentId: 'agent-one',
      text: 'exact text', messageId: 'msg_caller', activeTurnBehavior: 'steer' },
    { type: 'send_agent_message_request', requestId: state.sends[1].requestId, agentId: 'agent-one',
      text: 'second text', messageId: generated.id, activeTurnBehavior: 'steer' },
  ])
  assert.ok(state.sends.every((request) => request.activeTurnBehavior === 'steer'))
})

test('a key conflict is a refusal and an unknown agent is not found', async (t) => {
  environment(t)
  const conflict = await daemon(t, { onSend: (message) => refused(message, 'agent_request_key_conflict') })
  const agent = await connect({ harness: 'paseo', agentId: 'agent-one', endpoint: conflict.endpoint, password: 'pw' })
  await assert.rejects(agent.steer('text', { id: 'msg_dup' }), (error) => {
    assert.ok(error instanceof DeliveryError)
    assert.equal(error.code, 'rejected')
    assert.equal(error.maybeDelivered, false)
    assert.equal(error.id, 'msg_dup')
    return true
  })

  const missing = await daemon(t, { onSend: (message) => refused(message, 'Agent not found: agent-one') })
  const other = await connect({ harness: 'paseo', agentId: 'agent-one', endpoint: missing.endpoint, password: 'pw' })
  await assert.rejects(other.steer('text'), (error) => {
    assert.equal(error.code, 'session_not_found')
    assert.equal(error.maybeDelivered, false)
    return true
  })
})

test('an unanswered send is a timeout and a dropped connection is transport', async (t) => {
  environment(t)
  const silent = await daemon(t, { onSend: () => undefined })
  const waiting = await connect({ harness: 'paseo', agentId: 'agent-one', endpoint: silent.endpoint, password: 'pw' })
  await assert.rejects(waiting.steer('text', { timeoutMs: 200 }), (error) => {
    assert.equal(error.code, 'timeout')
    assert.equal(error.maybeDelivered, true)
    return true
  })

  const dropped = await daemon(t, { onSend: (message, socket) => { socket.terminate(); return undefined } })
  const broken = await connect({ harness: 'paseo', agentId: 'agent-one', endpoint: dropped.endpoint, password: 'pw' })
  await assert.rejects(broken.steer('text'), (error) => {
    assert.equal(error.code, 'transport')
    assert.equal(error.maybeDelivered, true)
    return true
  })
  // The daemon goes away entirely: a fresh connection proves nothing was written.
  await dropped.close()
  await assert.rejects(broken.steer('text'), (error) => {
    assert.equal(error.code, 'unavailable')
    assert.equal(error.maybeDelivered, false)
    return true
  })
})

test('an explicit credential wins, then the daemon local credential, then PASEO_PASSWORD', async (t) => {
  environment(t)
  const paseoHome = await home('paseo-home-')
  await writeFile(join(paseoHome, 'local-credential'), `${LOCAL_CREDENTIAL}\n`)

  const header = await daemon(t, { onSend: accepted })
  await connect({ harness: 'paseo', agentId: 'agent-one', endpoint: header.endpoint, paseoHome, authHeader: 'Bearer explicit-token' })
  assert.equal(header.state.hellos[0].auth, undefined)
  assert.equal(header.state.headers[0].authorization, 'Bearer explicit-token')

  const explicit = await daemon(t, { onSend: accepted })
  await connect({ harness: 'paseo', agentId: 'agent-one', endpoint: explicit.endpoint, paseoHome, password: 'explicit-password' })
  assert.deepEqual(explicit.state.hellos[0].auth, { kind: 'password', password: 'explicit-password' })

  const local = await daemon(t, { onSend: accepted })
  await connect({ harness: 'paseo', agentId: 'agent-one', endpoint: local.endpoint, paseoHome })
  assert.deepEqual(local.state.hellos[0].auth, { kind: 'localCredential', token: LOCAL_CREDENTIAL })
  assert.equal(local.state.headers[0].authorization, undefined)

  process.env.PASEO_PASSWORD = 'environment-password'
  const fromEnv = await daemon(t, { onSend: accepted })
  await connect({ harness: 'paseo', agentId: 'agent-one', endpoint: fromEnv.endpoint, paseoHome: await home('empty-home-') })
  assert.deepEqual(fromEnv.state.hellos[0].auth, { kind: 'password', password: 'environment-password' })

  delete process.env.PASEO_PASSWORD
  const anonymous = await daemon(t, { onSend: accepted })
  await connect({ harness: 'paseo', agentId: 'agent-one', endpoint: anonymous.endpoint, paseoHome: await home('empty-home-') })
  assert.equal(anonymous.state.hellos[0].auth, undefined)
})

test('the daemon address comes from the option, then PASEO_HOST, then the daemon state file', async (t) => {
  environment(t)
  const explicit = await daemon(t, { onSend: accepted })
  const first = await connect({ harness: 'paseo', agentId: 'agent-one', endpoint: explicit.endpoint, password: 'pw' })
  assert.equal((await first.steer('text')).proof, 'admitted')

  const named = await daemon(t, { onSend: accepted })
  process.env.PASEO_HOST = named.endpoint
  const second = await connect({ harness: 'paseo', agentId: 'agent-one', password: 'pw' })
  assert.equal((await second.steer('text')).proof, 'admitted')

  const stated = await daemon(t, { onSend: accepted })
  const paseoHome = await home('paseo-home-')
  await writeFile(join(paseoHome, 'paseo.pid'), JSON.stringify({ listen: stated.endpoint.replace('tcp://', '') }))
  delete process.env.PASEO_HOST
  const third = await connect({ harness: 'paseo', agentId: 'agent-one', paseoHome, password: 'pw' })
  assert.equal((await third.steer('text')).proof, 'admitted')

  const socket = await daemon(t, { onSend: accepted, ipc: true })
  const fourth = await connect({ harness: 'paseo', agentId: 'agent-one', endpoint: socket.endpoint, password: 'pw' })
  assert.equal((await fourth.steer('text')).proof, 'admitted')
})

test('a pending receipt is an unknown outcome, never a refusal', async (t) => {
  environment(t)
  const pending = await daemon(t, { onSend: (message) => refused(message, 'agent_request_outcome_unknown') })
  const agent = await connect({ harness: 'paseo', agentId: 'agent-one', endpoint: pending.endpoint, password: 'pw' })
  await assert.rejects(agent.steer('text', { id: 'msg_pending' }), (error) => {
    assert.ok(error instanceof DeliveryError)
    assert.equal(error.code, 'transport')
    assert.equal(error.maybeDelivered, true)
    assert.equal(error.id, 'msg_pending')
    return true
  })
})

test('a one-shot connect and steer lets the process exit at once', async (t) => {
  environment(t)
  const { state, endpoint } = await daemon(t, { onSend: accepted })
  const script = join(sandbox, 'paseo-one-shot.mjs')
  await writeFile(script, `import { connect } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}
const agent = await connect({ harness: 'paseo', agentId: 'agent-one', endpoint: process.argv[2], password: 'pw' })
console.log(JSON.stringify(await agent.steer('one shot', { id: 'msg_one_shot' })))
`)
  const started = Date.now()
  const child = await exec(process.execPath, [script, endpoint], { timeout: 30_000 })
  const elapsed = Date.now() - started
  assert.deepEqual(JSON.parse(child.stdout), { id: 'msg_one_shot', proof: 'admitted' })
  assert.deepEqual(state.sends.map((request) => request.messageId), ['msg_one_shot'])
  assert.ok(elapsed < 3_000, `one-shot connect and steer took ${elapsed}ms`)
})

test('a refused connection is an authentication failure', async (t) => {
  environment(t)
  const { endpoint } = await daemon(t, { onHello: (socket) => socket.close(4401, 'Incorrect password') })
  await assert.rejects(connect({ harness: 'paseo', agentId: 'agent-one', endpoint, password: 'wrong' }), (error) => {
    assert.ok(error instanceof DeliveryError)
    assert.equal(error.code, 'authentication_failed')
    assert.equal(error.maybeDelivered, false)
    assert.equal(error.message.includes('wrong'), false)
    assert.equal(error.message.includes('127.0.0.1'), false)
    return true
  })
})

test('unusable arguments and a dead daemon fail before anything is sent', async (t) => {
  environment(t)
  const { state, endpoint } = await daemon(t, { onSend: accepted })
  for (const options of [
    { harness: 'paseo', agentId: 'agent-one', endpoint: 'not-an-endpoint' },
    { harness: 'paseo', agentId: '   ', endpoint },
    { harness: 'paseo', agentId: 'agent-one', endpoint, password: '   ' },
    { harness: 'paseo', agentId: 'agent-one', endpoint, timeoutMs: 0 },
  ]) {
    await assert.rejects(connect(options), (error) => {
      assert.equal(error.code, 'invalid_arguments')
      assert.equal(error.maybeDelivered, false)
      return true
    })
  }

  const agent = await connect({ harness: 'paseo', agentId: 'agent-one', endpoint, password: 'pw' })
  await assert.rejects(agent.steer(''), (error) => {
    assert.equal(error.code, 'invalid_arguments')
    assert.equal(error.maybeDelivered, false)
    return true
  })
  await assert.rejects(agent.steer('text', { id: '   ' }), { code: 'invalid_arguments' })
  assert.deepEqual(state.sends, [])

  const closed = net.createServer()
  closed.listen(0, '127.0.0.1')
  await once(closed, 'listening')
  const dead = `tcp://127.0.0.1:${closed.address().port}`
  await new Promise((done) => closed.close(done))
  await assert.rejects(connect({ harness: 'paseo', agentId: 'agent-one', endpoint: dead, password: 'pw' }), (error) => {
    assert.ok(error instanceof DeliveryError)
    assert.equal(error.code, 'unavailable')
    assert.equal(error.maybeDelivered, false)
    return true
  })
})

test('a connection that never becomes ready is a timeout and is closed', async (t) => {
  environment(t)
  const { endpoint, server } = await daemon(t, { onHello: () => undefined })
  await assert.rejects(connect({ harness: 'paseo', agentId: 'agent-one', endpoint, password: 'pw', timeoutMs: 200 }), (error) => {
    assert.equal(error.code, 'timeout')
    assert.equal(error.maybeDelivered, false)
    return true
  })
  assert.equal(await until(() => server.clients.size === 0), true)
})
