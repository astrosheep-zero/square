import './sandbox-env.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sandbox } from './sandbox-env.js'
import { withFileLock, FileLockError } from '../dist/file-lock.js'

test('skipIfBusy returns without entering a held lock; ordinary acquisition still waits and can abort', async () => {
  const root = await mkdtemp(join(sandbox, 'lock-busy-'))
  const file = join(root, 'held.lock')
  await withFileLock(file, { retryMs: 1 }, async () => {
    const skipped = await withFileLock(file, { retryMs: 1, skipIfBusy: true, signal: AbortSignal.timeout(500) },
      () => assert.fail('a skipped lock must not run its callback'))
    assert.equal(skipped, undefined)
    const controller = new AbortController()
    // No mkdir await: this acquisition reaches SQLITE_BUSY before the abort.
    const waiting = withFileLock(file, { retryMs: 1, createParent: false, signal: controller.signal },
      () => assert.fail('an ordinary waiter must not enter while the holder is active'))
    controller.abort(new Error('cancel ordinary waiter'))
    await assert.rejects(waiting, error => error.name === 'AbortError' && error.cause?.message === 'cancel ordinary waiter')
  })
  assert.equal(await withFileLock(file, { retryMs: 1, skipIfBusy: true }, () => 'acquired after release'), 'acquired after release')
})

test('skipIfBusy does not swallow callback or invalid-database errors and always releases its lock', async () => {
  const root = await mkdtemp(join(sandbox, 'lock-errors-'))
  const file = join(root, 'held.lock')
  await assert.rejects(withFileLock(file, { retryMs: 1, skipIfBusy: true }, () => { throw new Error('callback failed') }), /callback failed/)
  assert.equal(await withFileLock(file, { retryMs: 1, skipIfBusy: true }, () => 'released after failure'), 'released after failure')
  const invalid = join(root, 'invalid.lock')
  await writeFile(invalid, 'not SQLite')
  await assert.rejects(withFileLock(invalid, { retryMs: 1, skipIfBusy: true }, () => assert.fail('invalid lock callback')),
    error => error instanceof FileLockError && error.code === 'not_a_database')
  assert.equal(await readFile(invalid, 'utf8'), 'not SQLite')
})
