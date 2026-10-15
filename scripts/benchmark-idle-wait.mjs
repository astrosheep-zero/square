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
  return { prepared: 0, statements, writes: 0, rows: 0, headRows: 0, hydratedRows: 0, hydratedBytes: 0 };
}

function emptyCounters() {
  return { sql: emptySqlCounters(), busy: 0, commits: { attempts: 0, busy: 0, ms: 0 }, ledger: { ops: 0, bytes: 0 }, watch: 0 };
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

  const recordRow = (bucket, row) => {
    if (row === undefined || row === null) return;
    counters.sql.rows++;
    if (bucket === 'hydrated') {
      counters.sql.hydratedRows++;
      for (const value of Object.values(row)) {
        if (typeof value === 'string') counters.sql.hydratedBytes += Buffer.byteLength(value, 'utf8');
      }
    } else if (bucket === 'heads') {
      counters.sql.headRows++;
    }
  };
  const guard = (fn) => function (...args) {
    try { return fn.apply(this, args); }
    catch (error) { if (isBusyError(error)) counters.busy++; throw error; }
  };

  DatabaseSync.prototype.prepare = function (sql, ...args) {
    const statement = originals.prepare.call(this, sql, ...args);
    const bucket = classifySql(sql);
    bucketOfStatement.set(statement, bucket);
    counters.sql.prepared++;
    counters.sql.statements[bucket]++;
    if (isMutatingSql(sql)) counters.sql.writes++;
    return statement;
  };
  DatabaseSync.prototype.exec = function (sql, ...args) {
    const bucket = classifySql(sql);
    counters.sql.statements[bucket]++;
    if (isMutatingSql(sql)) counters.sql.writes++;
    const commit = /^\s*COMMIT\s*;?\s*$/i.test(sql);
    const started = performance.now();
    if (commit) counters.commits.attempts++;
    try { return originals.exec.call(this, sql, ...args); }
    catch (error) {
      if (isBusyError(error)) { counters.busy++; if (commit) counters.commits.busy++; }
      throw error;
    } finally { if (commit) counters.commits.ms += performance.now() - started; }
  };
  StatementSync.prototype.all = guard(function (...args) {
    const rows = originals.all.apply(this, args);
    const bucket = bucketOfStatement.get(this) ?? 'other';
    for (const row of rows) recordRow(bucket, row);
    return rows;
  });
  StatementSync.prototype.get = guard(function (...args) {
    const row = originals.get.apply(this, args);
    recordRow(bucketOfStatement.get(this) ?? 'other', row);
    return row;
  });
  StatementSync.prototype.run = guard(function (...args) { return originals.run.apply(this, args); });
  StatementSync.prototype.iterate = function (...args) {
    const bucket = bucketOfStatement.get(this) ?? 'other';
    const inner = originals.iterate.apply(this, args);
    return (function* () { for (const row of inner) { recordRow(bucket, row); yield row; } })();
  };

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
        counters.ledger.bytes += typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : (value?.length ?? 0);
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
  for (const bucket of SQL_BUCKETS) out.sql.statements[bucket] = after.sql.statements[bucket] - before.sql.statements[bucket];
  out.sql.writes = after.sql.writes - before.sql.writes;
  out.sql.rows = after.sql.rows - before.sql.rows;
  out.sql.headRows = after.sql.headRows - before.sql.headRows;
  out.sql.hydratedRows = after.sql.hydratedRows - before.sql.hydratedRows;
  out.sql.hydratedBytes = after.sql.hydratedBytes - before.sql.hydratedBytes;
  out.busy = after.busy - before.busy;
  for (const field of ['attempts', 'busy', 'ms']) out.commits[field] = after.commits[field] - before.commits[field];
  out.ledger.ops = after.ledger.ops - before.ledger.ops;
  out.ledger.bytes = after.ledger.bytes - before.ledger.bytes;
  out.watch = after.watch - before.watch;
  return out;
}

