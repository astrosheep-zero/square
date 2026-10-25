import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { run, tempSquare, withName, withPath, ROOT } from './square-cli-helpers.js';

const joinBanner = 'stay within earshot — keep this catch open for new activity';
const skillGuidance = '**Always give speech a body.**';

test('join gives actionable listening guidance while the skill preserves embodied expression', (t) => {
  const file = tempSquare();
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const built = run(withPath(file, ['build']), { input: 'A scene worth keeping' });
  assert.equal(built.status, 0, built.stderr);
  for (const args of [['join'], ['join'], ['join', '--kick']]) {
    const joined = run(withName(file, 'Alice', args), { env: { CODEX_THREAD_ID: args.includes('--kick') ? 'guidance-takeover' : 'guidance-join' } });
    assert.equal(joined.status, 0, joined.stderr);
    assert.match(joined.stdout, /stay within earshot|when someone calls you, you’ll hear them here/);
    assert.doesNotMatch(joined.stdout, /every word here lands on a real ear/);
  }
  assert.ok(fs.readFileSync(path.join(ROOT, 'skills/square/SKILL.md'), 'utf8').includes(skillGuidance));
  const history = run(withPath(file, ['history', '--no-truncate']));
  assert.equal(history.status, 0, history.stderr);
  assert.ok(!history.stdout.includes(joinBanner), 'guidance is not a participant activity');
});
