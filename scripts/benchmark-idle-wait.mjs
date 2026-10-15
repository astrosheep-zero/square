// Row-storage (v2) capacity instrument. All data and identities are disposable.
//
// Run after `npm run build`, with the sandbox loader, e.g.
//   node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 300 --mode session
//   node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --workers 300 --mode session --active --no-hints
//   node --import ./test/sandbox-env.js scripts/benchmark-idle-wait.mjs --self-test
//
// Modes:
//   events   process-local revision observer wait
//   poll200  reproduces the preceding 200ms polling strategy
//   session  host-ledger-bound session discovery (+ catch phase when --active)
//
// Flags:
//   --workers N        up to 300 independent processes (default 6)
//   --history N        unrelated say rows (default 1800; active session compares 1800,18000)
//   --histories a,b    run the whole measurement once per size (e.g. 1800,18000) and print a
//                      flat comparison; the required no-full-history-hydration evidence
//   --body-bytes N     unrelated say body size (default 2048)
//   --idle-ms N        idle measurement window (default 5000)
//   --discovery-ms N   active discovery probe deadline (default 20000)
//   --active           idle -> bell discovery -> simultaneous catches
//   --no-hints         disable fs.watch inside benchmark workers only; reconciliation stays
//   --timeout-ms N     hard parent guard (default derived)
//   --self-test        bounded instrumentation checks; no runtime, no workers
//
// This file never edits or reconfigures production behavior. `--no-hints` monkeypatches
// `fs.watch` inside the forked benchmark worker process, never through production config.
//
// The parent process must expose these runtime entrypoints (v2 candidate). If any is absent the
// run fails loudly instead of printing empty measurements:
//   dist/open-square.js         buildSquare(path, {markdown, hardCap})
//   dist/artifact.js             createArtifactPort(path)
//   dist/artifact.js             readSquareRevision(path)
//   dist/inbox.js                observeSessionPending(sessionId, env)
//   dist/host-ledger-file-adapter.js  createHostLedgerPort({rootPath})
//   dist/index.js                Square.at(...) / .recognize(env) / participant.catch(...)
// Seed and bell landing go through `artifact.transact(w => w.land(act))` on the SquareArtifactPort.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync, StatementSync } from 'node:sqlite';

const script = fileURLToPath(import.meta.url);
const sandbox = fileURLToPath(new URL('../test/sandbox-env.js', import.meta.url));

const MAX_WORKERS = 300;
const DEFAULT_HISTORY = 1_800;
const DEFAULT_BODY_BYTES = 2_048;

const option = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const intOption = (name, fallback) => { const value = Number(option(name, String(fallback))); return Number.isFinite(value) ? Math.trunc(value) : fallback; };
const flag = (name) => process.argv.includes(name);

// ---------------------------------------------------------------------------------------------
// SQL instrumentation
//
// Artifact `sql` keeps its historical buckets: successful prepares plus exec calls, writes at
// prepare/exec time, returned hydration strings in UTF-8 bytes. `busy`/`commits` are artifact-only.
// Host-root connections (including *.lock databases) go ONLY to `ledgerSql`:
//   prepareAttempts counts prepare calls (including failures); execCalls counts exec batches;
//   statementExecutions counts all/get/run/iterate calls, NOT preparations;
//   readExecutions/writeExecutions count SELECT/mutating execution calls (a batch counts once);
//   rows/returnedBytes count returned rows and UTF-8 string/blob bytes, not JSON decoding or I/O;
//   presenceRows counts rows returned by SELECTs touching host_presence (not lock-table SQL);
//   busy counts thrown busy/locked errors, including prepare and deferred iterator errors;
//   commitAttempts/commitBusy/commitMs measure explicit COMMIT calls, not inferred retries.
// `transactions` separates artifact/ledger and explicit read (BEGIN/DEFERRED) versus write
// (IMMEDIATE/EXCLUSIVE) acquisition modes, not inferred mutation counts. Per connection:
//   acquireMs = first BEGIN attempt -> successful BEGIN return (including busy retry gaps);
//   holdMs = successful BEGIN return -> first COMMIT attempt (wall time, not just SQL);
//   commitMs = first COMMIT attempt -> successful COMMIT return (including retry gaps).
// Only committed, standalone-control transactions yield timing samples. Rollbacks and non-busy
// failed BEGINs reset pending state; busy BEGINs retain the first attempt on that connection.
// Batched control calls (e.g. PRAGMA; BEGIN; CREATE TABLE in lock DBs) cannot expose the inner
// BEGIN boundary: they are counted separately, never given fabricated exact timings. Untracked
// COMMIT/ROLLBACK successes are counted too. No transaction is inferred from autocommit SQL.
// Timing samples grow with completed transactions, never with SQL statements/history rows.
// Phase timing samples are attributed at successful COMMIT, including any earlier acquisition.
// Artifact sql.executionMs accumulates execution-call duration per bucket (not prepare time or
// decoding). Transaction hold includes runtime decoding and event-loop gaps; it is NOT SQL time.
// Parent totals include setup/controls; worker totals are cumulative; phase totals exclude setup.
// `ledger` counts instrumented fs.promises calls and readFile/writeFile bytes, NOT SQLite I/O.
// Its readOps/readBytes prove the file data path. SQLite zero fs bytes is not a performance gain.
// Old mixed-origin reports are not comparable: rerun BOTH runtimes with this same script.
//
// v2 keeps body once in activities.payload_json; heads never select a body. We classify each
// prepared/exec'd statement by the tables it touches and whether it hydrates payload. Counts are
// statements, not free-form promises: a caller must own a positive control proving the counters
// actually move before any "no hydration" claim is believed. The old square_snapshot access is
// counted separately as `legacyWholeState` so a v1 path cannot masquerade as a v2 zero.
// ---------------------------------------------------------------------------------------------

const SQL_BUCKETS = ['header', 'heads', 'hydrated', 'receipts', 'leases', 'routes', 'participants', 'attention', 'audience', 'legacyWholeState', 'schema', 'other'];
const TABLE_BUCKETS = [
  ['square_meta', 'header'],
  ['receipts', 'receipts'],
  ['catch_leases', 'leases'],
  ['routes', 'routes'],
  ['participants', 'participants'],
  ['attention', 'attention'],
  ['landed_audience', 'audience'],
];
const TABLE_MATCHERS = TABLE_BUCKETS.map(([table, bucket]) => [new RegExp(`\\b${table}\\b`), bucket]);

export function classifySql(sql) {
  const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
  if (/\bsquare_snapshot\b/.test(text)) return 'legacyWholeState';
  if (/^\s*(create|drop|alter)\b/.test(text) || /\bsqlite_master\b/.test(text) || /\bsqlite_schema\b/.test(text) || /^\s*pragma\b/.test(text)) return 'schema';
  // `activities` bodies live only in payload_json, so any statement that selects it (or SELECT *)
  // hydrates byte rows. Named-column heads queries never do.
  if (/\bactivities\b/.test(text) && (/\bpayload_json\b/.test(text) || /\bselect\s+(distinct\s+)?\*/.test(text))) return 'hydrated';
  if (/\bsquare_meta\b/.test(text)) return 'header';
  if (/\bactivities\b/.test(text)) return 'heads';
  for (const [matcher, bucket] of TABLE_MATCHERS) if (matcher.test(text)) return bucket;
  return 'other';
}

export function isMutatingSql(sql) {
  return /^\s*(insert|update|delete|replace|create|drop|alter)\b/i.test(String(sql).replace(/\s+/g, ' ').trim());
}

function emptySqlCounters() {
  const statements = {};
  for (const bucket of SQL_BUCKETS) statements[bucket] = 0;
  return { prepared: 0, statements, executionMs: Object.fromEntries(SQL_BUCKETS.map((bucket) => [bucket, 0])), writes: 0, rows: 0, headRows: 0, hydratedRows: 0, hydratedBytes: 0 };
}

function emptyLedgerSqlCounters() {
  return { prepareAttempts: 0, execCalls: 0, statementExecutions: 0, readExecutions: 0, writeExecutions: 0, rows: 0, returnedBytes: 0, presenceRows: 0, busy: 0, commitAttempts: 0, commitBusy: 0, commitMs: 0 };
}

function sumLedgerSql(counters) {
  const total = emptyLedgerSqlCounters();
  for (const counter of counters) for (const key of Object.keys(total)) total[key] += counter.ledgerSql[key];
  return total;
}

function emptyTransactionCounts() {
  return { beginAttempts: 0, beginBusy: 0, beginErrors: 0, begun: 0, committed: 0, rolledBack: 0, samples: [] };
}

