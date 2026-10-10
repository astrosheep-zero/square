import './sandbox-env.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paseoHome, resolvePaseoDaemon } from '../dist/paseo-native.js'
import { sandbox } from './sandbox-env.js'

const home = (name) => mkdtemp(join(sandbox, name))

test('the daemon address comes from the endpoint, then PASEO_HOST, then the daemon state file', async () => {
  const configOnly = await home('native-config-')
  await writeFile(join(configOnly, 'config.json'), JSON.stringify({ daemon: { listen: '10.0.0.5:6767' } }))
  assert.deepEqual(resolvePaseoDaemon('tcp://explicit.test:7443', {}, configOnly), { url: 'ws://explicit.test:7443/ws' })
  assert.deepEqual(
    resolvePaseoDaemon(undefined, { PASEO_HOST: 'tcp://named.test:9000' }, configOnly),
    { url: 'ws://named.test:9000/ws' },
  )
  assert.deepEqual(resolvePaseoDaemon(undefined, {}, configOnly), { url: 'ws://10.0.0.5:6767/ws' })

  const pidFirst = await home('native-pid-')
  await writeFile(join(pidFirst, 'paseo.pid'), JSON.stringify({ listen: '127.0.0.1:7100' }))
  await writeFile(join(pidFirst, 'config.json'), JSON.stringify({ daemon: { listen: '10.0.0.5:6767' } }))
  assert.deepEqual(resolvePaseoDaemon(undefined, {}, pidFirst), { url: 'ws://127.0.0.1:7100/ws' })

  // An absent daemon state falls back to the documented TCP default.
  assert.deepEqual(resolvePaseoDaemon(undefined, {}, await home('native-empty-')), { url: 'ws://127.0.0.1:6767/ws' })
  // An explicit endpoint that is not a daemon spelling is an argument error, never a fallback.
  assert.equal(resolvePaseoDaemon('not-an-endpoint', { PASEO_HOST: 'tcp://named.test:9000' }, configOnly), undefined)
})

test('tcp Paseo spellings keep their TLS shape, port default and IPv6 host', () => {
  assert.deepEqual(resolvePaseoDaemon('tcp://[::1]:6767?ssl=true', {}), { url: 'wss://[::1]:6767/ws' })
  assert.deepEqual(
    resolvePaseoDaemon('tcp://example.test:7443?ssl=true&password=uri-secret', {}),
    { url: 'wss://example.test:7443/ws', password: 'uri-secret' },
  )
  assert.deepEqual(resolvePaseoDaemon('tcp://example.test?ssl=true', {}), { url: 'wss://example.test:6767/ws' })
  assert.deepEqual(resolvePaseoDaemon('7443', {}), { url: 'ws://127.0.0.1:7443/ws' })
})

test('a tcp endpoint password rides on the target, and an empty one is no password', () => {
  const env = { PASEO_PASSWORD: 'environment-password' }
  assert.deepEqual(
    resolvePaseoDaemon('tcp://secure.test:7443?ssl=true&password=uri-secret', env),
    { url: 'wss://secure.test:7443/ws', password: 'uri-secret' },
  )
  assert.deepEqual(resolvePaseoDaemon('tcp://secure.test:7443?password=', env), { url: 'ws://secure.test:7443/ws' })
})

test('a Paseo socket path resolves to an IPC target', {
  skip: process.platform === 'win32' ? 'Unix sockets are unsupported on Windows.' : false,
}, () => {
  assert.deepEqual(resolvePaseoDaemon('unix:///tmp/paseo.sock', {}), {
    url: 'ws+unix:///tmp/paseo.sock:/ws',
    socketPath: '/tmp/paseo.sock',
  })
})

test('Windows reports a Unix Paseo socket as unusable', {
  skip: process.platform !== 'win32' ? 'Windows-only capability boundary.' : false,
}, () => {
  assert.equal(resolvePaseoDaemon('unix:///tmp/paseo.sock', {}), undefined)
})

test('Paseo home expands an explicit or environment `~/` path before the default', async () => {
  const explicit = await home('native-home-')
  assert.equal(paseoHome(explicit, {}), explicit)
  assert.equal(paseoHome(undefined, { PASEO_HOME: explicit }), explicit)
  assert.equal(paseoHome(undefined, { PASEO_HOME: '  ' }), join(process.env.HOME, '.paseo'))
  assert.equal(paseoHome('~/nested', {}), join(process.env.HOME, 'nested'))
})
