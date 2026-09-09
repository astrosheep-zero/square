import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { run, tempSquare, withName, withPath, ROOT } from './square-cli-helpers.js';

const guidance = "Don't treat Square as a public dumping ground. Speak here only when you genuinely think someone else needs to know; otherwise you are needlessly interrupting them.";

test('join feedback and packaged skill make responsibility for others attention explicit', (t) => {
  const file = tempSquare();
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const built = run(withPath(file, ['build']), { input: 'A scene worth keeping' });
  assert.equal(built.status, 0, built.stderr);
  for (const args of [['join'], ['join'], ['join', '--kick']]) {
    const joined = run(withName(file, 'Alice', args), { env: { CODEX_THREAD_ID: args.includes('--kick') ? 'guidance-takeover' : 'guidance-join' } });
    assert.equal(joined.status, 0, joined.stderr);
    assert.ok(joined.stdout.includes(guidance));
  }
  assert.ok(fs.readFileSync(path.join(ROOT, 'skills/square/SKILL.md'), 'utf8').includes(guidance));
  const history = run(withPath(file, ['history', '--no-truncate']));
  assert.equal(history.status, 0, history.stderr);
  assert.ok(!history.stdout.includes(guidance), 'guidance is not a participant activity');
});