function emptyTransactions() {
  return Object.fromEntries(['artifact', 'ledger'].map((origin) => [origin, {
    read: emptyTransactionCounts(), write: emptyTransactionCounts(),
    batchedControlCalls: 0, untrackedCommits: 0, untrackedRollbacks: 0,
  }]));
}

function transactionControl(sql) {
  const text = String(sql).trim();
  const begin = /^BEGIN(?:\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?\s*;?\s*$/i.exec(text);
  if (begin) return { action: 'begin', mode: /IMMEDIATE|EXCLUSIVE/i.test(begin[1] ?? '') ? 'write' : 'read' };
  if (/^(?:COMMIT|END)(?:\s+TRANSACTION)?\s*;?\s*$/i.test(text)) return { action: 'commit' };
  if (/^ROLLBACK(?:\s+TRANSACTION)?\s*;?\s*$/i.test(text)) return { action: 'rollback' };
  // The benchmark/runtime control batches use plain statements, not triggers or SQL literals.
  if (/(?:^|;)\s*(?:BEGIN|COMMIT|END|ROLLBACK)\b/i.test(text)) return { action: 'batch' };
  return undefined;
}

function emptyCounters() {
  return { sql: emptySqlCounters(), ledgerSql: emptyLedgerSqlCounters(), transactions: emptyTransactions(), busy: 0, commits: { attempts: 0, busy: 0, ms: 0 }, ledger: { ops: 0, bytes: 0, readOps: 0, readBytes: 0 }, watch: 0 };
}

function isBusyError(error) {
  const text = [error?.code, error?.errstr, error?.message].filter(Boolean).join(' ').toLowerCase();
  return text.includes('busy') || text.includes('locked');
}

function dummyWatcher() {
  const watcher = {
    on() { return watcher; },
    once() { return watcher; },
    off() { return watcher; },
    addListener() { return watcher; },
    removeListener() { return watcher; },
    close() {},
    unref() { return watcher; },
    ref() { return watcher; },
  };
  watcher[Symbol.dispose] = () => {};
  return watcher;
}

function canonicalizeExistingPrefix(target) {
  const resolved = path.resolve(target);
  const rest = [];
  let head = resolved;
  while (true) {
    try {
      const real = fs.realpathSync(head);
      return rest.length === 0 ? real : path.join(real, ...rest.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return resolved;
      rest.push(path.basename(head));
      head = parent;
    }
  }
}

function ledgerPathMatcher(root) {
  if (typeof root !== 'string' || root.length === 0) return () => false;
  const resolved = path.resolve(root);
  const roots = new Set([resolved, canonicalizeExistingPrefix(resolved)]);
  const prefixes = [...roots].map((entry) => (entry.endsWith(path.sep) ? entry : entry + path.sep));
  return (target) => {
    if (typeof target !== 'string' && !Buffer.isBuffer(target)) return false;
    const raw = String(target);
    const resolved = path.resolve(raw);
    let real = resolved;
    try { real = fs.realpathSync(resolved); } catch { /* keep resolved */ }
    for (const entry of roots) if (raw === entry || resolved === entry || real === entry) return true;
    for (const prefix of prefixes) if (raw.startsWith(prefix) || resolved.startsWith(prefix) || real.startsWith(prefix)) return true;
    return false;
  };
}

/**
 * Install process-local SQL/ledger instrumentation. Returns cumulative counters plus a snapshot.
 * `disableWatch` replaces fs.watch with an inert watcher (benchmark workers only); the 2s
 * authoritative reconciliation interval is untouched, so push-absent discovery still progresses.
 */
export function installInstrumentation({ ledgerRoot, disableWatch = false } = {}) {
  const counters = emptyCounters();
  const bucketOfStatement = new WeakMap();
  const isLedgerPath = ledgerPathMatcher(ledgerRoot);
  const origins = new WeakMap();
  const transactions = new WeakMap();
  const originOf = (database) => {
    if (!origins.has(database)) origins.set(database, isLedgerPath(database.location()) ? 'ledger' : 'artifact');
    return origins.get(database);
  };
  const metadata = (database, sql) => {
    const origin = originOf(database);
    const text = String(sql).replace(/\s+/g, ' ');
    return {
      database, control: transactionControl(sql),
      origin, bucket: origin === 'artifact' ? classifySql(sql) : undefined,
      read: /^\s*SELECT\b/i.test(text),
      write: /(?:^|;)\s*(insert|update|delete|replace|create|drop|alter)\b/i.test(text),
      presence: /\bhost_presence\b/i.test(text),
      commit: /^\s*COMMIT\s*;?\s*$/i.test(text),
    };
  };
  const originals = {
    prepare: DatabaseSync.prototype.prepare,
    exec: DatabaseSync.prototype.exec,
    all: StatementSync.prototype.all,
    get: StatementSync.prototype.get,
    iterate: StatementSync.prototype.iterate,
    run: StatementSync.prototype.run,
    watch: fs.watch,
    promises: {},
  };

  const recordRow = (meta, row) => {
    if (row === undefined || row === null) return;
    if (meta.origin === 'ledger') {
      counters.ledgerSql.rows++;
      if (meta.read && meta.presence) counters.ledgerSql.presenceRows++;
      for (const value of Object.values(row)) {
        counters.ledgerSql.returnedBytes += typeof value === 'string' ? Buffer.byteLength(value, 'utf8')
          : value instanceof Uint8Array ? value.byteLength : 0;
      }
      return;
    }
    counters.sql.rows++;
    if (meta.bucket === 'hydrated') {
      counters.sql.hydratedRows++;
      for (const value of Object.values(row)) {
        if (typeof value === 'string') counters.sql.hydratedBytes += Buffer.byteLength(value, 'utf8');
      }
    } else if (meta.bucket === 'heads') {
      counters.sql.headRows++;
    }
  };
  const onError = (meta, error) => {
    if (!isBusyError(error)) return;
    if (meta.origin === 'ledger') counters.ledgerSql.busy++;
    else counters.busy++;
  };
  const transactionAttempt = (meta, at) => {
    const control = meta.control;
    if (control === undefined) return;
    const database = meta.database, counts = counters.transactions[meta.origin];
    if (control.action === 'batch') {
      counts.batchedControlCalls++;
      transactions.delete(database); // Inner control boundaries are not observable.
    } else if (control.action === 'begin') {
      counts[control.mode].beginAttempts++;
      const current = transactions.get(database);
      // A failed nested BEGIN must not replace the transaction already holding the connection.
      if (current?.beganAt === undefined && current?.mode !== control.mode) {
        transactions.set(database, { mode: control.mode, firstBeginAt: at });
      }
    } else if (control.action === 'commit') {
      const current = transactions.get(database);
      if (current?.beganAt !== undefined && current.firstCommitAt === undefined) current.firstCommitAt = at;
    }
  };
  const transactionResult = (meta, ended, succeeded, error) => {
    const control = meta.control;
    if (control === undefined || control.action === 'batch') return;
    const database = meta.database, counts = counters.transactions[meta.origin];
    const current = transactions.get(database);
    if (control.action === 'begin') {
      const mode = counts[control.mode];
      if (!succeeded) {
        if (isBusyError(error)) mode.beginBusy++;
        else {
          mode.beginErrors++;
          if (current?.beganAt === undefined) transactions.delete(database);
        }
      } else {
        mode.begun++;
        current.beganAt = ended;
      }
    } else if (control.action === 'commit' && succeeded) {
      if (current?.beganAt !== undefined && current.firstCommitAt !== undefined) {
        counts[current.mode].committed++;
        counts[current.mode].samples.push({
          acquireMs: current.beganAt - current.firstBeginAt,
          holdMs: current.firstCommitAt - current.beganAt,
          commitMs: ended - current.firstCommitAt,
        });
      } else counts.untrackedCommits++;
      transactions.delete(database);
    } else if (control.action === 'rollback') {
      if (succeeded) {
        if (current?.beganAt !== undefined) counts[current.mode].rolledBack++;
        else counts.untrackedRollbacks++;
      }
      transactions.delete(database);
    }
  };
  const execute = (meta, fn) => {
    const host = meta.origin === 'ledger';
    if (host) {
      if (meta.read) counters.ledgerSql.readExecutions++;
      if (meta.write) counters.ledgerSql.writeExecutions++;
    }
    const started = performance.now();
    transactionAttempt(meta, started);
    let succeeded = false, failure;
    if (meta.commit) {
      if (host) counters.ledgerSql.commitAttempts++;
      else counters.commits.attempts++;
    }
    try {
      const result = fn();
      succeeded = true;
      return result;
    } catch (error) {
      failure = error;
      onError(meta, error);
      if (meta.commit && isBusyError(error)) {
        if (host) counters.ledgerSql.commitBusy++;
        else counters.commits.busy++;
      }
      throw error;
    } finally {
      const ended = performance.now(), elapsed = ended - started;
      if (!host) counters.sql.executionMs[meta.bucket] += elapsed;
      if (meta.commit) {
        if (host) counters.ledgerSql.commitMs += elapsed;
        else counters.commits.ms += elapsed;
      }
      transactionResult(meta, ended, succeeded, failure);
    }
  };
  const metaOf = (statement) => {
    const meta = bucketOfStatement.get(statement);
    assert.ok(meta, 'SQL statement was prepared before instrumentation; origin is unknown');
    return meta;
  };

  DatabaseSync.prototype.prepare = function (sql, ...args) {
    const meta = metadata(this, sql);
    if (meta.origin === 'ledger') counters.ledgerSql.prepareAttempts++;
    let statement;
    try { statement = originals.prepare.call(this, sql, ...args); }
    catch (error) { onError(meta, error); throw error; }
    bucketOfStatement.set(statement, meta);
    if (meta.origin === 'artifact') {
      counters.sql.prepared++;
      counters.sql.statements[meta.bucket]++;
      if (isMutatingSql(sql)) counters.sql.writes++;
    }
    return statement;
  };
  DatabaseSync.prototype.exec = function (sql, ...args) {
    const meta = metadata(this, sql);
    if (meta.origin === 'ledger') counters.ledgerSql.execCalls++;
    else {
      counters.sql.statements[meta.bucket]++;
      if (isMutatingSql(sql)) counters.sql.writes++;
    }
    return execute(meta, () => originals.exec.call(this, sql, ...args));
  };
  for (const method of ['all', 'get', 'run', 'iterate']) {
    StatementSync.prototype[method] = function (...args) {
      const meta = metaOf(this);
      if (meta.origin === 'ledger') counters.ledgerSql.statementExecutions++;
      const result = execute(meta, () => originals[method].apply(this, args));
      if (method === 'all') for (const row of result) recordRow(meta, row);
      else if (method === 'get') recordRow(meta, result);
      else if (method === 'iterate') {
        return (function* () {
          try { for (const row of result) { recordRow(meta, row); yield row; } }
          catch (error) { onError(meta, error); throw error; }
        })();
      }
      return result;
    };
  }

  const ledgerMethods = ['readFile', 'writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'open', 'stat', 'lstat', 'readdir', 'access', 'copyFile', 'unlink'];
  for (const method of ledgerMethods) {
    const original = fs.promises[method];
    if (typeof original !== 'function') continue;
    originals.promises[method] = original;
    fs.promises[method] = function (target, ...rest) {
      if (!isLedgerPath(target)) return original.call(this, target, ...rest);
      counters.ledger.ops++;
      if (method === 'writeFile') {
        const data = rest[0];
        counters.ledger.bytes += typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : (data?.length ?? 0);
      }
      const result = original.call(this, target, ...rest);
      if (method !== 'readFile' || typeof target !== 'string') return result;
      return Promise.resolve(result).then((value) => {
        const bytes = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : (value?.length ?? 0);
        counters.ledger.bytes += bytes;
        counters.ledger.readOps++;
        counters.ledger.readBytes += bytes;
        return value;
      });
    };
  }
  fs.watch = function (target, ...rest) {
    if (disableWatch) return dummyWatcher();
    if (isLedgerPath(target)) counters.watch++;
    return originals.watch.call(this, target, ...rest);
  };

  return {
    counters,
    snapshot: () => JSON.parse(JSON.stringify(counters)),
    uninstall() {
      DatabaseSync.prototype.prepare = originals.prepare;
      DatabaseSync.prototype.exec = originals.exec;
      StatementSync.prototype.all = originals.all;
      StatementSync.prototype.get = originals.get;
      StatementSync.prototype.iterate = originals.iterate;
      StatementSync.prototype.run = originals.run;
      for (const [method, original] of Object.entries(originals.promises)) fs.promises[method] = original;
      fs.watch = originals.watch;
    },
  };
}

function diffCounters(before, after) {
  const out = emptyCounters();
  out.sql.prepared = after.sql.prepared - before.sql.prepared;
  for (const bucket of SQL_BUCKETS) {
    out.sql.statements[bucket] = after.sql.statements[bucket] - before.sql.statements[bucket];
    out.sql.executionMs[bucket] = after.sql.executionMs[bucket] - before.sql.executionMs[bucket];
  }
  for (const origin of ['artifact', 'ledger']) {
    for (const mode of ['read', 'write']) {
      const target = out.transactions[origin][mode], start = before.transactions[origin][mode], end = after.transactions[origin][mode];
      for (const key of Object.keys(target)) target[key] = key === 'samples' ? end.samples.slice(start.samples.length) : end[key] - start[key];
    }
    for (const key of ['batchedControlCalls', 'untrackedCommits', 'untrackedRollbacks']) {
      out.transactions[origin][key] = after.transactions[origin][key] - before.transactions[origin][key];
    }
  }
  out.sql.writes = after.sql.writes - before.sql.writes;
  out.sql.rows = after.sql.rows - before.sql.rows;
  out.sql.headRows = after.sql.headRows - before.sql.headRows;
  out.sql.hydratedRows = after.sql.hydratedRows - before.sql.hydratedRows;
  out.sql.hydratedBytes = after.sql.hydratedBytes - before.sql.hydratedBytes;
  out.busy = after.busy - before.busy;
  for (const field of ['attempts', 'busy', 'ms']) out.commits[field] = after.commits[field] - before.commits[field];
  for (const key of Object.keys(out.ledgerSql)) out.ledgerSql[key] = after.ledgerSql[key] - before.ledgerSql[key];
  for (const key of Object.keys(out.ledger)) out.ledger[key] = after.ledger[key] - before.ledger[key];
  out.watch = after.watch - before.watch;
  return out;
}

function sumSqlExecutionMs(counters) {
  return Object.fromEntries(SQL_BUCKETS.map((bucket) => [bucket, counters.reduce((total, counter) => total + counter.sql.executionMs[bucket], 0)]));
}

function transactionSummary(counters) {
  return Object.fromEntries(['artifact', 'ledger'].map((origin) => {
    const total = {};
    for (const mode of ['read', 'write']) {
      const entries = counters.map((counter) => counter.transactions[origin][mode]);
      const samples = entries.flatMap((entry) => entry.samples);
      total[mode] = Object.fromEntries(Object.keys(emptyTransactionCounts()).filter((key) => key !== 'samples')
        .map((key) => [key, entries.reduce((sum, entry) => sum + entry[key], 0)]));
      total[mode].timedCommits = samples.length;
      for (const field of ['acquireMs', 'holdMs', 'commitMs']) {
        const values = samples.map((sample) => sample[field]);
        total[mode][field] = values.length === 0 ? null : { total: values.reduce((sum, value) => sum + value, 0), ...latencySummary(values) };
      }
    }
    for (const key of ['batchedControlCalls', 'untrackedCommits', 'untrackedRollbacks']) {
      total[key] = counters.reduce((sum, counter) => sum + counter.transactions[origin][key], 0);
    }
    return [origin, total];
  }));
}

function percentile(values, fraction) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

// p50/p95/max over completed samples only. A step that never ran (missing participant, thrown
// call) contributes no sample; null means "not measured", never a fabricated zero.
function latencySummary(values) {
  const samples = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (samples.length === 0) return null;
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), max: Math.max(...samples) };
}

// ---------------------------------------------------------------------------------------------
// Runtime entrypoints (loaded lazily so --self-test needs no build)
// ---------------------------------------------------------------------------------------------

async function loadRuntime() {
  const missing = [];
  const distDir = fileURLToPath(new URL('../dist', import.meta.url));
  const load = async (moduleName) => {
    const specifier = pathToFileURL(path.join(distDir, moduleName)).href;
    try { return await import(specifier); }
    catch (error) { throw new Error(`benchmark could not load ${specifier}: ${error.message}`); }
  };
  const artifact = await load('artifact.js');
  const fileAdapter = await load('open-square.js');
  const inbox = await load('inbox.js');
  const ledger = await load('host-ledger-file-adapter.js');
  const facade = await load('index.js');
  const need = (owner, name, value) => { if (typeof value !== 'function') missing.push(`${owner}#${name}`); };
  need('dist/open-square.js', 'buildSquare', fileAdapter.buildSquare);
  need('dist/artifact.js', 'createArtifactPort', artifact.createArtifactPort);
  need('dist/artifact.js', 'readSquareRevision', artifact.readSquareRevision);
  need('dist/inbox.js', 'observeSessionPending', inbox.observeSessionPending);
  need('dist/host-ledger-file-adapter.js', 'createHostLedgerPort', ledger.createHostLedgerPort);
  need('dist/index.js', 'Square', facade.Square);
  if (missing.length > 0) {
    throw new Error('benchmark runtime interface missing; the v2 candidate is not ready:\n  - ' + missing.join('\n  - '));
  }
  return {
    buildSquare: fileAdapter.buildSquare,
    createArtifactPort: artifact.createArtifactPort,
    readSquareRevision: artifact.readSquareRevision,
    observeSessionPending: inbox.observeSessionPending,
    createHostLedgerPort: ledger.createHostLedgerPort,
    Square: facade.Square,
  };
}

// ---------------------------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------------------------

function messageInbox() {
  const messages = [];
  const waiters = [];
  process.on('message', (message) => { const waiter = waiters.shift(); if (waiter) waiter(message); else messages.push(message); });
  return () => new Promise((resolve) => { if (messages.length > 0) resolve(messages.shift()); else waiters.push(resolve); });
}

async function polling200(file, runtime, baseline, windowMs) {
  const deadline = performance.now() + windowMs;
  do {
    if (await runtime.readSquareRevision(file) !== baseline) return true;
    await sleep(Math.min(200, Math.max(0, deadline - performance.now())));
  } while (performance.now() < deadline);
  return false;
}

async function runWorker(runtime) {
  const file = process.argv[3];
  const ledgerRoot = process.argv[4];
  const session = process.argv[5];
  const mode = option('--mode', 'events');
  const active = flag('--active');
  const noHints = flag('--no-hints');
  const idleMs = intOption('--idle-ms', 5_000);
  const discoveryMs = intOption('--discovery-ms', 20_000);

  const instrumentation = installInstrumentation({ ledgerRoot, disableWatch: noHints });
  const snapshot = instrumentation.snapshot;
  const next = messageInbox();
  const controller = new AbortController();
  const env = { ...process.env, SQUARE_HOST_LEDGER_ROOT: ledgerRoot, PI_SESSION_ID: session };
  let observer;
  let timer;
  try {
    if (mode === 'session') {
      observer = await runtime.observeSessionPending(session, { SQUARE_HOST_LEDGER_ROOT: ledgerRoot });
      let armed;
      const armedPromise = new Promise((resolve) => { armed = resolve; });
      const pending = observer.wait(Infinity, { signal: controller.signal, onChangeArmed: armed });
      await armedPromise;
      process.send({ ready: true });
      await next(); // go
      const baselineCounters = snapshot();
      const cpuStart = process.cpuUsage();
      const idleStart = performance.now();
      await sleep(idleMs);
      const idleCpu = process.cpuUsage(cpuStart);
      process.send({ phase: 'idle', idle: true, wallMs: performance.now() - idleStart, cpuMs: (idleCpu.user + idleCpu.system) / 1_000, baselineCounters, counters: snapshot() });
      if (!active) { process.send({ phase: 'done' }); return; }

      const discoveryTimer = setTimeout(() => controller.abort(), discoveryMs);
      timer = discoveryTimer;
      const discoveryCpuStart = process.cpuUsage();
      const memberships = await pending;
      const observedAt = Date.now();
      const discoveryCpu = process.cpuUsage(discoveryCpuStart);
      process.send({ phase: 'discovered', observedAt, discovered: memberships.length, cpuMs: (discoveryCpu.user + discoveryCpu.system) / 1_000, counters: snapshot() });
      await next(); // catch
      const catchBaselineCounters = snapshot();
      const catchStarted = performance.now();
      const catchCpuStart = process.cpuUsage();

      let first;
      let second;
      let failure;
      // Per-step catch timings, alongside the unchanged whole-phase wallMs. Each one is recorded
      // only when that step actually completed.
      let openMs;
      let recognizeMs;
      let firstCatchMs;
      let secondCatchMs;
      let closeMs;
      const openStarted = performance.now();
      const square = await runtime.Square.at({ path: file, env });
      openMs = performance.now() - openStarted;
      try {
        const recognizeStarted = performance.now();
        const participant = await square.recognize(env);
        recognizeMs = performance.now() - recognizeStarted;
        if (participant === null) failure = 'recognize returned no participant';
        else {
          const firstStarted = performance.now();
          first = await participant.catch({ limit: 10 });
          firstCatchMs = performance.now() - firstStarted;
          const secondStarted = performance.now();
          second = await participant.catch({ limit: 10 });
          secondCatchMs = performance.now() - secondStarted;
        }
      } catch (error) {
        failure = error.message;
      } finally {
        const closeStarted = performance.now();
        await square.close();
        closeMs = performance.now() - closeStarted;
      }
      process.send({
        phase: 'catch',
        failure,
        openMs,
        recognizeMs,
        firstCatchMs,
        secondCatchMs,
        closeMs,
        caught: first?.activities.length ?? 0,
        reconsume: second?.activities.length ?? 0,
        remaining: first?.remaining ?? -1,
        wallMs: performance.now() - catchStarted,
        cpuMs: Object.values(process.cpuUsage(catchCpuStart)).reduce((sum, value) => sum + value, 0) / 1_000,
        baselineCounters: catchBaselineCounters,
        counters: snapshot(),
      });
      process.send({ phase: 'done' });
    } else {
      const cell = runtime.createArtifactPort(file);
      const baseline = (await cell.read(() => 0)).version;
      process.send({ ready: true });
      await next(); // go
      const baselineCounters = snapshot();
      const cpuStart = process.cpuUsage();
      const started = performance.now();
      const windowMs = active ? discoveryMs : idleMs;
      let changed;
      if (mode === 'poll200') changed = await polling200(file, runtime, baseline, windowMs);
      else changed = await cell.changed(baseline, windowMs);
      const observedAt = Date.now();
      const cpu = process.cpuUsage(cpuStart);
      process.send({
        phase: 'idle',
        changed,
        wallMs: performance.now() - started,
        cpuMs: (cpu.user + cpu.system) / 1_000,
        observedAt,
        baselineCounters,
        counters: snapshot(),
      });
      process.send({ phase: 'done' });
      await cell.close();
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    observer?.close();
    instrumentation.uninstall();
    process.disconnect();
  }
}

// ---------------------------------------------------------------------------------------------
// Parent
// ---------------------------------------------------------------------------------------------

function workerInbox(child) {
  // One ordered stream: messages keep their order, and an exit only surfaces after the messages
  // that were already sent. Otherwise a fast clean exit would race ahead of undelivered reports.
  const queue = [];
  const waiters = [];
  const push = (item) => { const waiter = waiters.shift(); if (waiter) waiter(item); else queue.push(item); };
  child.on('message', (message) => push({ type: 'message', value: message }));
  child.once('exit', (code, signal) => push({ type: 'exit', error: new Error(`worker exited: ${code ?? signal}`) }));
  return {
    next: () => new Promise((resolve) => {
      const item = queue.shift();
      const deliver = (entry) => resolve(entry.type === 'message' ? entry.value : entry.error);
      if (item !== undefined) deliver(item);
      else waiters.push(deliver);
    }),
  };
}

async function expectPhase(inbox, phase) {
  const message = await inbox.next();
  if (message instanceof Error) throw message;
  if (message.phase !== phase) throw new Error(`worker sent ${message.phase ?? JSON.stringify(message)} while waiting for ${phase}`);
  return message;
}

async function measureSize({ workerCount, mode, active, noHints, history, bodyBytes, idleMs, discoveryMs, timeoutMs }) {
  assert.ok(Number.isInteger(workerCount) && workerCount > 0 && workerCount <= MAX_WORKERS, `--workers must be 1..${MAX_WORKERS}`);
  assert.ok(Number.isInteger(history) && history >= 0, '--history must be a nonnegative integer');
  assert.ok(['events', 'poll200', 'session'].includes(mode), '--mode must be events, poll200, or session');

  const runtime = await loadRuntime();
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'square-idle-benchmark-'));
  const children = [];
  const instrumentation = installInstrumentation({ ledgerRoot: path.join(root, 'ledger') });
  const snap = () => instrumentation.snapshot();
  let guard;
  let readyCount = 0;
  let phase = 'setup';
  const phaseReports = { idle: [], discovered: [], catch: [], done: [] };
  let controls;
  let ledgerTransport = 'unknown';
  try {
    const file = path.join(root, 'BENCHMARK.square');
    const ledgerRoot = path.join(root, 'ledger');
    const participants = Array.from({ length: workerCount }, (_, index) => 'Reader' + index);
    const actors = ['Bench', ...participants];

    const open = await runtime.buildSquare(file, { markdown: 'Synthetic idle benchmark', hardCap: null });
    assert.equal(typeof open.artifact?.transact, 'function', 'runtime port must expose transact()');
    const seedStarted = performance.now();
    await open.artifact.transact((write) => {
      if (typeof write.land !== 'function') throw new Error('runtime is not v2: SquareWrite.land is missing');
      for (let index = 0; index < actors.length; index++) write.land({ kind: 'join', actor: actors[index], at: index });
      for (let index = 0; index < history; index++) write.land({ kind: 'say', actor: 'Bench', at: index, body: 'x'.repeat(bodyBytes), mentions: [] });
    });
    const seedMs = performance.now() - seedStarted;
    const afterSeed = snap();

    // Positive controls: prove the instrumentation observes the real v2 path before trusting any zero.
    const headerBefore = snap();
    await open.artifact.read((facts) => facts.header());
    const headerReads = diffCounters(headerBefore, snap()).sql.statements.header;
    const bodyBefore = snap();
    const controlIndex = actors.length; // first unrelated say
    await open.artifact.read((facts) => facts.activities([controlIndex]));
    const bodyDelta = diffCounters(bodyBefore, snap());
    controls = {
      seedWriteStatements: { total: afterSeed.sql.writes, expectedAtLeast: actors.length + history },
      headerReads,
      hydratedRows: bodyDelta.sql.hydratedRows,
      hydratedBytes: bodyDelta.sql.hydratedBytes,
      legacyWholeStateReads: afterSeed.sql.statements.legacyWholeState,
    };
    assert.ok(controls.seedWriteStatements.total >= controls.seedWriteStatements.expectedAtLeast, `positive control: seeding must issue write statements (saw ${controls.seedWriteStatements.total})`);
    assert.ok(controls.headerReads >= 1, 'positive control: header() must issue a square_meta read');
    assert.ok(controls.hydratedRows >= 1 && controls.hydratedBytes > 0, 'positive control: activities() must hydrate a body row with bytes');
    assert.equal(controls.legacyWholeStateReads, 0, 'positive control: hot v2 path must not read square_snapshot');

    const ledger = runtime.createHostLedgerPort({ rootPath: ledgerRoot });
    for (let index = 0; index < workerCount; index++) {
      await ledger.ensurePresence({ location: file, participant: participants[index], session: 'bench-' + index, channel: 'pi', updatedAt: Date.now() });
    }
    const ledgerSetupOps = snap().ledger.ops;
    controls.ledgerSetupOps = ledgerSetupOps;
    // Read an existing seeded binding: no probe participants or writes alter the workload.
    // Lock DB SQL is not evidence of SQLite data storage; host_presence rows are.
    const ledgerProbeBefore = snap();
    const probePresence = await ledger.listPresence({ location: file, participant: participants[0], session: 'bench-0' });
    const ledgerProbe = diffCounters(ledgerProbeBefore, snap());
    controls.ledgerProbe = ledgerProbe;
    assert.equal(probePresence.length, 1, 'positive control: seeded presence must be readable through the port');
    assert.equal(probePresence[0].participant, participants[0]);
    assert.equal(probePresence[0].session, 'bench-0');
    const sqlData = ledgerProbe.ledgerSql.presenceRows > 0 && ledgerProbe.ledgerSql.returnedBytes > 0;
    const fileData = ledgerProbe.ledger.readOps > 0 && ledgerProbe.ledger.readBytes > 0;
    assert.notEqual(sqlData, fileData, 'positive control: exactly one observed ledger data-read transport is required');
    ledgerTransport = sqlData ? 'sqlite' : 'file';
    controls.ledgerTransport = ledgerTransport;

    const argsFor = (index) => [
      '--worker', file, ledgerRoot, 'bench-' + index,
      '--mode', mode,
      '--idle-ms', String(idleMs),
      '--discovery-ms', String(discoveryMs),
      ...(active ? ['--active'] : []),
      ...(noHints ? ['--no-hints'] : []),
    ];
    const inboxes = [];
    for (let index = 0; index < workerCount; index++) {
      const child = fork(script, argsFor(index), { execArgv: ['--import', sandbox], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      children.push(child);
      inboxes.push(workerInbox(child));
    }

    const commit = { startedAt: undefined, finishedAt: undefined };
    const landBell = async () => {
      commit.startedAt = Date.now();
      await open.artifact.transact((write) => {
        write.land({ kind: 'say', actor: 'Bench', at: Date.now(), body: 'benchmark wake', mentions: [], reach: 'bell' });
      });
      commit.finishedAt = Date.now();
    };
    const collectPhase = (selectedPhase) => {
      phase = selectedPhase;
      return Promise.all(inboxes.map(async (inbox, index) => {
        const report = await expectPhase(inbox, selectedPhase);
        phaseReports[selectedPhase][index] = report;
        return report;
      }));
    };
    const run = async () => {
      phase = 'readiness';
      await Promise.all(inboxes.map((inbox) => inbox.next().then((message) => {
        if (message instanceof Error) throw new Error(`${readyCount}/${workerCount} ready: ${message.message}`);
        if (!message.ready) throw new Error(`${readyCount}/${workerCount} ready: worker sent no readiness before work`);
        readyCount++;
      })));
      const readiness = { expected: workerCount, ready: readyCount };
      for (const child of children) child.send('go');

      if (mode !== 'session' && active) {
        setTimeout(() => { landBell().catch(() => { for (const child of children) child.kill('SIGTERM'); }); }, 250);
      }

      const idle = await collectPhase('idle');

      if (mode !== 'session' || !active) {
        const done = await collectPhase('done');
        return { readiness, idle, done: done.length, changed: mode === 'session' ? undefined : idle.map((report) => report.changed) };
      }

      // Discovery: land one bell after every worker finished its idle window and is watching.
      await landBell();
      const discovered = await collectPhase('discovered');
      const notReady = discovered.filter((report) => !(report.discovered > 0));
      if (notReady.length > 0) throw new Error(`${notReady.length}/${workerCount} workers did not discover the bell within ${discoveryMs}ms`);

      for (const child of children) child.send('catch');
      const catches = await collectPhase('catch');
      const done = await collectPhase('done');
      const failedCatches = catches.filter((report) => report.failure || report.caught !== 1 || report.reconsume !== 0);
      if (failedCatches.length > 0) throw new Error(`${failedCatches.length}/${workerCount} workers failed the catch phase`);

      return { readiness, idle, discovered, catches, done: done.length, changed: undefined };
    };

    const [, result] = await Promise.race([
      Promise.resolve().then(() => run()).then((value) => [undefined, value]),
      new Promise((_, reject) => { guard = setTimeout(() => reject(new Error(`benchmark timed out after ${timeoutMs}ms; ${readyCount}/${workerCount} workers ready`)), timeoutMs); }),
    ]);
    const finalCounters = snap();
    const artifactBytes = (await fs.promises.stat(file)).size;

    const sum = (values, pick) => values.reduce((total, value) => total + pick(value), 0);
    const idleCumulative = result.idle.map((report) => report.counters);
    const idleCounters = result.idle.map((report) => diffCounters(report.baselineCounters, report.counters));
    const discoveredCounters = (result.discovered ?? []).map((report) => report.counters);
    const catchCounters = (result.catches ?? []).map((report) => report.counters);
    const discoveryDelta = discoveredCounters.map((counters, index) => diffCounters(idleCumulative[index], counters));
    const catchDelta = catchCounters.map((counters, index) => diffCounters(result.catches[index].baselineCounters, counters));

    const latencyReports = result.discovered ?? (active && mode !== 'session'
      ? result.idle.filter((report) => report.changed === true) : []);
    const latencies = commit.finishedAt === undefined ? [] : latencyReports.map((report) => Math.max(0, report.observedAt - commit.finishedAt));
    const discoveredTotal = result.discovered === undefined
      ? result.idle.filter((report) => report.changed === true).length
      : sum(result.discovered, (report) => report.discovered);

    const perWorker = result.idle.map((report, index) => ({
      index,
      mode,
      active,
      idle: report,
      idleDelta: idleCounters[index],
      counters: report.counters,
      ...(result.discovered === undefined ? {} : { discovered: result.discovered[index], discoveryDelta: discoveryDelta[index] }),
      ...(result.catches === undefined ? {} : { catch: result.catches[index], catchDelta: catchDelta[index], catchTransactions: transactionSummary([catchDelta[index]]) }),
      cpuPercent: report.cpuMs / Math.max(1, report.wallMs) * 100,
    }));

    const report = {
      node: process.version,
      mode,
      active,
      noHints,
      workerCount,
      history,
      bodyBytes,
      idleMs,
      discoveryMs,
      seed: { acts: actors.length + history, ms: Math.round(seedMs), artifactBytes },
      setup: { sessionSetupExcluded: true, participants: workerCount, receiverBeforeIdle: result.idle.map((report) => report.baselineCounters) },
      readiness: result.readiness,
      completions: result.done,
      controls,
      phases: {
        idle: {
          cpuMsTotal: sum(result.idle, (item) => item.cpuMs),
          meanCpuPercent: sum(result.idle, (item) => item.cpuMs / Math.max(1, item.wallMs)) / workerCount * 100,
          hydratedRows: { total: sum(idleCounters, (c) => c.sql.hydratedRows), max: Math.max(0, ...idleCounters.map((c) => c.sql.hydratedRows)) },
          hydratedBytesTotal: sum(idleCounters, (c) => c.sql.hydratedBytes),
          ledgerBytesTotal: sum(idleCounters, (c) => c.ledger.bytes),
          headRowsTotal: sum(idleCounters, (c) => c.sql.headRows),
          headerStatementsTotal: sum(idleCounters, (c) => c.sql.statements.header),
          legacyWholeStateTotal: sum(idleCounters, (c) => c.sql.statements.legacyWholeState),
          ledgerOpsTotal: sum(idleCounters, (c) => c.ledger.ops),
          busyTotal: sum(idleCounters, (c) => c.busy),
          ledgerSql: sumLedgerSql(idleCounters),
        },
        discovery: latencies.length === 0 ? null : {
          commitMs: commit.finishedAt - commit.startedAt,
          latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: Math.max(...latencies) },
          discoveredTotal,
          cpuMsTotal: sum(result.discovered ?? [], (item) => item.cpuMs),
          headRowsTotal: sum(discoveryDelta, (c) => c.sql.headRows),
          headerStatementsTotal: sum(discoveryDelta, (c) => c.sql.statements.header),
          ledgerBytesTotal: sum(discoveryDelta, (c) => c.ledger.bytes),
          commitAttempts: sum(discoveryDelta, (c) => c.commits.attempts),
          commitBusy: sum(discoveryDelta, (c) => c.commits.busy),
          commitExecutionMsTotal: sum(discoveryDelta, (c) => c.commits.ms),
          hydratedRowsTotal: result.discovered === undefined ? 0 : sum(discoveryDelta, (c) => c.sql.hydratedRows),
          hydratedBytesTotal: result.discovered === undefined ? 0 : sum(discoveryDelta, (c) => c.sql.hydratedBytes),
          ledgerOpsTotal: result.discovered === undefined ? 0 : sum(discoveryDelta, (c) => c.ledger.ops),
          busyTotal: result.discovered === undefined ? 0 : sum(discoveryDelta, (c) => c.busy),
          ledgerSql: sumLedgerSql(discoveryDelta),
        },
        catch: result.catches === undefined ? null : {
          caughtPerWorker: { min: Math.min(...result.catches.map((item) => item.caught)), max: Math.max(...result.catches.map((item) => item.caught)) },
          reconsumeTotal: sum(result.catches, (item) => item.reconsume),
          cpuMsTotal: sum(result.catches, (item) => item.cpuMs),
          wallMs: { p50: percentile(result.catches.map((item) => item.wallMs), 0.5), p95: percentile(result.catches.map((item) => item.wallMs), 0.95), max: Math.max(...result.catches.map((item) => item.wallMs)) },
          openMs: latencySummary(result.catches.map((item) => item.openMs)),
          recognizeMs: latencySummary(result.catches.map((item) => item.recognizeMs)),
          firstCatchMs: latencySummary(result.catches.map((item) => item.firstCatchMs)),
          secondCatchMs: latencySummary(result.catches.map((item) => item.secondCatchMs)),
          closeMs: latencySummary(result.catches.map((item) => item.closeMs)),
          transactions: transactionSummary(catchDelta),
          sqlExecutionMs: sumSqlExecutionMs(catchDelta),
          headerStatementsTotal: sum(catchDelta, (c) => c.sql.statements.header),
          ledgerBytesTotal: sum(catchDelta, (c) => c.ledger.bytes),
          commitAttempts: sum(catchDelta, (c) => c.commits.attempts),
          commitBusy: sum(catchDelta, (c) => c.commits.busy),
          commitExecutionMsTotal: sum(catchDelta, (c) => c.commits.ms),
          hydratedRowsTotal: sum(catchDelta, (c) => c.sql.hydratedRows),
          hydratedBytesTotal: sum(catchDelta, (c) => c.sql.hydratedBytes),
          headRowsTotal: sum(catchDelta, (c) => c.sql.headRows),
          writesTotal: sum(catchDelta, (c) => c.sql.writes),
          busyTotal: sum(catchDelta, (c) => c.busy),
          ledgerOpsTotal: sum(catchDelta, (c) => c.ledger.ops),
          ledgerSql: sumLedgerSql(catchDelta),
        },
      },
      sql: { ...finalCounters.sql, busy: finalCounters.busy, commits: finalCounters.commits },
      transactions: transactionSummary([finalCounters]),
      ledger: { ...finalCounters.ledger, transport: ledgerTransport, fsBytesComparable: ledgerTransport === 'file' },
      ledgerSql: finalCounters.ledgerSql,
      workerLedgerSql: sumLedgerSql((result.catches ?? result.discovered ?? result.idle).map((item) => item.counters)),
      workers: perWorker,
    };
    if (mode !== 'session' || !active) {
      report.unexpectedResults = result.changed === undefined ? 0 : result.changed.filter((changed) => changed !== active).length;
      assert.equal(report.unexpectedResults, 0, 'not all workers observed the expected state');
    }
    if (result.readiness.ready !== workerCount || result.done !== workerCount) {
      throw new Error(`incomplete workers: ready ${result.readiness.ready}/${workerCount}, completions ${result.done}/${workerCount}`);
    }
    return report;
  } catch (error) {
    // Failure is evidence too. Report only counters actually received, never invent missing workers.
    const received = Object.fromEntries(Object.entries(phaseReports).map(([name, reports]) => {
      const actual = reports.filter(Boolean);
      const deltas = reports.flatMap((report, index) => {
        if (!report?.counters) return [];
        const before = report.baselineCounters ?? (name === 'discovered' ? phaseReports.idle[index]?.counters : undefined);
        return before ? [diffCounters(before, report.counters)] : [];
      });
      return [name, {
        reportedWorkers: actual.length,
        discoveredWorkers: actual.filter((report) => report.discovered > 0).length,
        caught: actual.reduce((sum, report) => sum + (report.caught ?? 0), 0),
        reconsume: actual.reduce((sum, report) => sum + (report.reconsume ?? 0), 0),
        cpuMs: actual.reduce((sum, report) => sum + (report.cpuMs ?? 0), 0),
        timingsMs: {
          open: latencySummary(actual.map((report) => report.openMs)),
          recognize: latencySummary(actual.map((report) => report.recognizeMs)),
          firstCatch: latencySummary(actual.map((report) => report.firstCatchMs)),
          secondCatch: latencySummary(actual.map((report) => report.secondCatchMs)),
          close: latencySummary(actual.map((report) => report.closeMs)),
        },
        cumulativeHydratedRows: actual.reduce((sum, report) => sum + (report.counters?.sql.hydratedRows ?? 0), 0),
        cumulativeHydratedBytes: actual.reduce((sum, report) => sum + (report.counters?.sql.hydratedBytes ?? 0), 0),
        cumulativeBusy: actual.reduce((sum, report) => sum + (report.counters?.busy ?? 0), 0),
        cumulativeLedgerSql: sumLedgerSql(actual.filter((report) => report.counters).map((report) => report.counters)),
        ledgerSql: sumLedgerSql(deltas),
        transactions: transactionSummary(deltas),
        sqlExecutionMs: sumSqlExecutionMs(deltas),
        ledgerBytes: deltas.reduce((sum, delta) => sum + delta.ledger.bytes, 0),
        ledgerOps: deltas.reduce((sum, delta) => sum + delta.ledger.ops, 0),
        failures: actual.flatMap((report) => report.failure === undefined ? [] : [report.failure]),
      }];
    }));
    console.error(JSON.stringify({ failed: true, error: error.message, workerCount, history, phase, readyCount, controls,
      ledger: { ...snap().ledger, transport: ledgerTransport, fsBytesComparable: ledgerTransport === 'file' },
      ledgerSql: snap().ledgerSql, received }, null, 2));
    throw error;
  } finally {
    clearTimeout(guard);
    instrumentation.uninstall();
    await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      return exited;
    }));
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

