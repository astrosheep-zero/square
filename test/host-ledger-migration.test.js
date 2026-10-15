import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { migrateHostLedger, verifyHostLedger } from '../dist/host-ledger-migration.js';
import { LEDGER_FILENAME } from '../dist/host-ledger-sqlite.js';
import { withFileLock } from '../dist/file-lock.js';

const PROJECT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(PROJECT, 'dist/square.js');
const IMPORTER = new URL('../dist/host-ledger-migration.js', import.meta.url).href;
const SANDBOX = path.join(PROJECT, 'test/sandbox-env.js');
const presence = (extra = {}) => ({ v: 1, location: '/sample.square', participant: 'Faye', session: 'native-session', channel: 'pi', updatedAt: 1, ...extra });
const evidence = (extra = {}) => ({ v: 1, location: '/sample.square', participant: 'Faye', session: 'native-session', activity: 'act/7', kind: 'wake', outcome: 'accepted', at: 1, ...extra });
async function rootFor(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-ledger-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function legacy(root, kind, rows) {
  const bytes = rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n';
  await fs.writeFile(path.join(root, `${kind}.ndjsonl`), bytes);
  return bytes;
}
function stored(root, kind) {
  const db = new DatabaseSync(path.join(root, LEDGER_FILENAME), { readOnly: true });
  try { return db.prepare(`SELECT row_json FROM host_${kind} ORDER BY seq`).all().map((row) => JSON.parse(row.row_json)); }
  finally { db.close(); }
}
function cli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, SQUARE_HOST_LEDGER_ROOT: root, SQUARE_LOCATION: '', SQUARE_PARTICIPANT_NAME: '' },
  });
}
function migrateProcess(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', SANDBOX, '--input-type=module', '-e',
      `import {migrateHostLedger} from ${JSON.stringify(IMPORTER)}; console.log(JSON.stringify(await migrateHostLedger({rootPath:process.argv[1]})))`, root],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (part) => { stdout += part; });
    child.stderr.on('data', (part) => { stderr += part; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
}

test('empty verification and migration create no root or database, respecting captured root selection', async (t) => {
  const parent = await rootFor(t), root = path.join(parent, 'absent');
  for (const operation of [verifyHostLedger, migrateHostLedger]) {
    const report = await operation({ env: { SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl') } });
    assert.equal(report.status, 'empty');
    assert.equal(report.presence, 0);
    assert.equal(report.evidence, 0);
    await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  }
  assert.equal((await verifyHostLedger({ rootPath: root, env: { SQUARE_HOST_LEDGER_ROOT: '/not-selected' } })).status, 'empty');
});

test('legacy readiness is read-only, reports source hashes/ignored lines, and leaks no payload', async (t) => {
  const root = await rootFor(t);
  const bytes = await legacy(root, 'evidence', [evidence({ message: 'TOP-SECRET' }), '{broken', { v: 2, at: 3 }, { v: 1 }, 'null']);
  const before = await fs.readdir(root);
  const report = await verifyHostLedger({ rootPath: root });
  assert.equal(report.status, 'legacy');
  assert.deepEqual(report.sources.evidence, {
    records: 1, ignored: 4, rejected: 0, sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  assert.deepEqual(report.sources.presence, { records: 0, ignored: 0, rejected: 0, sha256: null });
  assert.equal(report.ready, true);
  assert.doesNotMatch(JSON.stringify(report), /TOP-SECRET|native-session|sample\.square/);
  assert.deepEqual(await fs.readdir(root), before);
  assert.equal(await fs.readFile(path.join(root, 'evidence.ndjsonl'), 'utf8'), bytes);
});

test('conversion preserves all ages, duplicates, ordering, native/residual fields and normalizes unknown sources once', async (t) => {
  const root = await rootFor(t);
  const bindings = [presence({ scope: 'obsolete', epoch: 9, cancelledThrough: 17 }), presence(), presence({ updatedAt: 9e15 })];
  const wakes = [
    evidence({ outcome: 'unknown', signature: 'worker_interrupted_during_dispatch', claimToken: 'token-a', nativeDelivery: { harness: 'claude', epoch: 9, endpoint: '/secret-socket', payload: 'secret-body' } }),
    evidence({ outcome: 'unknown', diagnostic: { message: 'secret-diagnostic' } }),
    evidence({ kind: 'presentation', outcome: 'presented', at: 0 }),
    evidence({ outcome: 'dispatching', at: 9e15, expiresAt: 9e15 + 1000 }),
    evidence(), evidence(),
  ];
  const p = await legacy(root, 'presence', bindings), e = await legacy(root, 'evidence', wakes);
  const ready = await verifyHostLedger({ rootPath: root });
  const report = await migrateHostLedger({ rootPath: root });
  assert.equal(report.status, 'migrated');
  assert.equal(report.presence, bindings.length);
  assert.equal(report.evidence, wakes.length);
  assert.equal(report.presenceRevision, 1);
  assert.equal(report.evidenceRevision, 1);
  assert.deepEqual(report.sources, ready.sources);
  assert.deepEqual(stored(root, 'presence'), bindings);
  assert.deepEqual(stored(root, 'evidence'), wakes.map((row, index) => index < 2 ? { ...row, unknownSource: index === 0 ? 'interrupted' : 'transport' } : row));
  assert.equal(await fs.readFile(path.join(root, 'presence.ndjsonl'), 'utf8'), p);
  assert.equal(await fs.readFile(path.join(root, 'evidence.ndjsonl'), 'utf8'), e);
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.startsWith('.host-ledger-migrate-')), []);
  const db = new DatabaseSync(path.join(root, LEDGER_FILENAME), { readOnly: true });
  try { assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete'); }
  finally { db.close(); }
});

test('unsafe legacy readiness scans both complete sources with counts/hashes, but migration refuses every record', async (t) => {
  const root = await rootFor(t);
  const bindingBytes = await legacy(root, 'presence', [presence({ session: { secret: 'DO-NOT-PRINT' } }), presence()]);
  const bytes = await legacy(root, 'evidence', [evidence(), evidence({ participant: { secret: 'DO-NOT-PRINT' } }), evidence(), evidence({ claimToken: 17 }), 'malformed']);
  const before = await fs.readdir(root);
  const report = await verifyHostLedger({ rootPath: root });
  assert.equal(report.status, 'legacy');
  assert.equal(report.ready, false);
  assert.deepEqual(report.sources, {
    presence: { records: 1, ignored: 0, rejected: 1, sha256: createHash('sha256').update(bindingBytes).digest('hex') },
    evidence: { records: 2, ignored: 1, rejected: 2, sha256: createHash('sha256').update(bytes).digest('hex') },
  });
  assert.equal(report.presence, 1);
  assert.equal(report.evidence, 2);
  assert.deepEqual(await fs.readdir(root), before);
  const checked = cli(root, ['ledger', 'verify']);
  assert.equal(checked.status, 2, checked.stderr);
  assert.match(checked.stdout, /readiness: not ready/);
  assert.match(checked.stdout, /2 accepted · 1 ignored · 2 rejected · sha256 [a-f0-9]{64}/);
  assert.doesNotMatch(checked.stdout + checked.stderr + JSON.stringify(report), /DO-NOT-PRINT|native-session|sample\.square/);
  await assert.rejects(migrateHostLedger({ rootPath: root }), (error) => {
    assert.match(error.message, /presence: 1 rejected \(first line 1\)/);
    assert.match(error.message, /evidence: 2 rejected \(first line 2\)/);
    assert.doesNotMatch(String(error), /DO-NOT-PRINT|native-session|sample\.square/);
    return true;
  });
  await assert.rejects(fs.stat(path.join(root, LEDGER_FILENAME)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(root, 'presence.ndjsonl'), 'utf8'), bindingBytes);
  assert.equal(await fs.readFile(path.join(root, 'evidence.ndjsonl'), 'utf8'), bytes);
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith('.host-ledger-migrate-')), false);
});

test('ignored-only legacy source imports an empty verified category with zero revisions', async (t) => {
  const root = await rootFor(t);
  await legacy(root, 'presence', ['bad JSON', { v: 0, updatedAt: 1 }]);
  const report = await migrateHostLedger({ rootPath: root });
  assert.equal(report.status, 'migrated');
  assert.equal(report.presence, 0);
  assert.equal(report.evidence, 0);
  assert.equal(report.presenceRevision, 0);
  assert.equal(report.evidenceRevision, 0);
  assert.equal(report.sources.presence.ignored, 2);
  assert.equal((await verifyHostLedger({ rootPath: root })).status, 'sqlite');
});

test('existing valid SQLite is untouched and ignores even now-unsafe retained legacy sources', async (t) => {
  const root = await rootFor(t);
  await legacy(root, 'presence', [presence()]);
  await migrateHostLedger({ rootPath: root });
  await legacy(root, 'presence', [presence({ session: { secret: true } })]);
  const file = path.join(root, LEDGER_FILENAME), before = await fs.readFile(file), metadata = await fs.stat(file);
  for (const operation of [verifyHostLedger, migrateHostLedger]) {
    const report = await operation({ rootPath: root });
    assert.equal(report.status, 'sqlite');
    assert.equal(report.sources, undefined);
    assert.deepEqual(await fs.readFile(file), before);
    assert.equal((await fs.stat(file)).mtimeMs, metadata.mtimeMs);
  }
});

test('unsupported destinations and corrupt derived projections are refused without repair or secret output', async (t) => {
  const root = await rootFor(t), file = path.join(root, LEDGER_FILENAME);
  await fs.writeFile(file, 'not a database SECRET');
  for (const operation of [verifyHostLedger, migrateHostLedger]) {
    await assert.rejects(operation({ rootPath: root }), /verification failed/);
    assert.equal(await fs.readFile(file, 'utf8'), 'not a database SECRET');
  }
  await fs.unlink(file);
  await legacy(root, 'presence', [presence()]);
  await migrateHostLedger({ rootPath: root });
  const db = new DatabaseSync(file);
  try { db.exec("UPDATE host_presence SET session_key='\"wrong\"'"); }
  finally { db.close(); }
  const before = await fs.readFile(file);
  await assert.rejects(verifyHostLedger({ rootPath: root }), /verification failed/);
  assert.deepEqual(await fs.readFile(file), before);
  const result = cli(root, ['ledger', 'verify']);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /native-session|SECRET|sample\.square/);
});

test('publication failure cleans the temporary database and leaves source authority available for retry', async (t) => {
  const root = await rootFor(t), bytes = await legacy(root, 'evidence', [evidence()]);
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('injected publication failure'), { code: 'EIO' }); });
  await assert.rejects(migrateHostLedger({ rootPath: root }), /injected publication failure/);
  t.mock.restoreAll();
  await assert.rejects(fs.stat(path.join(root, LEDGER_FILENAME)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(root, 'evidence.ndjsonl'), 'utf8'), bytes);
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith('.host-ledger-migrate-')), false);
  assert.equal((await migrateHostLedger({ rootPath: root })).status, 'migrated');
});

