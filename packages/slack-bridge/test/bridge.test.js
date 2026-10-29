import './sandbox-env.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Square } from '@astrosheep/square'
import { Bridge } from '../dist/bridge.js'
import { FakeSlack } from './fake-slack.js'
import {
  BRIDGE_TOKEN, CHANNEL, FAYE_TOKEN, bridgeBody, buildSquare, connectedSlack, message, opened, settingsFor, until,
} from './fixtures.js'

const personas = { faye: FAYE_TOKEN }

async function archive(square) {
  return (await square.history({ limit: 100 })).activities
}

async function start(t, { path, slack, state, log, pollIntervalMs = 20 }) {
  const settings = settingsFor({ square: path, state, personas })
  const bridge = await Bridge.open({ settings, port: slack, pollIntervalMs, ...(log === undefined ? {} : { log }) })
  t.after(() => bridge.stop())
  return { bridge, settings }
}

function slackWith(bots = personas) {
  return connectedSlack(new FakeSlack(), bots)
}

function recordJoins(square) {
  const calls = []
  const join = square.join.bind(square)
  square.join = (...args) => {
    calls.push(args)
    return join(...args)
  }
  return calls
}

test('the bridge opens an identity-free square and joins inbound with stable custody', async () => {
  const path = await buildSquare()
  const settings = settingsFor({ square: path, personas })
  const slack = slackWith().addUser('UALICE', { displayName: 'Alice' })
  const originalAt = Square.at
  let input
  let square
  let joins
  let bridge
  Square.at = async (options, ...rest) => {
    input = options
    square = await originalAt(options, ...rest)
    joins = recordJoins(square)
    return square
  }
  try {
    bridge = await Bridge.open({ settings, port: slack })
    assert.equal(input.path, settings.square)
    for (const key of ['body', 'wakeAddress', 'participant']) {
      assert.equal(Object.hasOwn(input, key), false, `${key} must not be captured on open`)
    }
    const body = bridgeBody(settings)
    assert.deepEqual(body, {
      channel: 'slack-bridge',
      session: resolve(settings.state),
      agent: settings.channel,
    })

    await bridge.handleInbound(message({ ts: '1700.0001', text: 'hello from the bridge' }))
    assert.deepEqual(joins, [['slack/Alice', { body }]])
    assert.deepEqual((await square.seatsOf(body)).map((seat) => seat.name), ['slack/Alice'])
    const landed = (await archive(square)).at(-1)
    assert.equal(landed.kind, 'say')
    assert.equal(landed.actor, 'slack/Alice')
    assert.equal(landed.body, 'hello from the bridge')
  }
  finally {
    Square.at = originalAt
    if (bridge === undefined) await square?.close()
    else await bridge.stop()
  }
})

test('a caller-owned square uses bridge custody per operation and stays caller-owned', async (t) => {
  const path = await buildSquare()
  const settings = settingsFor({ square: path, personas })
  const callerBody = { channel: 'caller-owned', session: 'caller-resource' }
  const square = await Square.at({ path })
  t.after(() => square.close())
  await square.join('caller', { body: callerBody })
  const joins = recordJoins(square)
  const slack = slackWith().addUser('UALICE', { displayName: 'Alice' })
  const originalAt = Square.at
  let openCalls = 0
  Square.at = async (...args) => {
    openCalls += 1
    return originalAt(...args)
  }
  let bridge
  try {
    bridge = await Bridge.open({ settings, port: slack, square })
    await bridge.handleInbound(message({ ts: '1700.0002', text: 'hello from the supplied square' }))
    await bridge.handleInbound(message({ ts: '1700.0005', text: 'hello again' }))
  }
  finally {
    Square.at = originalAt
    await bridge?.stop()
  }

  assert.equal(openCalls, 0)
  assert.deepEqual(joins, [
    ['slack/Alice', { body: bridgeBody(settings) }],
    ['slack/Alice', { body: bridgeBody(settings) }],
  ])
  assert.deepEqual((await square.seatsOf(callerBody)).map((seat) => seat.name), ['caller'])
  assert.deepEqual((await square.seatsOf(bridgeBody(settings))).map((seat) => seat.name), ['slack/Alice'])
  const activities = await archive(square)
  assert.equal(activities.at(-1).actor, 'slack/Alice')
  assert.deepEqual(activities.filter((activity) => activity.kind === 'say' && activity.actor === 'slack/Alice')
    .map((activity) => activity.body), ['hello from the supplied square', 'hello again'])
})