/** Flat per-size evidence so 1,800 versus 18,000 can be read without diffing full reports. */
function compareRuns(runs) {
  const pick = (run, path, fallback = null) => path.reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), run) ?? fallback;
  return {
    histories: runs.map((run) => run.history),
    idleHydratedRows: runs.map((run) => run.phases.idle.hydratedRows.total),
    discoveryHydratedRows: runs.map((run) => pick(run, ['phases', 'discovery', 'hydratedRowsTotal'])),
    catchHydratedRows: runs.map((run) => pick(run, ['phases', 'catch', 'hydratedRowsTotal'])),
    discoveryLatencyP50: runs.map((run) => pick(run, ['phases', 'discovery', 'latencyMs', 'p50'])),
    catchBusy: runs.map((run) => pick(run, ['phases', 'catch', 'busyTotal'])),
    catchLedgerSql: runs.map((run) => pick(run, ['phases', 'catch', 'ledgerSql'])),
    catchTransactions: runs.map((run) => pick(run, ['phases', 'catch', 'transactions'])),
    catchSqlExecutionMs: runs.map((run) => pick(run, ['phases', 'catch', 'sqlExecutionMs'])),
    ledgerTransport: runs.map((run) => run.ledger.transport),
    legacyWholeState: runs.map((run) => run.sql.statements.legacyWholeState),
    seedMs: runs.map((run) => run.seed.ms),
  };
}

