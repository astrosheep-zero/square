import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { beginClaudeMcpCall, endClaudeMcpCall, readClaudeMcpCall } from '../dist/claude-mcp-context.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-claude-context-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const index = path.join(root, 'index.ndjsonl');
  const env = { SQUARE_INDEX: index, CLAUDE_CODE_SESSION_ID: 'startup-parent' };
  const directory = path.join(root, 'claude-mcp-calls');
  const file = id => path.join(directory, `${createHash('sha256').update(id).digest('hex')}.json`);
  return { env, directory, file };
}
const unavailable = { code: 'unavailable' };
const main = { toolUseId: 'main-call', sessionId: 'main', cwd: '/main project' };
const child = { ...main, toolUseId: 'child-call', agentId: 'child-agent' };

test('concurrent calls have separate immutable records and exact token cleanup', async t => {
  const { env, file, directory } = await fixture(t);
  const before = { ...env };
  const [a, b] = await Promise.all([beginClaudeMcpCall(main, env), beginClaudeMcpCall(child, env)]);
  assert.notEqual(a.token, b.token);
  assert.deepEqual(await Promise.all([readClaudeMcpCall(main.toolUseId, env), readClaudeMcpCall(child.toolUseId, env)]), [main, child]);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file(main.toolUseId))).mode & 0o777, 0o600);
  await endClaudeMcpCall(main.toolUseId, 'wrong-token', env);
  assert.deepEqual(await readClaudeMcpCall(main.toolUseId, env), main);
  await endClaudeMcpCall(main.toolUseId, a.token, env);
  await assert.rejects(readClaudeMcpCall(main.toolUseId, env), unavailable);
  assert.deepEqual(await readClaudeMcpCall(child.toolUseId, env), child);
  await endClaudeMcpCall(child.toolUseId, b.token, env);
  assert.deepEqual(env, before);
});

test('duplicate publication is refused; expiry permits replacement without stale finally deleting it', async t => {
  const { env, file } = await fixture(t);
  const attempts = await Promise.allSettled([beginClaudeMcpCall(main, env), beginClaudeMcpCall(main, env)]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'unavailable');
  const first = attempts.find(result => result.status === 'fulfilled').value;
  const stored = JSON.parse(await fs.readFile(file(main.toolUseId), 'utf8'));
  await fs.writeFile(file(main.toolUseId), JSON.stringify({ ...stored, expiresAt: Date.now() - 1 }));
  await assert.rejects(readClaudeMcpCall(main.toolUseId, env), unavailable);
  const replacement = { ...child, toolUseId: main.toolUseId };
  const second = await beginClaudeMcpCall(replacement, env);
  await endClaudeMcpCall(main.toolUseId, first.token, env);
  assert.deepEqual(await readClaudeMcpCall(main.toolUseId, env), replacement);
  await endClaudeMcpCall(main.toolUseId, second.token, env);
  await endClaudeMcpCall(main.toolUseId, second.token, env);
});

test('missing or malformed context fails closed; only absolute cwd is published', async t => {
  const { env, file } = await fixture(t);
  await assert.rejects(readClaudeMcpCall(undefined, env), unavailable);
  await assert.rejects(readClaudeMcpCall('missing', env), unavailable);
  await assert.rejects(beginClaudeMcpCall({ ...main, cwd: 'relative' }, env), unavailable);
  await beginClaudeMcpCall(main, env);
  await fs.writeFile(file(main.toolUseId), '{not-json');
  await assert.rejects(readClaudeMcpCall(main.toolUseId, env), unavailable);
  await fs.writeFile(file(main.toolUseId), JSON.stringify({ ...main, expiresAt: Date.now() + 1000 }));
  await assert.rejects(readClaudeMcpCall(main.toolUseId, env), unavailable);
});