function percentile(values, fraction) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
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
      const square = await runtime.Square.at({ path: file, env });
      try {
        const participant = await square.recognize(env);
        if (participant === null) failure = 'recognize returned no participant';
        else {
          first = await participant.catch({ limit: 10 });
          second = await participant.catch({ limit: 10 });
        }
      } catch (error) {
        failure = error.message;
      } finally {
        await square.close();
      }
      process.send({
        phase: 'catch',
        failure,
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
    const controls = {
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
    assert.ok(ledgerSetupOps >= workerCount, `positive control: ledger instrumentation must observe presence writes (saw ${ledgerSetupOps})`);

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
      ...(result.catches === undefined ? {} : { catch: result.catches[index], catchDelta: catchDelta[index] }),
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
        },
        catch: result.catches === undefined ? null : {
          caughtPerWorker: { min: Math.min(...result.catches.map((item) => item.caught)), max: Math.max(...result.catches.map((item) => item.caught)) },
          reconsumeTotal: sum(result.catches, (item) => item.reconsume),
          cpuMsTotal: sum(result.catches, (item) => item.cpuMs),
          wallMs: { p50: percentile(result.catches.map((item) => item.wallMs), 0.5), p95: percentile(result.catches.map((item) => item.wallMs), 0.95), max: Math.max(...result.catches.map((item) => item.wallMs)) },
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
        },
      },
      sql: { ...finalCounters.sql, busy: finalCounters.busy },
      ledger: finalCounters.ledger,
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
      return [name, {
        reportedWorkers: actual.length,
        discoveredWorkers: actual.filter((report) => report.discovered > 0).length,
        caught: actual.reduce((sum, report) => sum + (report.caught ?? 0), 0),
        reconsume: actual.reduce((sum, report) => sum + (report.reconsume ?? 0), 0),
        cpuMs: actual.reduce((sum, report) => sum + (report.cpuMs ?? 0), 0),
        cumulativeHydratedRows: actual.reduce((sum, report) => sum + (report.counters?.sql.hydratedRows ?? 0), 0),
        cumulativeHydratedBytes: actual.reduce((sum, report) => sum + (report.counters?.sql.hydratedBytes ?? 0), 0),
        cumulativeBusy: actual.reduce((sum, report) => sum + (report.counters?.busy ?? 0), 0),
        failures: actual.flatMap((report) => report.failure === undefined ? [] : [report.failure]),
      }];
    }));
    console.error(JSON.stringify({ failed: true, error: error.message, workerCount, history, phase, readyCount, received }, null, 2));
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
  const instrumentation = installInstrumentation({});
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
    db.close();

    // Busy positive control: a held write lock must be observed, not silently dropped.
    const holder = new DatabaseSync(dbFile);
    holder.exec('BEGIN IMMEDIATE');
    const contender = new DatabaseSync(dbFile);
    contender.exec('PRAGMA busy_timeout=0');
    const busyBefore = instrumentation.counters.busy;
    let busyThrown = false;
    try { contender.prepare('INSERT INTO activities (act_index, payload_json) VALUES (?, ?)').run(1, '{}'); }
    catch { busyThrown = true; }
    assert.ok(busyThrown, 'self-test control: contended write must throw');
    assert.ok(instrumentation.counters.busy > busyBefore, 'self-test control: busy counter must move');
    holder.exec('ROLLBACK');
    holder.close();
    contender.close();

    // Ledger counters.
    const ledgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'square-benchmark-ledger-'));
    const ledger = installInstrumentation({ ledgerRoot });
    try {
      await fs.promises.writeFile(path.join(ledgerRoot, 'presence.ndjsonl'), '{"v":1}\n');
      await fs.promises.readFile(path.join(ledgerRoot, 'presence.ndjsonl'), 'utf8');
      assert.ok(ledger.counters.ledger.ops >= 2, `self-test control: ledger ops counted (saw ${ledger.counters.ledger.ops})`);
      assert.ok(ledger.counters.ledger.bytes > 0, 'self-test control: ledger bytes counted');
    } finally { ledger.uninstall(); fs.rmSync(ledgerRoot, { recursive: true, force: true }); }

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