test('process death before publication leaves legacy authority intact and a subsequent conversion can finish', async (t) => {
  const root = await rootFor(t), bytes = await legacy(root, 'evidence', [evidence()]);
  const child = spawnSync(process.execPath, ['--import', SANDBOX, '--input-type=module', '-e',
    `import {promises as fs} from 'node:fs'; import {migrateHostLedger} from ${JSON.stringify(IMPORTER)};
     fs.link = async () => { process.kill(process.pid, 'SIGKILL'); };
     await migrateHostLedger({rootPath:process.argv[1]});`, root], { cwd: root, encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  await assert.rejects(fs.stat(path.join(root, LEDGER_FILENAME)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(root, 'evidence.ndjsonl'), 'utf8'), bytes);
  assert.equal((await verifyHostLedger({ rootPath: root })).status, 'legacy');
  assert.equal((await migrateHostLedger({ rootPath: root })).status, 'migrated');
  assert.deepEqual(stored(root, 'evidence'), [evidence()]);
});

test('a destination appearing at publication is never overwritten, and an invalid winner is refused', async (t) => {
  const root = await rootFor(t), bytes = await legacy(root, 'evidence', [evidence()]);
  const originalLink = fs.link;
  t.mock.method(fs, 'link', async (source, destination) => {
    await fs.writeFile(destination, 'foreign authority', { flag: 'wx' });
    return originalLink(source, destination);
  });
  await assert.rejects(migrateHostLedger({ rootPath: root }), /verification failed/);
  assert.equal(await fs.readFile(path.join(root, LEDGER_FILENAME), 'utf8'), 'foreign authority');
  assert.equal(await fs.readFile(path.join(root, 'evidence.ndjsonl'), 'utf8'), bytes);
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith('.host-ledger-migrate-')), false);
});

