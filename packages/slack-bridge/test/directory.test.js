import './sandbox-env.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Directory } from '../dist/directory.js'
import { emptyState } from '../dist/state.js'
import { FakeSlack } from './fake-slack.js'
import { BRIDGE_TOKEN, FAYE_TOKEN, settingsFor } from './fixtures.js'

function slackWith(...users) {
  const slack = new FakeSlack()
    .addBot(BRIDGE_TOKEN, 'UBRIDGE', 'BBRIDGE')
    .addBot(FAYE_TOKEN, 'UFAYE', 'BFAYE')
  for (const [userId, names] of users) slack.addUser(userId, names)
  return slack
}

async function directory(state = emptyState(), slack = slackWith(['UALICE', { displayName: 'Alice' }])) {
  const saves = { count: 0 }
  const built = await Directory.build({
    settings: settingsFor({ square: '/tmp/unused.square', personas: { faye: FAYE_TOKEN } }),
    port: slack,
    state,
    save: async () => { saves.count += 1 },
  })
  return { directory: built, state, saves, slack }
}

test('one directory answers both posting modes without a branch elsewhere', async () => {
  const { directory: names } = await directory()
  assert.deepEqual(names.posterFor('faye'), { token: FAYE_TOKEN })
  assert.deepEqual(names.posterFor('rei'), { token: BRIDGE_TOKEN, username: 'rei' })
})

test('persona bots and Slack humans map to and from Square names', async () => {
  const { directory: names, state, saves } = await directory()
  assert.equal(names.squareNameForSlackUser('UFAYE'), 'faye')
  assert.equal(names.slackUserForSquareName('faye'), 'UFAYE')
  assert.equal(names.slackUserForSquareName('slack/Alice'), undefined)

  assert.equal(await names.participantFor('UALICE'), 'slack/Alice')
  assert.equal(state.users.UALICE, 'Alice')
  assert.equal(saves.count, 1)
  assert.equal(names.squareNameForSlackUser('UALICE'), 'slack/Alice')
  assert.equal(names.slackUserForSquareName('slack/Alice'), 'UALICE')
  assert.equal(names.slackUserForSquareName('slack/changed-case'), undefined)

  const stranger = slackWith(['UNEW', { displayName: 'Alice Smith' }])
  const { directory: fresh } = await directory(emptyState(), stranger)
  await fresh.learn('<@UNEW|new>')
  assert.equal(fresh.squareNameForSlackUser('UNEW'), 'Alice-Smith')
  assert.equal(fresh.squareNameForSlackUser('UNLEARNED'), undefined)
})

test('two Slack users never share one Square participant name', async () => {
  const slack = slackWith(
    ['UALICE', { displayName: 'Alice' }],
    ['UALE2', { displayName: 'Alice' }],
    ['UALE3', { displayName: 'Alice' }],
  )
  const { directory: names, state } = await directory(emptyState(), slack)
  assert.equal(await names.participantFor('UALICE'), 'slack/Alice')
  assert.equal(await names.participantFor('UALE2'), 'slack/Alice-ALE2')
  assert.equal(await names.participantFor('UALE3'), 'slack/Alice-ALE3')
  assert.deepEqual(state.users, { UALICE: 'Alice', UALE2: 'Alice-ALE2', UALE3: 'Alice-ALE3' })
})

test('assigned names survive a restart through the persisted map', async () => {
  const first = emptyState()
  const { directory: before } = await directory(first)
  const name = await before.participantFor('UALICE')
  const { directory: after } = await directory(first)
  assert.equal(await after.participantFor('UALICE'), name)
  assert.equal(after.slackUserForSquareName(name), 'UALICE')
})

test('the bridge never mirrors its own bots back into the square', async () => {
  const { directory: names } = await directory()
  assert.equal(names.isOwnBot({ userId: 'UBRIDGE' }), true)
  assert.equal(names.isOwnBot({ botId: 'BBRIDGE' }), true)
  assert.equal(names.isOwnBot({ userId: 'UFAYE' }), true)
  assert.equal(names.isOwnBot({ botId: 'BFAYE' }), true)
  assert.equal(names.isOwnBot({ userId: 'UALICE' }), false)
  assert.equal(names.isOwnBot({}), false)
})

test('a failed auth.test names the bot and never the token', async () => {
  const slack = new FakeSlack().addBot(BRIDGE_TOKEN, 'UBRIDGE')
  const error = await Directory.build({
    settings: settingsFor({ square: '/tmp/unused.square', personas: { faye: FAYE_TOKEN } }),
    port: slack,
    state: emptyState(),
    save: async () => {},
  }).catch((failure) => failure)
  assert.match(error.message, /auth\.test failed for persona faye/)
  assert.doesNotMatch(error.message, new RegExp(FAYE_TOKEN))
})
