import './sandbox-env.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sandbox } from './sandbox-env.js'
import { createCodexBoundaryStore, handleCodexHook } from '../dist/codex-hook.js'
import { sendCodexQueue, CodexQueueSendError } from '../dist/codex-queue.js'

async function fixture() {
  const root = await mkdtemp(join(sandbox, 'hook-'))
  const file = join(root, 'boundaries.json')
  return { root, file, boundaries: createCodexBoundaryStore(file) }
}
const input = (event, turn_id = 'turn-1') => ({ session_id: 'target', hook_event_name: event, turn_id })

test('Stop epochs are unique, exact and invalidated by every active/lifecycle boundary', async () => {
  const { file, boundaries } = await fixture()
  const other = createCodexBoundaryStore(file)
  const run = event => handleCodexHook(input(event), { boundaries })
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Interrupt', 'SessionEnd']) {
    await run('SessionStart')
    await run('Stop')
    const epoch = (await other.read('target')).stop
    assert.ok(epoch.token)
    assert.equal(epoch.turnId, 'turn-1')
    assert.equal(await other.queueEligible('target', epoch), true)
    await run('Stop')
    assert.equal(await other.queueEligible('target', epoch), false)
    await run(event)
    assert.equal(await other.queueEligible('target'), false)
  }
  await run('Stop') // A late callback cannot reopen SessionEnd.
  assert.equal(await other.queueEligible('target'), false)
})

test('old boundary data and malformed Stop identity cannot arm a receiver', async () => {
  const { file, boundaries } = await fixture()
  await writeFile(file, JSON.stringify({ v: 1, nextSequence: 2, threads: { target: { lastStop: 2, lastNonStop: 1 } } }))
  assert.equal(await boundaries.queueEligible('target'), false)
  for (const value of [input('SessionResume'), input('unknown'), { session_id: 'target', hook_event_name: 'Stop' },
    { ...input('Stop'), turn_id: '' }, { ...input('Stop'), session_id: 'bad\0id' }]) {
    await handleCodexHook(value, { boundaries })
    assert.equal(await boundaries.queueEligible('target'), false)
  }
})

test('all active boundaries return event-correct context; Stop only arms and Interrupt disarms before cancel', async () => {
  const { boundaries } = await fixture()
  const contexts = []
  const options = { boundaries, pull: async (id, _signal, event) => {
    assert.equal(id, 'target')
    assert.equal(await boundaries.queueEligible(id), false)
    contexts.push(event)
    return '/literal\n字'
  }, interrupt: async id => assert.equal(await boundaries.queueEligible(id), false) }
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse']) {
    await handleCodexHook(input('Stop'), options)
    assert.deepEqual(await handleCodexHook(input(event), options), {
      hookSpecificOutput: { hookEventName: event, additionalContext: '/literal\n字' },
    })
  }
  await handleCodexHook(input('Stop'), options)
  await handleCodexHook(input('Interrupt'), options)
  assert.equal(contexts.length, 3)
})

test('hook cooperatively cancels uncommitted pulls but retains post-effect settlement and output', async () => {
  const { boundaries } = await fixture()
  let cancelled = false
  assert.equal(await handleCodexHook(input('PreToolUse'), { boundaries, timeoutMs: 50,
    pull: async (_id, signal) => new Promise(resolve => signal.addEventListener('abort', () => {
      cancelled = true; resolve(undefined)
    }, { once: true })),
  }), undefined)
  assert.equal(cancelled, true)
  const aborted = Promise.withResolvers(), settlement = Promise.withResolvers()
  let finished = false
  const response = handleCodexHook(input('UserPromptSubmit'), { boundaries, timeoutMs: 50,
    pull: async (_id, signal) => {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true })
      await settlement.promise
      return 'settled preview 字'
    },
  }).then(value => { finished = true; return value })
  await aborted.promise
  assert.equal(finished, false)
  settlement.resolve()
  assert.deepEqual(await response, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'settled preview 字' } })
})

test('CLI queue defaults to normal startup and uses remote only when explicitly selected', async () => {
  const { root } = await fixture()
  const child = join(root, 'queue.cjs'), capture = join(root, 'args.json')
  await writeFile(child, "require('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)))")
  await sendCodexQueue({ threadId: 'target', message: '/literal\n  unchanged 🦈' }, {
    bin: process.execPath, args: [child], env: { ...process.env, CAPTURE: capture, CODEX_HOME: root },
  })
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), ['queue', '--thread', 'target', '--message', '/literal\n  unchanged 🦈'])
  await sendCodexQueue({ threadId: 'target', message: 'remote text' }, {
    bin: process.execPath, args: [child], endpoint: 'unix:///explicit.sock', env: { ...process.env, CAPTURE: capture },
  })
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), ['queue', '--remote', 'unix:///explicit.sock', '--thread', 'target', '--message', 'remote text'])
})

test('CLI launch failure is known-unsent; a killed child or unexplained error is unknown, never retried', async () => {
  const { root } = await fixture()
  const child = join(root, 'queue.cjs'), count = join(root, 'calls')
  const request = { threadId: 'target', message: 'private body' }
  await assert.rejects(() => sendCodexQueue(request, { bin: join(root, 'absent') }),
    error => error instanceof CodexQueueSendError && !error.maybeDelivered && error.code === 'unavailable')
  await writeFile(child, "require('node:fs').appendFileSync(process.env.COUNT, 'x');setInterval(()=>{},1000)")
  await assert.rejects(() => sendCodexQueue(request, { bin: process.execPath, args: [child],
    env: { ...process.env, COUNT: count }, timeoutMs: 500 }),
    error => error instanceof CodexQueueSendError && error.kind === 'unknown' && error.code === 'timeout')
  assert.equal(await readFile(count, 'utf8'), 'x')
  await writeFile(child, "process.stderr.write('timeout private body');process.exit(1)")
  await assert.rejects(() => sendCodexQueue(request, { bin: process.execPath, args: [child] }),
    error => error.maybeDelivered && !error.message.includes('private body'))
})