test('cancellation preserves its reason and cannot publish while the claim fence is held', async (t) => {
  const root = await rootFor(t), bytes = await legacy(root, 'presence', [presence()]);
  const controller = new AbortController(), reason = new Error('cancel conversion');
  await withFileLock(path.join(root, 'presence-claim.lock'), { retryMs: 10 }, async () => {
    const pending = migrateHostLedger({ rootPath: root, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(reason), 30);
    try { await assert.rejects(pending, (error) => error === reason); }
    finally { clearTimeout(timer); }
    await assert.rejects(fs.stat(path.join(root, LEDGER_FILENAME)), { code: 'ENOENT' });
  });
  assert.equal(await fs.readFile(path.join(root, 'presence.ndjsonl'), 'utf8'), bytes);
  assert.equal((await migrateHostLedger({ rootPath: root })).status, 'migrated');
});

test('concurrent processes publish exactly once and return the same verified authority', async (t) => {
  const root = await rootFor(t), bytes = await legacy(root, 'evidence', [evidence(), evidence()]);
  const reports = await Promise.all([migrateProcess(root), migrateProcess(root)]);
  assert.deepEqual(reports.map((report) => report.status).sort(), ['migrated', 'sqlite']);
  assert.deepEqual(reports.map((report) => report.evidence), [2, 2]);
  assert.deepEqual(stored(root, 'evidence'), [evidence(), evidence()]);
  assert.equal(await fs.readFile(path.join(root, 'evidence.ndjsonl'), 'utf8'), bytes);
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith('.host-ledger-migrate-')), false);
});