test('inbound messages reacquire a participant handle after a seat is replaced', async () => {
  const path = await buildSquare()
  const settings = settingsFor({ square: path, personas })
  const body = bridgeBody(settings)
  const square = await Square.at({ path })
  const replacement = await Square.at({ path })
  const slack = slackWith().addUser('UALICE', { displayName: 'Alice' })
  const bridge = await Bridge.open({ settings, port: slack, square })
  try {
    await bridge.handleInbound(message({ ts: '1700.0003', text: 'before replacement' }))
    await (await replacement.participant('slack/Alice', { body })).done()
    assert.equal((await replacement.join('slack/Alice', { body })).kind, 'joined')

    await bridge.handleInbound(message({ ts: '1700.0004', text: 'after replacement' }))
    assert.equal((await archive(square)).at(-1).body, 'after replacement')
  }
  finally {
    await bridge.stop()
    await Promise.all([square.close(), replacement.close()])
  }
})

test('Slack messages land as say activities from slack participants', async (t) => {
  const path = await buildSquare()
  const { square, body } = await opened(t, path)
  await square.join('faye', { body })
  const slack = slackWith().addUser('UALICE', { displayName: 'Alice' })
  const { bridge } = await start(t, { path, slack })

  await bridge.handleInbound(message({ ts: '1700.0001', text: 'hello <@UFAYE>, and plain @faye' }))

  const say = (await archive(square)).at(-1)
  assert.equal(say.kind, 'say')
  assert.equal(say.actor, 'slack/Alice')
  assert.equal(say.body, 'hello @faye, and plain @faye')
  assert.deepEqual(say.mentions, ['faye'])
})

test('bot, own-loop, edited, deleted, empty and foreign events land nothing', async (t) => {
  const path = await buildSquare()
  const { square } = await opened(t, path)
  const slack = slackWith().addUser('UALICE', { displayName: 'Alice' })
  const { bridge } = await start(t, { path, slack })
  const before = (await archive(square)).length

  const ignored = [
    message({ ts: '1700.0011', channel: 'C_OTHER' }),
    message({ ts: '1700.0012', subtype: 'message_changed' }),
    message({ ts: '1700.0013', subtype: 'message_deleted' }),
    message({ ts: '1700.0014', subtype: 'channel_join' }),
    message({ ts: '1700.0015', userId: 'UBRIDGE' }),
    message({ ts: '1700.0016', userId: undefined, botId: 'BBRIDGE' }),
    message({ ts: '1700.0017', userId: 'UFAYE' }),
    message({ ts: '1700.0018', text: '   ' }),
    message({ ts: '1700.0019', text: undefined }),
    message({ ts: '1700.0020', userId: undefined }),
  ]
  for (const event of ignored) await bridge.handleInbound(event)

  assert.equal((await archive(square)).length, before)
})

test('a threaded Slack reply answers the mapped square activity', async (t) => {
  const path = await buildSquare()
  const { square } = await opened(t, path)
  const slack = slackWith().addUser('UALICE', { displayName: 'Alice' })
  const { bridge } = await start(t, { path, slack })

  await bridge.handleInbound(message({ ts: '1700.0100', text: 'root' }))
  const root = (await archive(square)).at(-1)
  await bridge.handleInbound(message({ ts: '1700.0101', threadTs: '1700.0100', text: 'in thread' }))

  assert.equal((await archive(square)).at(-1).reply, root.id)
})

test('agent activities post once, in order, each in its own voice', async (t) => {
  const path = await buildSquare()
  const { square, body } = await opened(t, path)
  const rei = (await square.join('rei', { body })).participant
  const faye = (await square.join('faye', { body })).participant
  const slack = slackWith()
  const { bridge } = await start(t, { path, slack })

  await rei.express('first')
  await faye.express('second')
  await rei.express('third')
  await bridge.drainOutbound()

  assert.deepEqual(slack.posts.map((post) => [post.text, post.token, post.username]), [
    ['first', BRIDGE_TOKEN, 'rei'],
    ['second', FAYE_TOKEN, undefined],
    ['third', BRIDGE_TOKEN, 'rei'],
  ])
  assert.ok(slack.posts.every((post) => post.channel === CHANNEL))

  const posted = slack.posts.length
  await bridge.drainOutbound()
  assert.equal(slack.posts.length, posted)
})

test('mentions become Slack IDs and replies thread under the Slack message', async (t) => {
  const path = await buildSquare()
  const { square, body } = await opened(t, path)
  const faye = (await square.join('faye', { body })).participant
  const slack = slackWith().addUser('UALICE', { displayName: 'Alice' })
  const { bridge } = await start(t, { path, slack })

  await bridge.handleInbound(message({ ts: '1700.0200', text: 'a question' }))
  const asked = (await archive(square)).at(-1)
  await faye.express('@slack/Alice answer', { reply: asked.id })
  await bridge.drainOutbound()

  const post = slack.posts.at(-1)
  assert.equal(post.text, '<@UALICE> answer')
  assert.equal(post.token, FAYE_TOKEN)
  assert.equal(post.threadTs, '1700.0200')
})