async function runParent() {
  const workerCount = intOption('--workers', 6);
  const mode = option('--mode', 'events');
  const active = flag('--active');
  const noHints = flag('--no-hints');
  const bodyBytes = intOption('--body-bytes', DEFAULT_BODY_BYTES);
  const idleMs = intOption('--idle-ms', 5_000);
  const discoveryMs = intOption('--discovery-ms', 20_000);
  const timeoutMs = intOption('--timeout-ms', Math.max(120_000, idleMs + discoveryMs + 120_000));
  const historiesOption = option('--histories', undefined);
  const histories = historiesOption === undefined
    ? option('--history', undefined) !== undefined ? [intOption('--history', DEFAULT_HISTORY)]
      : mode === 'session' && active ? [1_800, 18_000] : [DEFAULT_HISTORY]
    : historiesOption.split(',').map((value) => Number(value.trim()));
  assert.ok(histories.length > 0 && histories.every((value) => Number.isInteger(value) && value >= 0), '--histories must be a comma-separated list of nonnegative integers');

  const runs = [];
  for (const history of histories) {
    runs.push(await measureSize({ workerCount, mode, active, noHints, history, bodyBytes, idleMs, discoveryMs, timeoutMs }));
  }
  if (runs.length === 1) {
    console.log(JSON.stringify(runs[0], null, 2));
    return;
  }
  console.log(JSON.stringify({ runs, comparison: compareRuns(runs) }, null, 2));
}