test('global CLI verify/migrate require no location or participant and report only counts/hashes', async (t) => {
  const root = await rootFor(t);
  const help = cli(root, ['ledger', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: square ledger <verify\|migrate\|gc>/);
  assert.doesNotMatch(help.stdout.split('\n')[0], /--location/);
  const empty = cli(root, ['ledger', 'verify']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /host ledger: empty/);
  assert.deepEqual(await fs.readdir(root), []);
  await legacy(root, 'evidence', [evidence({ message: 'PRIVATE-MESSAGE', nativeDelivery: { endpoint: 'PRIVATE-ENDPOINT' } })]);
  const ready = cli(root, ['ledger', 'verify']);
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(ready.stdout, /host ledger: legacy/);
  assert.match(ready.stdout, /sha256 [a-f0-9]{64}/);
  assert.match(ready.stdout, /root: /);
  assert.match(ready.stdout, /Stop agent sessions and MCP services using Square with this ledger before conversion\./);
  assert.match(ready.stdout, /Next: migrate, then verify\.\nsquare ledger migrate\nsquare ledger verify/);
  assert.doesNotMatch(ready.stdout + ready.stderr, /PRIVATE-MESSAGE|PRIVATE-ENDPOINT|native-session/);
  const migrated = cli(root, ['ledger', 'migrate']);
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.match(migrated.stdout, /host ledger: migrated/);
  assert.match(migrated.stdout, /Keep affected sessions and MCP services stopped until verification succeeds\./);
  assert.match(migrated.stdout, /square ledger verify/);
  assert.equal(cli(root, ['ledger', 'verify']).status, 0);
  assert.equal(cli(root, ['ledger', 'migrate', '--force']).status, 2);
});
