import './sandbox-env.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { asActivityId, createStateStore, emptyState, loadState, rememberMessage, saveState } from '../dist/state.js'
import { caseDir } from './fixtures.js'

test('a missing state file starts fresh without replaying history', async () => {
  const root = await caseDir('state')
  const loaded = await loadState(join(root, 'bridge.json'))
  assert.deepEqual(loaded.state, emptyState())
  assert.equal(loaded.fresh, true)
})

test('state round-trips through an atomic write', async () => {
  const root = await caseDir('state')
  const file = join(root, 'nested/bridge.json')
  const state = emptyState()
  rememberMessage(state, 'act/1', '1700.1', '1700.0')
  state.cursor = 'act/1'
  state.users.U01 = 'alice'
  await saveState(file, state)
  const loaded = await loadState(file)
  assert.equal(loaded.fresh, false)
  assert.deepEqual(loaded.state, {
    version: 1,
    cursor: 'act/1',
    users: { U01: 'alice' },
    tsToActivity: { '1700.1': 'act/1' },
    activityToTs: { 'act/1': { ts: '1700.1', threadTs: '1700.0' } },
  })
  assert.deepEqual(await readdir(join(root, 'nested')), ['bridge.json'])
})

test('concurrent saves keep every mutation and never collide on the temporary file', async () => {
  const root = await caseDir('state')
  const file = join(root, 'bridge.json')
  const store = createStateStore(file, emptyState())
  rememberMessage(store.state, 'act/1', '1700.1')
  const first = store.save()
  rememberMessage(store.state, 'act/2', '1700.2')
  const second = store.save()
  await Promise.all([first, second])
  assert.deepEqual(Object.keys((await loadState(file)).state.tsToActivity), ['1700.1', '1700.2'])
  assert.deepEqual(await readdir(root), ['bridge.json'])
})

test('the message map keeps its most recent entries in both directions', () => {
  const state = emptyState()
  for (let index = 0; index < 5003; index += 1) rememberMessage(state, `act/${index}`, `1700.${index}`)
  assert.equal(Object.keys(state.tsToActivity).length, 5000)
  assert.equal(Object.keys(state.activityToTs).length, 5000)
  assert.equal(state.tsToActivity['1700.0'], undefined)
  assert.equal(state.tsToActivity['1700.5002'], 'act/5002')
  assert.deepEqual(state.activityToTs['act/5002'], { ts: '1700.5002', threadTs: '1700.5002' })
})

test('corrupt, unknown and unsupported state refuses instead of resetting', async () => {
  const root = await caseDir('state')
  const cases = [
    ['{ not json', /is not valid JSON/],
    [JSON.stringify({ version: 2, cursor: null, users: {}, tsToActivity: {}, activityToTs: {} }), /unsupported version 2/],
    [JSON.stringify({ version: 1, cursor: 'latest', users: {}, tsToActivity: {}, activityToTs: {} }), /cursor must be an activity id/],
    [JSON.stringify({ version: 1, cursor: null, users: {}, tsToActivity: { '1700.1': 7 }, activityToTs: {} }), /tsToActivity/],
    [JSON.stringify({ version: 1, cursor: null, users: {}, tsToActivity: {}, activityToTs: { 'act/1': { ts: '1' } } }), /activityToTs/],
    ['[]', /expected a JSON object/],
  ]
  for (const [body, expected] of cases) {
    const file = join(root, 'case.json')
    await writeFile(file, body)
    const error = await loadState(file).catch((failure) => failure)
    assert.match(error.message, expected, body)
  }
  assert.equal(asActivityId('act/0'), 'act/0')
  assert.equal(asActivityId('act/01'), undefined)
  assert.equal(asActivityId(null), undefined)
})
