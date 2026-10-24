import './sandbox-env.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isParticipantName, slackName } from '../dist/names.js'

test('Slack display names become one valid Square name segment', () => {
  assert.equal(slackName('Alice Smith', 'U01'), 'Alice-Smith')
  assert.equal(slackName('  double   space  ', 'U01'), 'double-space')
  assert.equal(slackName('faye', 'U01'), 'faye')
  assert.equal(slackName('a/b', 'U01'), 'a-b')
  assert.equal(slackName('🦈 shark', 'U01'), '🦈-shark')
  assert.equal(slackName('***', 'U0ABC123'), 'U0ABC123')
  assert.equal(slackName('', 'U0ABC123'), 'U0ABC123')
  for (const display of ['Alice Smith', '🦈 shark', '名前 テスト', '--', 'a.b'])
    assert.ok(isParticipantName(slackName(display, 'U01')), display)
})

test('Square participant names keep their slash structure and reject empty segments', () => {
  assert.ok(isParticipantName('slack/alice'))
  assert.ok(isParticipantName('faye'))
  assert.ok(!isParticipantName(''))
  assert.ok(!isParticipantName('a/'))
  assert.ok(!isParticipantName('a b'))
})
