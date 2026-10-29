import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Square, SquareError, harnessOwner, decodeHarnessOwner, localUserOwner, inbox } from '../dist/index.js';
import { validateOwner } from '../dist/model.js';
import { createArtifactPort } from '../dist/artifact.js';
import { commandIdentity } from '../dist/cli/context.js';

const cli = path.resolve(import.meta.dirname, '../dist/square.js');

test('opaque owners compare exactly while harness encoding roundtrips reserved segments', async t => {
  const coordinate = { channel: 'pi:fork', session: 'path/百分号%', agent: 'a:b/😀' };
  const encoded = harnessOwner(coordinate);
  assert.deepEqual(decodeHarnessOwner(encoded), coordinate);
  assert.notEqual(encoded, harnessOwner({ ...coordinate, session: 'path/百分号' }));
  assert.equal(commandIdentity({ SQUARE_OWNER: '  local owner  ' }).owner, '  local owner  ');
  assert.equal(commandIdentity({ SQUARE_OWNER: 'env' }, 'explicit').owner, 'explicit');
  assert.deepEqual(commandIdentity({ CLAUDE_CODE_SESSION_ID: 'native', PASEO_AGENT_ID: 'managed' }), {
    owner: harnessOwner({ channel: 'claude-code', session: 'native' }),
    wakeAddress: { kind: 'paseo', address: { agentId: 'managed' } },
  });
  for (const invalid of ['', 'control\u0000', 'control\u0085', '😀'.repeat(129)])
    assert.throws(() => validateOwner(invalid), SquareError);
  const square = Square.inMemory({ markdown: 'opaque ownership' });
  t.after(() => square.close());
  const alice = (await square.join('Alice', { owner: '  owner  ' })).participant;
  await assert.rejects(square.participant('Alice', { owner: 'owner' }), { code: 'already_joined' });
  assert.equal((await square.participant('Alice', { owner: '  owner  ' })).name, alice.name);
  await assert.rejects(inbox({ env: {} }, undefined), { code: 'invalid_args' });
});

test('a plain terminal speaks under its local owner and explicit owner survives recovery commands', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-owner-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'test.square');
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index'), CODEX_THREAD_ID: '', PI_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '', CLAUDE_CODE_CHILD_SESSION: '', OPENCODE_SESSION_ID: '', PASEO_AGENT_ID: '' };
  delete env.SQUARE_OWNER;
  const square = await Square.build({ path: file, env, markdown: 'terminal' });
  await square.close();
  const run = (args, overrides = {}, input) => spawnSync(process.execPath, [cli, '--location', file, ...args], {
    env: { ...env, ...overrides }, input, encoding: 'utf8', timeout: 5000,
  });
  for (const args of [['--as', 'me', 'join'], ['--as', 'me', 'express', '--force', 'plain terminal words']]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const artifact = createArtifactPort(file);
  try {
    const seat = (await artifact.read(facts => facts.seat('me'))).value;
    assert.equal(seat.owner, localUserOwner());
    assert.equal(seat.wakeAddress, undefined);
  } finally { await artifact.close(); }
  const explicit = "script:owner's copy";
  const joined = run(['--owner', explicit, '--as', 'Script', 'join']);
  assert.equal(joined.status, 0, joined.stderr);
  assert.match(joined.stdout, /--owner 'script:owner'\\''s copy' catch --idle/);
  const wrong = run(['--owner', explicit, '--as', 'me', 'express', 'keep this draft']);
  assert.equal(wrong.status, 2, wrong.stdout + wrong.stderr);
  assert.match(wrong.stderr, /--owner 'script:owner'\\''s copy' join/);
  const child = run(['--as', 'child', 'express', '-'], { CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_CHILD_SESSION: '1' }, 'piped child draft');
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /incomplete/);
  const draft = child.stderr.match(/draft kept: (.+)/)?.[1];
  assert.ok(draft, child.stderr);
  assert.equal(fs.readFileSync(draft, 'utf8'), 'piped child draft');
  const help = run(['--owner', explicit, 'join', '--help']);
  assert.equal(help.status, 0, help.stderr);
});
