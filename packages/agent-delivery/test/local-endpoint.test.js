import './sandbox-env.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { connectLocal, LocalEndpointError, parseLocalEndpoint } from '../dist/local-endpoint.js'
import { sandbox } from './sandbox-env.js'

test('unix endpoints must be absolute, NUL-free and within the platform sun_path limit', () => {
  assert.deepEqual(parseLocalEndpoint('/private/tmp/./a/../in.sock'), { path: '/private/tmp/in.sock' })
  for (const invalid of ['in.sock', './in.sock', '', '/tmp/\0in.sock', undefined, 42]) {
    assert.throws(() => parseLocalEndpoint(invalid))
  }
  const limit = process.platform === 'darwin' ? 103 : process.platform === 'linux' ? 107 : undefined
  if (limit !== undefined) {
    const prefix = '/tmp/'
    assert.equal(parseLocalEndpoint(prefix + 'a'.repeat(limit - prefix.length)).path, prefix + 'a'.repeat(limit - prefix.length))
    assert.throws(() => parseLocalEndpoint(prefix + 'a'.repeat(limit - prefix.length + 1)))
  }
})

test('connecting is the existence check: absent endpoints are unavailable', async (t) => {
  const directory = await mkdtemp(join(sandbox, 'local-'))
  await assert.rejects(connectLocal(parseLocalEndpoint(join(directory, 'dead.sock'))), (error) => {
    assert.ok(error instanceof LocalEndpointError)
    assert.equal(error.code, 'unavailable')
    return true
  })
  const controller = new AbortController()
  controller.abort('private reason')
  await assert.rejects(connectLocal(parseLocalEndpoint(join(directory, 'dead.sock')), { signal: controller.signal }), { code: 'aborted' })
  await assert.rejects(connectLocal(parseLocalEndpoint(join(directory, 'dead.sock')), { timeoutMs: 1_000 }), { code: 'unavailable' })
})