// ---------------------------------------------------------------------------------------------
// Self-test: bounded, no runtime, no workers
// ---------------------------------------------------------------------------------------------

async function selfTest() {
  // Classification.
  const cases = [
    ['SELECT revision, next_act_index FROM square_meta WHERE id = 1', 'header', false],
    ['SELECT m.*, (SELECT MAX(act_index) FROM activities) FROM square_meta m', 'header', false],
    ['SELECT act_index, at, kind, actor_json, reach, reply_index FROM activities WHERE act_index > ? ORDER BY act_index LIMIT 100', 'heads', false],
    ['SELECT act_index, payload_json FROM activities WHERE act_index IN (?,?)', 'hydrated', false],
    ['SELECT * FROM activities WHERE act_index IN (SELECT value FROM json_each(?)) ORDER BY act_index', 'hydrated', false],
    ['SELECT COUNT(*) AS n FROM activities a WHERE a.kind = ?', 'heads', false],
    ['SELECT owner_json, act_index, at FROM receipts WHERE owner_json = ?', 'receipts', false],
    ['SELECT * FROM catch_leases WHERE owner_json = ?', 'leases', false],
    ['SELECT position, participant_key_json, session_json FROM routes ORDER BY position', 'routes', false],
    ['SELECT name_key_json, joined, done FROM participants', 'participants', false],
    ['SELECT listener_key_json, target_key_json, kind FROM attention', 'attention', false],
    ['INSERT INTO landed_audience (act_index, recipient_key_json, recipient_order, route) VALUES (?,?,?,?)', 'audience', true],
    ['DELETE FROM receipts WHERE owner_json = ? AND act_index = ?', 'receipts', true],
    ['SELECT * FROM square_snapshot', 'legacyWholeState', false],
    ['CREATE TABLE activities (act_index INTEGER PRIMARY KEY)', 'schema', true],
    ['PRAGMA user_version', 'schema', false],
  ];
  for (const [sql, bucket, mutating] of cases) {
    assert.equal(classifySql(sql), bucket, `classify: ${sql}`);
    assert.equal(isMutatingSql(sql), mutating, `mutating: ${sql}`);
  }

  const dbFile = path.join(os.tmpdir(), `square-benchmark-selftest-${process.pid}.db`);
  fs.rmSync(dbFile, { force: true });
  const ledgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'square-benchmark-ledger-'));
  const instrumentation = installInstrumentation({ ledgerRoot });
  try {
    const db = new DatabaseSync(dbFile);
    db.exec('CREATE TABLE activities (act_index INTEGER PRIMARY KEY, payload_json TEXT NOT NULL)');
    db.prepare('INSERT INTO activities (act_index, payload_json) VALUES (?, ?)').run(0, JSON.stringify({ body: 'hello' }));
    const hydrationBefore = instrumentation.snapshot();
    const rows = db.prepare('SELECT act_index, payload_json FROM activities').all();
    const hydrationDelta = diffCounters(hydrationBefore, instrumentation.snapshot());
    assert.equal(rows.length, 1);
    assert.ok(hydrationDelta.sql.hydratedRows >= 1, 'self-test control: hydrated rows counted');
    assert.ok(hydrationDelta.sql.hydratedBytes > 0, 'self-test control: hydrated bytes counted');
    assert.ok(hydrationDelta.sql.executionMs.hydrated > 0, 'hydration execution duration counted');
    assert.ok(instrumentation.counters.sql.executionMs.schema > 0, 'schema execution duration counted');
    const headsBefore = instrumentation.snapshot();
    db.prepare('SELECT act_index FROM activities').all();
    assert.ok(diffCounters(headsBefore, instrumentation.snapshot()).sql.executionMs.heads > 0, 'head execution duration counted');
    db.close();

    // Busy positive control: a held write lock must be observed, not silently dropped.
    const acquisitionBefore = instrumentation.snapshot();
    const holder = new DatabaseSync(dbFile);
    holder.exec('BEGIN IMMEDIATE');
    const contender = new DatabaseSync(dbFile);
    contender.exec('PRAGMA busy_timeout=0');
    const busyBefore = instrumentation.counters.busy;
    assert.throws(() => contender.exec('BEGIN IMMEDIATE'), isBusyError);
    const acquisitionGapStart = performance.now();
    let busyThrown = false;
    try { contender.prepare('INSERT INTO activities (act_index, payload_json) VALUES (?, ?)').run(1, '{}'); }
    catch { busyThrown = true; }
    assert.ok(busyThrown, 'self-test control: contended write must throw');
    assert.ok(instrumentation.counters.busy > busyBefore, 'self-test control: busy counter must move');
    await sleep(5);
    holder.exec('ROLLBACK');
    const acquisitionGapEnd = performance.now();
    contender.exec('BEGIN IMMEDIATE');
    // A non-busy nested BEGIN error cannot replace the write transaction's original boundary.
    assert.throws(() => contender.exec('BEGIN'), /transaction/i);
    contender.exec('COMMIT');
    const acquisition = diffCounters(acquisitionBefore, instrumentation.snapshot());
    assert.equal(acquisition.transactions.artifact.write.beginAttempts, 3);
    assert.equal(acquisition.transactions.artifact.write.beginBusy, 1);
    assert.equal(acquisition.transactions.artifact.write.begun, 2);
    assert.equal(acquisition.transactions.artifact.write.rolledBack, 1);
    assert.equal(acquisition.transactions.artifact.write.committed, 1);
    assert.equal(acquisition.transactions.artifact.read.beginErrors, 1);
    assert.equal(acquisition.transactions.artifact.write.samples.length, 1);
    assert.ok(acquisition.transactions.artifact.write.samples[0].acquireMs >= acquisitionGapEnd - acquisitionGapStart, 'acquisition includes busy retry gaps');
    assert.ok(acquisition.transactions.artifact.write.samples[0].holdMs >= 0);

    // Even a refused ROLLBACK resets a pending, failed BEGIN before a later acquisition.
    holder.exec('BEGIN IMMEDIATE');
    assert.throws(() => contender.exec('BEGIN IMMEDIATE'), isBusyError);
    await sleep(5);
    assert.throws(() => contender.exec('ROLLBACK'), /transaction/i);
    holder.exec('ROLLBACK');
    const resetBefore = instrumentation.snapshot();
    const freshBeginStart = performance.now();
    contender.exec('BEGIN IMMEDIATE');
    const freshBeginEnd = performance.now();
    contender.exec('COMMIT');
    const reset = diffCounters(resetBefore, instrumentation.snapshot());
    assert.equal(reset.transactions.artifact.write.samples.length, 1);
    assert.ok(reset.transactions.artifact.write.samples[0].acquireMs <= freshBeginEnd - freshBeginStart, 'reset cannot retain an abandoned BEGIN timestamp');
    holder.close();
    contender.close();

    // A failed standalone BEGIN without an active transaction also resets its pending state.
    const reopened = new DatabaseSync(':memory:');
    reopened.exec('BEGIN');
    reopened.exec('ROLLBACK');
    reopened.close();
    const failedBefore = instrumentation.snapshot();
    assert.throws(() => reopened.exec('BEGIN'), /open|closed/i);
    reopened.open();
    reopened.exec('BEGIN');
    reopened.exec('COMMIT');
    const failedBegin = diffCounters(failedBefore, instrumentation.snapshot());
    assert.equal(failedBegin.transactions.artifact.read.beginErrors, 1);
    assert.equal(failedBegin.transactions.artifact.read.committed, 1);
    assert.equal(failedBegin.transactions.artifact.read.samples.length, 1);
    reopened.close();

    assert.deepEqual(instrumentation.counters.ledgerSql, emptyLedgerSqlCounters(), 'artifact SQL must not enter host counters');

    // Host SQL is isolated, counted at execution (including statement reuse), and returns bytes.
    const hostFile = path.join(ledgerRoot, 'host-ledger.sqlite');
    const host = new DatabaseSync(hostFile);
    const hostBefore = instrumentation.snapshot();
    host.exec('CREATE TABLE host_presence (participant TEXT, payload BLOB)');
    host.prepare('INSERT INTO host_presence VALUES (?, ?)').run('Reader0', new Uint8Array([1, 2, 3]));
    const select = host.prepare('SELECT * FROM host_presence');
    assert.equal(select.get().participant, 'Reader0');
    assert.equal([...select.iterate()].length, 1);
    const hostDelta = diffCounters(hostBefore, instrumentation.snapshot());
    assert.equal(hostDelta.ledgerSql.prepareAttempts, 2);
    assert.equal(hostDelta.ledgerSql.execCalls, 1);
    assert.equal(hostDelta.ledgerSql.statementExecutions, 3);
    assert.equal(hostDelta.ledgerSql.readExecutions, 2);
    assert.equal(hostDelta.ledgerSql.writeExecutions, 2);
    assert.equal(hostDelta.ledgerSql.rows, 2);
    assert.equal(hostDelta.ledgerSql.presenceRows, 2);
    assert.equal(hostDelta.ledgerSql.returnedBytes, 20); // 2 * (7 UTF-8 bytes + 3 blob bytes)
    assert.deepEqual(hostDelta.sql, emptySqlCounters(), 'host SQL must not enter artifact buckets/rows/writes');
    assert.equal(hostDelta.busy, 0);
    assert.deepEqual(hostDelta.commits, { attempts: 0, busy: 0, ms: 0 });

    // Lock databases belong to the host origin too, but are not data-transport evidence.
    const lock = new DatabaseSync(path.join(ledgerRoot, 'presence.ndjsonl.lock'));
    const lockBefore = instrumentation.snapshot();
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE __square_file_lock (id INTEGER)');
    lock.exec('COMMIT;');
    const lockDelta = diffCounters(lockBefore, instrumentation.snapshot());
    assert.equal(lockDelta.ledgerSql.execCalls, 2);
    assert.equal(lockDelta.ledgerSql.writeExecutions, 1);
    assert.equal(lockDelta.ledgerSql.commitAttempts, 1);
    assert.equal(lockDelta.ledgerSql.presenceRows, 0);
    assert.deepEqual(lockDelta.sql, emptySqlCounters());
    assert.equal(lockDelta.transactions.ledger.batchedControlCalls, 1);
    assert.equal(lockDelta.transactions.ledger.untrackedCommits, 1);
    assert.equal(lockDelta.transactions.ledger.write.samples.length, 0, 'batched BEGIN boundaries must not fabricate precise timing');
    lock.close();

    const rival = new DatabaseSync(hostFile);
    rival.exec('PRAGMA busy_timeout=0');
    host.exec('PRAGMA busy_timeout=0');
    const insert = rival.prepare('INSERT INTO host_presence VALUES (?, ?)');
    const iterator = rival.prepare('SELECT * FROM host_presence').iterate();
    const cold = new DatabaseSync(hostFile); // no schema cache: prepare itself must read the DB
    cold.exec('PRAGMA busy_timeout=0');
    host.exec('BEGIN EXCLUSIVE');
    const busyBeforeHost = instrumentation.snapshot();
    assert.throws(() => cold.prepare('SELECT * FROM host_presence'), isBusyError);
    assert.throws(() => insert.run('blocked', null), isBusyError);
    assert.throws(() => iterator.next(), isBusyError); // error occurs after iterate() returned
    const hostBusy = diffCounters(busyBeforeHost, instrumentation.snapshot());
    assert.equal(hostBusy.ledgerSql.busy, 3, 'prepare, execution and deferred iterator busy counted once each');
    assert.equal(hostBusy.busy, 0, 'host contention must not count as artifact busy');
    host.exec('ROLLBACK');
    cold.close();

    // A reader prevents a writer's commit; retry calls are visible, not guessed from busy counts.
    const transactionBefore = instrumentation.snapshot();
    host.exec('BEGIN');
    host.prepare('SELECT * FROM host_presence').all();
    rival.exec('BEGIN IMMEDIATE');
    insert.run('Reader1', null);
    const commitBefore = instrumentation.snapshot();
    assert.throws(() => rival.exec('COMMIT'), isBusyError);
    const commitGapStart = performance.now();
    await sleep(5);
    host.exec('ROLLBACK');
    const commitGapEnd = performance.now();
    rival.exec('COMMIT');
    const commits = diffCounters(commitBefore, instrumentation.snapshot());
    assert.equal(commits.ledgerSql.commitAttempts, 2);
    assert.equal(commits.ledgerSql.commitBusy, 1);
    assert.equal(commits.ledgerSql.busy, 1);
    assert.equal(commits.busy, 0);
    assert.deepEqual(commits.commits, { attempts: 0, busy: 0, ms: 0 });
    const transactionDelta = diffCounters(transactionBefore, instrumentation.snapshot());
    assert.equal(transactionDelta.transactions.ledger.read.rolledBack, 1);
    assert.equal(transactionDelta.transactions.ledger.read.samples.length, 0);
    assert.equal(transactionDelta.transactions.ledger.write.committed, 1);
    assert.equal(transactionDelta.transactions.ledger.write.samples.length, 1);
    assert.ok(transactionDelta.transactions.ledger.write.samples[0].commitMs >= commitGapEnd - commitGapStart, 'commit timing includes retry gaps');
    assert.deepEqual(transactionDelta.transactions.artifact, emptyTransactions().artifact, 'origins retain independent transaction boundaries');
    const timingSummary = transactionSummary([transactionDelta]);
    assert.equal(timingSummary.ledger.write.timedCommits, 1);
    assert.equal(timingSummary.ledger.write.commitMs.p95, transactionDelta.transactions.ledger.write.samples[0].commitMs);
    assert.equal(timingSummary.ledger.read.commitMs, null, 'rolled-back transactions supply no commit sample');
    rival.close();
    host.close();

    // File transport measures actual readFile results, independently of lock SQL.
    const fsBefore = instrumentation.snapshot();
    await fs.promises.writeFile(path.join(ledgerRoot, 'presence.ndjsonl'), '{"v":1}\n');
    await fs.promises.readFile(path.join(ledgerRoot, 'presence.ndjsonl'), 'utf8');
    const fsDelta = diffCounters(fsBefore, instrumentation.snapshot());
    assert.equal(fsDelta.ledger.ops, 2);
    assert.equal(fsDelta.ledger.bytes, 16);
    assert.equal(fsDelta.ledger.readOps, 1);
    assert.equal(fsDelta.ledger.readBytes, 8);
    assert.deepEqual(fsDelta.ledgerSql, emptyLedgerSqlCounters());

    // fs.watch disable leaves an inert watcher.
    const hints = installInstrumentation({ disableWatch: true });
    try {
      const watcher = fs.watch(os.tmpdir());
      assert.equal(typeof watcher.close, 'function');
      watcher.close();
    } finally { hints.uninstall(); }
  } finally {
    instrumentation.uninstall();
    fs.rmSync(dbFile, { force: true });
    fs.rmSync(ledgerRoot, { recursive: true, force: true });
  }
  console.log('benchmark self-test ok');
}

if (process.argv[2] === '--worker') {
  const runtime = await loadRuntime();
  await runWorker(runtime);
} else if (flag('--self-test')) {
  await selfTest();
} else {
  await runParent();
}