test('a Slack failure is logged, skipped, and never blocks later activities', async (t) => {
  const path = await buildSquare()
  const { square, body } = await opened(t, path)
  const rei = (await square.join('rei', { body })).participant
  const logs = []
  const slack = slackWith().failWhen((post) => post.text === 'second')
  const { bridge } = await start(t, { path, slack, log: (line) => logs.push(line) })

  await rei.express('first')
  await rei.express('second')
  await rei.express('third')
  await bridge.drainOutbound()

  assert.deepEqual(slack.posts.map((post) => post.text), ['first', 'third'])
  assert.ok(logs.some((line) => /slack post failed for act\/\d+: ratelimited/.test(line)), logs.join('\n'))
  await bridge.drainOutbound()
  assert.deepEqual(slack.posts.map((post) => post.text), ['first', 'third'])
})

test('a restart resumes both directions without duplicates', async (t) => {
  const path = await buildSquare()
  const { square, body } = await opened(t, path)
  const rei = (await square.join('rei', { body })).participant
  const slack = slackWith().addUser('UALICE', { displayName: 'Alice' })
  const settings = settingsFor({ square: path, personas })

  const first = await Bridge.open({ settings, port: slack })
  await first.handleInbound(message({ ts: '1700.0300', text: 'from slack' }))
  await rei.express('from rei')
  await first.drainOutbound()
  await first.stop()

  await rei.express('while stopped')
  const restarted = await Bridge.open({ settings, port: slack })
  t.after(() => restarted.stop())
  await restarted.drainOutbound()
  assert.deepEqual(slack.posts.map((post) => post.text), ['from rei', 'while stopped'])
  await restarted.drainOutbound()
  assert.deepEqual(slack.posts.map((post) => post.text), ['from rei', 'while stopped'])

  const fromSlack = (await archive(square)).find((activity) => activity.body === 'from slack')
  await restarted.handleInbound(message({ ts: '1700.0301', threadTs: '1700.0300', text: 'still threaded' }))
  assert.equal((await archive(square)).at(-1).reply, fromSlack.id)
})

test('a first start does not replay old history', async (t) => {
  const path = await buildSquare()
  const { square, body } = await opened(t, path)
  const rei = (await square.join('rei', { body })).participant
  await rei.express('old')
  const slack = slackWith()
  const { bridge } = await start(t, { path, slack })

  await bridge.drainOutbound()
  assert.deepEqual(slack.posts, [])

  await rei.express('new')
  await bridge.drainOutbound()
  assert.deepEqual(slack.posts.map((post) => post.text), ['new'])
})

test('a bridge first started on an empty square posts what landed while it was stopped', async (t) => {
  const path = await buildSquare()
  const slack = slackWith()
  const settings = settingsFor({ square: path, personas })
  const first = await Bridge.open({ settings, port: slack })
  await first.stop()

  const { square, body } = await opened(t, path)
  const rei = (await square.join('rei', { body })).participant
  await rei.express('late')

  const restarted = await Bridge.open({ settings, port: slack })
  t.after(() => restarted.stop())
  await restarted.drainOutbound()
  assert.deepEqual(slack.posts.map((post) => post.text), ['late'])
})

test('the running bridge mirrors both directions until stopped', async (t) => {
  const path = await buildSquare()
  const { square, body } = await opened(t, path)
  const rei = (await square.join('rei', { body })).participant
  const slack = slackWith().addUser('UALICE', { displayName: 'Alice' })
  const { bridge } = await start(t, { path, slack })

  await bridge.start()
  slack.deliver(message({ ts: '1700.0400', text: 'live' }))
  const landed = await until(async () => (await archive(square)).find((activity) => activity.body === 'live'), 'the Slack message')
  assert.equal(landed.actor, 'slack/Alice')

  await rei.express('live back')
  const post = await until(() => slack.posts.find((entry) => entry.text === 'live back'), 'the Square activity')
  assert.equal(post.token, BRIDGE_TOKEN)
  await bridge.stop()
  assert.equal(slack.closed, true)
})

test('a corrupt state file refuses startup instead of resetting', async (t) => {
  const path = await buildSquare()
  const state = `${path}.slack-bridge.json`
  await writeFile(state, JSON.stringify({ version: 9, cursor: null }))
  const slack = slackWith()
  const error = await Bridge.open({ settings: settingsFor({ square: path, state, personas }), port: slack })
    .catch((failure) => failure)
  assert.match(error.message, /unsupported version 9/)
  assert.equal(slack.closed, false)
  assert.equal(slack.connection, undefined)
})
