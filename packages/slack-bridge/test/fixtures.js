import './sandbox-env.js'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Square } from '@astrosheep/square'
import { sandbox } from './sandbox-env.js'

export const CHANNEL = 'C0BRIDGE'
export const BRIDGE_TOKEN = 'xoxb-bridge-token'
export const FAYE_TOKEN = 'xoxb-faye-token'
export const BRIDGE_USER = 'UBRIDGE'
export const FAYE_USER = 'UFAYE'

export function caseDir(name) {
  return mkdtemp(join(sandbox, `${name}-`))
}

export async function buildSquare(name = 'square') {
  const root = await caseDir(name)
  const path = join(root, 'team.square')
  const square = await Square.build({ path, markdown: 'A test square.' })
  await square.close()
  return path
}

export async function opened(t, path, settings = settingsFor({ square: path })) {
  const square = await Square.at({ path })
  t.after(() => square.close())
  return { square, body: bridgeBody(settings) }
}

export function settingsFor({ square, state, personas = {} }) {
  return {
    square,
    channel: CHANNEL,
    state: state ?? `${square}.slack-bridge.json`,
    bridge: { appToken: 'xapp-bridge-token', botToken: BRIDGE_TOKEN },
    personas: new Map(Object.entries(personas)),
  }
}

export function bridgeBody(settings) {
  return { channel: 'slack-bridge', session: resolve(settings.state), agent: settings.channel }
}

/** A fake Slack carrying the bridge bot and, when configured, the faye persona bot. */
export function connectedSlack(slack, personas = {}) {
  slack.addBot(BRIDGE_TOKEN, BRIDGE_USER, 'BBRIDGE')
  if (personas.faye !== undefined) slack.addBot(personas.faye, FAYE_USER, 'BFAYE')
  return slack
}

export function message(overrides = {}) {
  return { channel: CHANNEL, ts: '1700000000.000001', text: 'hello', userId: 'UALICE', ...overrides }
}

export async function until(check, what, timeout = 5000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
