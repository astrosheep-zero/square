import './sandbox-env.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slackText, squareBody } from '../dist/text.js'

const squareNames = { UFAYE: 'faye', UALICE: 'slack/alice' }
const slackUsers = { faye: 'UFAYE', 'slack/alice': 'UALICE' }
const squareSide = { squareNameForSlackUser: (userId) => squareNames[userId] }
const slackSide = { slackUserForSquareName: (name) => slackUsers[name] }

test('a Slack message becomes a Square body with native mentions and links', () => {
  assert.equal(squareBody('hi <@UFAYE> and <@UALICE>', squareSide), 'hi @faye and @slack/alice')
  assert.equal(squareBody('<@UNKNOWN>', squareSide), '@UNKNOWN')
  assert.equal(squareBody('see <https://example.dev/doc|the doc>', squareSide), 'see the doc (https://example.dev/doc)')
  assert.equal(squareBody('see <https://example.dev/doc>', squareSide), 'see https://example.dev/doc')
  assert.equal(squareBody('in <#C0BRIDGE|general>', squareSide), 'in #general')
  assert.equal(squareBody('heads up <!here>', squareSide), 'heads up @here')
  assert.equal(squareBody('a &amp; b &lt;c&gt;', squareSide), 'a & b <c>')
  assert.equal(squareBody('plain @rei text', squareSide), 'plain @rei text')
})

test('a Square body becomes Slack mrkdwn with native mentions and escaped text', () => {
  assert.equal(slackText('@faye look', slackSide), '<@UFAYE> look')
  assert.equal(slackText('@slack/alice look', slackSide), '<@UALICE> look')
  assert.equal(slackText('@unknown stays', slackSide), '@unknown stays')
  assert.equal(slackText('a & b <c>', slackSide), 'a &amp; b &lt;c&gt;')
  assert.equal(slackText('@faye2 is not faye', slackSide), '@faye2 is not faye')
  assert.equal(slackText('mail me@faye.dev', slackSide), 'mail me@faye.dev')
})
