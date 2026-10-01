// Run with --import ./test/sandbox-env.js. All data and identities are disposable.
// --workers 100 --mode events|poll200|session [--active]
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createSquareState, writeSquareFile, readSquareRevision } from '../dist/artifact.js';
import { createFileCell } from '../dist/square-storage.js';
import { observeSessionPending } from '../dist/inbox.js';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';

const script = fileURLToPath(import.meta.url);
const sandbox = fileURLToPath(new URL('../test/sandbox-env.js', import.meta.url));
const durationMs = process.argv.includes('--active') ? 20_000 : 5_000;
const option = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const workerCount = Number(option('--workers', '6'));
const mode = option('--mode', 'events');
const active = process.argv.includes('--active');
assert.ok(Number.isInteger(workerCount) && workerCount > 0 && workerCount <= 100);
assert.ok(['events', 'poll200', 'session'].includes(mode));

async function polling200(file, baseline) {
  const deadline = performance.now() + durationMs;
  do {
    if (await readSquareRevision(file) !== baseline) return true;
    await sleep(Math.min(200, Math.max(0, deadline - performance.now())));
  } while (performance.now() < deadline);
  return false;
}

if (process.argv[2] === '--worker') {
  const file = process.argv[3];
  const ledgerRoot = process.argv[4];
  const session = process.argv[5];
  const cell = createFileCell(file);
  let observer;
  const controller = new AbortController();
  let timer;
  try {
    const baseline = (await cell.read()).version;
    let polls = 0;
    let payloadReads = 0;
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql, ...args) {
      if (/\bFROM\s+square_snapshot\b/i.test(sql)) {
        polls++;
        if (/\bstate\b/i.test(sql)) payloadReads++;
      }
      return prepare.call(this, sql, ...args);
    };
    let pending;
    if (mode === 'session') {
      observer = await observeSessionPending(session, { SQUARE_HOST_LEDGER_ROOT: ledgerRoot });
      let armed;
      const ready = new Promise((resolve) => { armed = resolve; });
      pending = observer.wait(Infinity, { signal: controller.signal, onChangeArmed: armed });
      await ready;
    }
    const go = once(process, 'message');
    process.send({ ready: true });
    await go;
    polls = 0;
    payloadReads = 0;
    const cpuStart = process.cpuUsage();
    const started = performance.now();
    let changed;
    if (mode === 'session') {
      timer = setTimeout(() => controller.abort(), durationMs);
      changed = (await pending).length > 0;
    } else {
      changed = await (mode === 'poll200' ? polling200(file, baseline) : cell.changed(baseline, durationMs));
    }
    const observedAt = Date.now();
    const wallMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuStart);
    const cpuMs = (cpu.user + cpu.system) / 1_000;
    DatabaseSync.prototype.prepare = prepare;
    process.send({ changed, cpuMs, wallMs, cpuPercent: cpuMs / wallMs * 100, polls, payloadReads, ...(active ? { observedAt } : {}) });
  } finally {
    clearTimeout(timer);
    controller.abort();
    observer?.close();
    await cell.close();
    process.disconnect();
  }
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-idle-benchmark-'));
  const children = [];
  let trigger;
  let guard;
  try {
    const file = path.join(root, 'BENCHMARK.square');
    const ledgerRoot = path.join(root, 'ledger');
    const state = await createSquareState({ force: true, hardCap: null }, 'Synthetic idle benchmark');
    const participants = Array.from({ length: workerCount }, (_, i) => 'Reader' + i);
    const acts = mode === 'session' ? ['Bench', ...participants].map((actor, index) => ({ kind: 'join', actor, at: index, index })) : [];
    for (let index = 0; index < 1_800; index++) acts.push({ kind: 'say', actor: 'Bench', at: index, index: acts.length, body: 'x'.repeat(2_048) });
    state.acts = acts;
    state.runtime.nextActIndex = acts.length;
    await writeSquareFile(file, state);
    if (mode === 'session') {
      const ledger = createHostLedgerPort({ rootPath: ledgerRoot });
      for (let i = 0; i < workerCount; i++) await ledger.ensurePresence({ location: file, participant: participants[i], session: 'bench-' + i, channel: 'pi', updatedAt: Date.now() });
    }
    const ready = [];
    const results = [];
    let commitStartedAt;
    let commitFinishedAt;
    let commit;
    for (let i = 0; i < workerCount; i++) {
      const child = fork(script, ['--worker', file, ledgerRoot, 'bench-' + i, '--mode', mode, ...(active ? ['--active'] : [])], {
        execArgv: ['--import', sandbox], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      children.push(child);
      ready.push(new Promise((resolve, reject) => {
        child.on('message', (message) => { if (message.ready) resolve(); });
        child.once('error', reject);
        child.once('exit', () => reject(new Error('worker exited before ready')));
      }));
      results.push(new Promise((resolve, reject) => {
        let result;
        child.on('message', (message) => { if (!message.ready) result = message; });
        child.once('error', reject);
        child.once('exit', (code, signal) => code === 0 && result ? resolve(result) : reject(new Error('worker failed: ' + (code ?? signal))));
      }));
    }
    const completed = Promise.all(results);
    const finish = Promise.all([Promise.all(ready).then(() => {
      for (const child of children) child.send('go');
      if (active) trigger = setTimeout(() => {
        commit = (async () => {
          const writer = createFileCell(file);
          try {
            commitStartedAt = Date.now();
            await writer.transact((current) => {
              const index = current.runtime.nextActIndex++;
              current.acts.push({ kind: 'say', actor: 'Bench', at: Date.now(), index, body: 'benchmark wake', reach: 'bell' });
              return { state: current, result: undefined };
            });
            commitFinishedAt = Date.now();
          } finally { await writer.close(); }
        })();
        commit.catch(() => { for (const child of children) child.kill('SIGTERM'); });
      }, 250);
    }), completed]);
    const [, workers] = await Promise.race([finish, new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('benchmark timed out')), 90_000); })]);
    await commit;
    const latencies = active ? workers.map((worker) => Math.max(0, worker.observedAt - commitFinishedAt)).sort((a,b) => a-b) : [];
    console.log(JSON.stringify({ node: process.version, mode, active, workerCount, durationMs, activities: state.acts.length,
      stateBytes: Buffer.byteLength(JSON.stringify(state)), sessionSetupExcluded: mode === 'session',
      totalCpuMs: workers.reduce((sum, worker) => sum + worker.cpuMs, 0),
      meanWorkerCpuPercent: workers.reduce((sum, worker) => sum + worker.cpuPercent, 0) / workerCount,
      aggregateCpuPercentOneCore: workers.reduce((sum, worker) => sum + worker.cpuPercent, 0),
      totalPolls: workers.reduce((sum, worker) => sum + worker.polls, 0),
      totalPayloadReads: workers.reduce((sum, worker) => sum + worker.payloadReads, 0),
      unexpectedResults: workers.filter((worker) => worker.changed !== active).length,
      ...(active ? { commitMs: commitFinishedAt - commitStartedAt, detectionMs: { p50: latencies[Math.floor(latencies.length / 2)], p95: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * .95))], max: latencies.at(-1) } } : {}), workers,
    }, null, 2));
    assert.ok(workers.every((worker) => worker.changed === active), 'not all workers observed the expected state');
  } finally {
    clearTimeout(guard);
    clearTimeout(trigger);
    await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); return exited;
    }));
    await fs.rm(root, { recursive: true, force: true });
  }
}
