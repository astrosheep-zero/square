import './sandbox-env.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { connect, DeliveryError } from '../dist/index.js'
import { createCodexBoundaryStore, handleCodexHook } from '../dist/codex-hook.js'
import { sandbox } from './sandbox-env.js'

async function fixture() {
  const root = await mkdtemp(join(sandbox, 'cli-'))
  const child = join(root, 'queue.cjs'), capture = join(root, 'calls')
  await writeFile(child, "require('node:fs').appendFileSync(process.env.CAPTURE,JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME})+'\\n')")
  const boundaries = createCodexBoundaryStore(join(root, 'boundaries.json'))
  return { root, child, capture, boundaries,
    options: { harness: 'codex', transport: 'cli', sessionId: 'target', boundaries,
      bin: process.execPath, args: [child], env: { ...process.env, CAPTURE: capture }, codexHome: root },
    calls: async () => (await readFile(capture, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse),
  }
}
const rejected = (code, maybeDelivered = false) => (error) => {
  assert.ok(error instanceof DeliveryError)
  assert.equal(error.code, code)
  assert.equal(error.maybeDelivered, maybeDelivered)
  assert.equal(/private|\/tmp\/|secret/.test(error.message), false)
  return true
}
async function waitFor(fn) {
  const until = Date.now() + 3000
  while (Date.now() < until) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('fixture child did not start')
}

test('CLI connects once and exposes only queue, with one lifecycle check per send and captured coordinates', async () => {
  const f = await fixture()
  let checks = 0
  const agent = await connect({ ...f.options, boundaries: { queueEligible: async (id) => {
    assert.equal(id, 'target'); checks++; return true
  } } })
  assert.equal(checks, 0)
  assert.equal(Object.isFrozen(agent), true)
  assert.equal(agent.transport, 'cli')
  assert.equal('steer' in agent, false)
  f.options.env.CODEX_HOME = '/changed-after-connect'
  f.options.args.push('must-not-reach-child')
  const receipt = await agent.queue('/exact\n  字 🦈')
  const second = await agent.queue('second')
  assert.equal(receipt.proof, 'admitted')
  assert.match(receipt.id, /^[0-9a-f-]{36}$/)
  assert.notEqual(receipt.id, second.id)
  assert.equal(checks, 2)
  assert.deepEqual(await f.calls(), [
    { args: ['queue', '--thread', 'target', '--message', '/exact\n  字 🦈'], home: f.root },
    { args: ['queue', '--thread', 'target', '--message', 'second'], home: f.root },
  ])
})

test('the bound hook lifecycle blocks SessionEnd and late Stop without caller-side checks', async () => {
  const f = await fixture()
  const agent = await connect(f.options)
  const hook = (event) => handleCodexHook({ session_id: 'target', hook_event_name: event }, { boundaries: f.boundaries })
  await assert.rejects(agent.queue('not stopped'), rejected('session_inactive'))
  await hook('Stop')
  await agent.queue('first')
  await hook('SessionEnd')
  await assert.rejects(agent.queue('ended'), rejected('session_inactive'))
  await hook('Stop')
  await assert.rejects(agent.queue('late Stop'), rejected('session_inactive'))
  assert.equal((await f.calls()).length, 1)
  await hook('SessionResume')
  await hook('Stop')
  await agent.queue('resumed')
  assert.equal((await f.calls()).length, 2)
})

test('CLI configuration and send preconditions reject locally before lifecycle or child work', async () => {
  const f = await fixture()
  for (const more of [
    { boundaries: undefined }, { boundaries: {} }, { bin: '' }, { codexHome: 'relative' },
    { endpoint: '' }, { args: [null] }, { env: { SECRET: 123 } }, { signal: {} }, { timeoutMs: NaN },
    { transport: 'typo' },
  ]) await assert.rejects(connect({ ...f.options, ...more }), rejected('invalid_arguments'))
  await assert.rejects(connect({ ...f.options, signal: AbortSignal.abort() }), rejected('aborted'))
  let checks = 0
  const agent = await connect({ ...f.options, boundaries: { queueEligible: async () => { checks++; return true } } })
  for (const [text, options] of [
    ['', {}], ['text', { id: 'not-idempotent' }], ['text', { signal: {} }], ['text', { timeoutMs: 0 }],
    ['text', 'invalid'], ['private\0body', {}],
  ]) await assert.rejects(agent.queue(text, options), rejected('invalid_arguments'))
  await assert.rejects(agent.queue('preaborted', { signal: AbortSignal.abort() }), rejected('aborted'))
  assert.equal(checks, 0)
  assert.deepEqual(await f.calls(), [])
})

test('lifecycle waits are bounded and fail known-unsent; a dead executable is also known-unsent', async () => {
  const f = await fixture()
  const stalled = await connect({ ...f.options, boundaries: { queueEligible: () => new Promise(() => {}) } })
  await assert.rejects(stalled.queue('private', { timeoutMs: 40 }), rejected('timeout'))
  const broken = await connect({ ...f.options, boundaries: { queueEligible: async () => { throw new Error('secret path') } } })
  await assert.rejects(broken.queue('private'), rejected('unavailable'))
  await f.boundaries.record('target', 'Stop')
  const absent = await connect({ ...f.options, bin: join(f.root, 'absent') })
  await assert.rejects(absent.queue('private'), rejected('unavailable'))
  assert.deepEqual(await f.calls(), [])
})

test('postlaunch timeout and abort are unknown, terminate the child and never retry', async () => {
  const f = await fixture()
  await f.boundaries.record('target', 'Stop')
  await writeFile(f.child, "require('node:fs').appendFileSync(process.env.CAPTURE,'{}\\n');setInterval(()=>{},1000)")
  const agent = await connect(f.options)
  await assert.rejects(agent.queue('private', { timeoutMs: 500 }), rejected('timeout', true))
  const controller = new AbortController()
  const sending = agent.queue('private', { signal: controller.signal })
  const checked = assert.rejects(sending, rejected('aborted', true))
  await waitFor(async () => (await f.calls()).length === 2)
  controller.abort('private reason')
  await checked
  assert.equal((await f.calls()).length, 2)
})
