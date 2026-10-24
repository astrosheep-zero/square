import './sandbox-env.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig } from '../dist/config.js'
import { caseDir } from './fixtures.js'

const env = {
  SLACK_BRIDGE_APP_TOKEN: 'xapp-secret',
  SLACK_BRIDGE_BOT_TOKEN: 'xoxb-secret',
  SLACK_FAYE_BOT_TOKEN: 'xoxp-secret',
}

async function writeConfig(body, name = 'bridge.json') {
  const root = await caseDir('config')
  await mkdir(join(root, 'squares'), { recursive: true })
  const file = join(root, name)
  await writeFile(file, typeof body === 'string' ? body : JSON.stringify(body))
  return { root, file }
}

const valid = {
  square: 'squares/team.square',
  channel: 'C0123456789',
  bridge: { appTokenEnv: 'SLACK_BRIDGE_APP_TOKEN', botTokenEnv: 'SLACK_BRIDGE_BOT_TOKEN' },
  personas: { faye: { botTokenEnv: 'SLACK_FAYE_BOT_TOKEN' } },
}

async function prepared(body, { touchSquare = true } = {}) {
  const { root, file } = await writeConfig(body)
  if (touchSquare) await writeFile(join(root, 'squares/team.square'), '')
  return { root, file }
}

test('relative paths resolve against the config file and secrets come from the environment', async () => {
  const { root, file } = await prepared(valid)
  const settings = await loadConfig(file, env)
  assert.equal(settings.square, join(root, 'squares/team.square'))
  assert.equal(settings.state, join(root, 'squares/team.square.slack-bridge.json'))
  assert.equal(settings.channel, 'C0123456789')
  assert.deepEqual(settings.bridge, { appToken: 'xapp-secret', botToken: 'xoxb-secret' })
  assert.deepEqual([...settings.personas], [['faye', 'xoxp-secret']])
})

test('an explicit state path resolves against the config file', async () => {
  const { root, file } = await prepared({ ...valid, state: 'state/bridge.json' })
  assert.equal((await loadConfig(file, env)).state, join(root, 'state/bridge.json'))
})

test('a missing environment variable is named, and no token value is printed', async () => {
  const { file } = await prepared(valid)
  const error = await loadConfig(file, { ...env, SLACK_FAYE_BOT_TOKEN: '' }).catch((failure) => failure)
  assert.match(error.message, /SLACK_FAYE_BOT_TOKEN/)
  assert.doesNotMatch(error.message, /xoxp-secret|xapp-secret|xoxb-secret/)
})

test('invalid configuration refuses with the offending field', async () => {
  const cases = [
    [{ ...valid, channel: 'general' }, /channel must be a Slack channel ID/],
    [{ ...valid, extra: true }, /unknown field "extra"/],
    [{ ...valid, bridge: { ...valid.bridge, appTokenEnv: '' } }, /bridge\.appTokenEnv must be a non-empty string/],
    [{ ...valid, personas: { 'a b': { botTokenEnv: 'SLACK_FAYE_BOT_TOKEN' } } }, /not a valid participant name/],
    [{ ...valid, personas: { 'slack/faye': { botTokenEnv: 'SLACK_FAYE_BOT_TOKEN' } } }, /reserved slack\/ participant prefix/],
    [{ ...valid, personas: { faye: {} } }, /personas\.faye\.botTokenEnv must be a non-empty string/],
    [{ ...valid, square: undefined }, /square must be a non-empty string/],
  ]
  for (const [body, expected] of cases) {
    const { file } = await prepared(body)
    const error = await loadConfig(file, env).catch((failure) => failure)
    assert.match(error.message, expected, JSON.stringify(body))
  }
})

test('a missing square, unreadable config and broken JSON refuse', async () => {
  const missing = await prepared(valid, { touchSquare: false })
  assert.match((await loadConfig(missing.file, env).catch((error) => error)).message, /square does not exist/)

  const broken = await prepared('{ not json')
  assert.match((await loadConfig(broken.file, env).catch((error) => error)).message, /is not valid JSON/)

  assert.match((await loadConfig(join(broken.root, 'absent.json'), env).catch((error) => error)).message,
    /cannot read config file/)
})
