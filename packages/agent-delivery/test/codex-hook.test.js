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

test('independent hook processes share Stop eligibility; prompts, resume and end retire it', async () => {
  const { file, boundaries } = await fixture()
  const other = createCodexBoundaryStore(file)
  const events = []
  const options = { boundaries, pull: async (id) => { events.push(['pull', id]); return '/literal\n字' },
    sweep: async () => { events.push(['sweep', await other.queueEligible('target')]) },
    end: async (id) => { events.push(['end', id]) } }
  const run = (event) => handleCodexHook({ session_id: 'target', hook_event_name: event }, options)
  await run('SessionStart')
  assert.equal(await other.queueEligible('target'), false)
  await run('Stop')
  assert.deepEqual(events, [['sweep', true]])
  await run('UserPromptSubmit')
  assert.equal(await other.queueEligible('target'), false)
  assert.deepEqual(await run('PostToolUse'), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '/literal\n字' } })
  assert.deepEqual(events.slice(-2), [['pull', 'target'], ['sweep', false]])
  await run('Stop')
  await run('SessionResume')
  assert.equal(await other.queueEligible('target'), false)
  await run('Stop')
  await run('SessionEnd')
  assert.equal((await other.read('target')).ended, true)
  assert.equal(await other.queueEligible('target'), false)
  assert.deepEqual(events.at(-1), ['end', 'target'])
  await run('Stop') // A delayed callback cannot undo SessionEnd.
  assert.equal(await other.queueEligible('target'), false)
  await run('UserPromptSubmit')
  await run('Stop')
  assert.equal(await other.queueEligible('target'), false)
  await run('SessionResume')
  await run('Stop')
  assert.equal(await other.queueEligible('target'), true)
})

test('the host claims its own pending input; a hook pull leaves nothing for the following Stop queue', async () => {
  const { boundaries } = await fixture()
  let pending = 'one input', queued = 0
  const options = { boundaries,
    pull: async () => { const text = pending; pending = undefined; return text },
    sweep: async () => { if (pending && await boundaries.queueEligible('target')) { queued++; pending = undefined } } }
  await handleCodexHook({ session_id: 'target', hook_event_name: 'PostToolUse' }, options)
  await handleCodexHook({ session_id: 'target', hook_event_name: 'Stop' }, options)
  assert.equal(queued, 0)
  pending = 'later input'
  await handleCodexHook({ session_id: 'target', hook_event_name: 'Stop' }, options)
  assert.equal(queued, 1)
})

test('invalid events leave state untouched and an uncommitted pull cooperatively cancels at its budget', async () => {
  const { boundaries } = await fixture()
  const before = await boundaries.read('target')
  await handleCodexHook({ session_id: 'target', hook_event_name: 'unknown' }, { boundaries })
  assert.equal(await boundaries.read('target'), before)
  let cancelled = false
  const response = await handleCodexHook({ session_id: 'target', hook_event_name: 'PostToolUse' }, {
    boundaries, timeoutMs: 100,
    pull: async (_id, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { cancelled = true; resolve(undefined) }, { once: true })
    }),
    sweep: async () => { assert.fail('an expired hook must not sweep') },
  })
  assert.equal(cancelled, true)
  assert.equal(response, undefined)
})

test('hook awaits host presentation settlement past cancellation and returns its committed text', async () => {
  const { boundaries } = await fixture()
  const aborted = Promise.withResolvers(), settlement = Promise.withResolvers()
  let finished = false, settled = false
  const response = handleCodexHook({ session_id: 'target', hook_event_name: 'PostToolUse' }, {
    boundaries, timeoutMs: 100,
    pull: async (_id, signal) => {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true })
      // The host has presented; its evidence settlement deliberately survives cancellation.
      await settlement.promise
      settled = true
      return 'settled host preview 字'
    },
    sweep: async () => { assert.fail('settlement outlived the budget; no sweep may start') },
  }).then(value => { finished = true; return value })
  await aborted.promise
  await new Promise(setImmediate)
  const abandonedSettlement = finished
  settlement.resolve()
  const result = await response
  assert.equal(abandonedSettlement, false, 'the hook must not race away from host custody')
  assert.equal(settled, true)
  assert.deepEqual(result, { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'settled host preview 字' } })
})

test('a timed-out sweep preserves the already committed pull output', async () => {
  const { boundaries } = await fixture()
  let committed = false, release
  const stalled = new Promise((resolve) => { release = resolve })
  const response = await handleCodexHook({ session_id: 'target', hook_event_name: 'PostToolUse' }, {
    boundaries, timeoutMs: 80,
    pull: async () => { committed = true; return 'committed host preview' },
    sweep: () => stalled,
  })
  assert.equal(committed, true)
  assert.equal(response.hookSpecificOutput.additionalContext, 'committed host preview')
  release()
})

test('CLI queue defaults to normal startup and uses remote only when explicitly selected', async () => {
  const { root } = await fixture()
  const child = join(root, 'queue.cjs'), capture = join(root, 'args.json')
  await writeFile(child, "require('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)))")
  await sendCodexQueue({ threadId: 'target', message: '/literal\n  unchanged 🦈' }, {
    bin: process.execPath, args: [child], env: { ...process.env, CAPTURE: capture, CODEX_HOME: root },
  })
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), ['queue',
    '--thread', 'target', '--message', '/literal\n  unchanged 🦈'])
  await sendCodexQueue({ threadId: 'target', message: 'remote text' }, {
    bin: process.execPath, args: [child], endpoint: 'unix:///explicit.sock', env: { ...process.env, CAPTURE: capture },
  })
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), ['queue', '--remote',
    'unix:///explicit.sock', '--thread', 'target', '--message', 'remote text'])
})

test('CLI launch failure is known-unsent; a killed child or unexplained error is unknown, never retried', async () => {
  const { root } = await fixture()
  const child = join(root, 'queue.cjs'), count = join(root, 'calls')
  const request = { threadId: 'target', message: 'private body' }
  await assert.rejects(() => sendCodexQueue(request, { bin: join(root, 'absent') }),
    (error) => error instanceof CodexQueueSendError && !error.maybeDelivered && error.code === 'unavailable')
  await writeFile(child, "require('node:fs').appendFileSync(process.env.COUNT, 'x');setInterval(()=>{},1000)")
  await assert.rejects(() => sendCodexQueue(request, { bin: process.execPath, args: [child],
    env: { ...process.env, COUNT: count }, timeoutMs: 500 }),
    (error) => error instanceof CodexQueueSendError && error.kind === 'unknown' && error.code === 'timeout')
  assert.equal(await readFile(count, 'utf8'), 'x')
  await writeFile(child, "process.stderr.write('timeout private body');process.exit(1)")
  await assert.rejects(() => sendCodexQueue(request, { bin: process.execPath, args: [child] }),
    (error) => error.maybeDelivered && !error.message.includes('private body'))
})
