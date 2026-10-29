import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Square } from '../../dist/square-api.js';
import { rememberSquarePath } from '../../dist/square-index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-discovery-publication-'));
const location = path.join(root, 'KNOWN.square');
const index = path.join(root, 'index.ndjsonl');
const body = { channel: 'codex', session: location };
const env = { ...process.env, SQUARE_INDEX: index, CODEX_THREAD_ID: location,
  CLAUDE_CODE_SESSION_ID: '', CLAUDE_CODE_CHILD_SESSION: '', PI_SESSION_ID: '', OPENCODE_SESSION_ID: '', PASEO_AGENT_ID: '',
  SQUARE_DISABLE_PASEO_WAKE: '1', SQUARE_NOTIFY_DELIVERY_WAIT_MS: '1', NODE_NO_WARNINGS: '1' };
const wakeTransport = { async attempt() { assert.fail('no external sends'); } };
const cli = path.resolve(import.meta.dirname, '../../dist/square.js');
let opened, lock;
let restore = () => {};
const diagnostics = [];
function expressInChild(text) {
  const result = spawnSync(process.execPath, [cli, '--location', location, '--as', 'Alice',
    'express', '--force', '--no-wait', text], { env, encoding: 'utf8', timeout: 5000 });
  const diagnostic = { status: result.status, error: result.error?.code ?? null, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr };
  diagnostics.push(diagnostic);
  assert.equal(result.error, undefined, JSON.stringify(diagnostic));
  assert.equal(result.signal, null, JSON.stringify(diagnostic));
  assert.equal(result.status, 0, JSON.stringify(diagnostic));
}
try {
  const built = await Square.build({ path: location, markdown: 'discovery is optional', env, wakeTransport });
  try { await built.join('Alice', { body }); }
  finally { await built.close(); }

  if (process.argv[2] === 'open') {
    // Pause a real reattachment publication after acquiring its lock. Publication
    // must finish before a synchronous CLI child blocks the parent's event loop.
    const original = fs.promises.readFile;
    let publicationPending = false;
    let reached;
    const insideLock = new Promise(resolve => { reached = resolve; });
    fs.promises.readFile = async function(file, ...args) {
      if (file === index) {
        publicationPending = true;
        reached();
        await setImmediate();
        try { return await original.call(this, file, ...args); }
        finally { publicationPending = false; }
      }
      return original.call(this, file, ...args);
    };
    restore = () => { fs.promises.readFile = original; };
    opened = await Square.at({ path: location, body, env, wakeTransport });
    await opened.reattach('Alice', { body });
    await insideLock;
    // A queued publication could not release its lock during the synchronous child.
    expressInChild('child after open completion');
    assert.equal(publicationPending, false, 'join/reattach must not leave a detached publication');
  } else if (process.argv[2] === 'held') {
    const before = fs.readFileSync(index, 'utf8');
    lock = new DatabaseSync(`${index}.lock`);
    lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
    assert.equal(await rememberSquarePath(location, { channel: 'codex', session: 'not-published' }, index), false);
    opened = await Square.at({ path: location, body, env, wakeTransport });
    const bob = (await opened.join('Bob', { body })).participant;
    await bob.express('parent while discovery is locked', { force: true });
    expressInChild('child while discovery is locked');
    assert.equal(fs.readFileSync(index, 'utf8'), before, 'contended publication must not write or queue');
    lock.exec('ROLLBACK;');
    lock.close();
    lock = undefined;
    const later = { channel: 'codex', session: 'later' };
    assert.equal(await rememberSquarePath(location, later, index), true, 'later access can rebuild discovery');
    const entries = fs.readFileSync(index, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const canonicalLocation = fs.realpathSync(location);
    assert.deepEqual(entries, [{ location: canonicalLocation, body }, { location: canonicalLocation, body: later }]);
  } else { throw new Error('Expected open or held fixture mode'); }

  assert.deepEqual((await opened.history()).activities.filter(row => row.kind === 'say').map(row => row.body),
    process.argv[2] === 'open' ? ['child after open completion']
      : ['parent while discovery is locked', 'child while discovery is locked']);
  console.log(JSON.stringify({ mode: process.argv[2], diagnostics }));
} finally {
  restore();
  if (lock !== undefined) { lock.exec('ROLLBACK;'); lock.close(); }
  await opened?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
