import fs from 'node:fs';
import path from 'node:path';

/** Filesystem notifications are hints, never proof of a committed change. */
const RECONCILE_MS = 2_000;

export async function canonicalFilePath(value: string): Promise<string> {
  let current = path.resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(await fs.promises.realpath(current), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return path.resolve(value);
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(value);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

/** A local edge counter: register first, inspect state, then wait from that counter. */
class Edges {
  version = 0;
  private readonly listeners = new Set<() => void>();
  emit(): void { this.version += 1; for (const listener of [...this.listeners]) listener(); }
  wait(since: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Wait aborted'));
    if (this.version !== since) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { if (timer !== undefined) clearTimeout(timer); this.listeners.delete(changed); signal?.removeEventListener('abort', aborted); };
      const changed = () => { cleanup(); resolve(true); };
      const aborted = () => { cleanup(); reject(signal?.reason ?? new Error('Wait aborted')); };
      this.listeners.add(changed);
      signal?.addEventListener('abort', aborted, { once: true });
      if (Number.isFinite(timeoutMs)) timer = setTimeout(() => { cleanup(); resolve(false); }, Math.min(timeoutMs, 2_147_483_647));
      if (signal?.aborted) aborted();
      else if (this.version !== since) changed();
    });
  }
}

interface DirectoryWatch {
  readonly targets: Map<string, Set<Edges>>;
  watcher?: fs.FSWatcher;
  identity?: string;
  timer?: ReturnType<typeof setInterval>;
}
const directories = new Map<string, DirectoryWatch>();

function attachDirectory(directory: string, entry: DirectoryWatch): void {
  try {
    const stat = fs.statSync(directory);
    const identity = stat.dev + ':' + stat.ino;
    if (entry.watcher !== undefined && entry.identity === identity) return;
    entry.watcher?.close();
    entry.watcher = undefined;
    entry.identity = identity;
    const watcher = fs.watch(directory, (_event, filename) => {
      const name = filename?.toString();
      for (const [target, edges] of entry.targets) {
        if (name === undefined || name === target || name === target + '-journal' || name === target + '-wal') {
          for (const edge of edges) edge.emit();
        }
      }
    });
    entry.watcher = watcher;
    watcher.on('error', () => {
      if (entry.watcher !== watcher) return;
      watcher.close();
      entry.watcher = undefined;
      for (const edges of entry.targets.values()) for (const edge of edges) edge.emit();
    });
  } catch {
    entry.watcher?.close();
    entry.watcher = undefined;
    // Missing paths, resource limits, and unsupported filesystems use reconciliation.
  }
}

function subscribeHints(file: string): { edges: Edges; close(): void } {
  const directory = path.dirname(file);
  const name = path.basename(file);
  let entry = directories.get(directory);
  if (entry === undefined) {
    entry = { targets: new Map() };
    directories.set(directory, entry);
    const owned = entry;
    entry.timer = setInterval(() => {
      attachDirectory(directory, owned);
      for (const edges of owned.targets.values()) for (const edge of edges) edge.emit();
    }, RECONCILE_MS);
  }
  const edges = new Edges();
  const targets = entry.targets.get(name) ?? new Set<Edges>();
  targets.add(edges);
  entry.targets.set(name, targets);
  attachDirectory(directory, entry);
  let closed = false;
  return { edges, close() {
    if (closed) return;
    closed = true;
    targets.delete(edges);
    if (targets.size === 0) entry!.targets.delete(name);
    if (entry!.targets.size === 0) {
      entry!.watcher?.close();
      clearInterval(entry!.timer);
      directories.delete(directory);
    }
  } };
}

/** Await a shared read without allowing one subscriber to cancel other subscribers. */
async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new Error('Wait aborted');
  if (signal === undefined) return promise;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new Error('Wait aborted'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort !== undefined) signal.removeEventListener('abort', abort); }
}

interface SharedVersion<T> {
  refs: number;
  hints: ReturnType<typeof subscribeHints>;
  controller: AbortController;
  cached?: { generation: number; value: T };
  pending?: Promise<T>;
}
const versions = new Map<string, SharedVersion<unknown>>();

export interface VersionObserver<T> {
  readonly generation: number;
  hinted(since: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  read(signal?: AbortSignal): Promise<T>;
  changed(since: T, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  close(): void;
}

/** Shared only within this process. Durable state is always read at the storage boundary. */
export async function observeFileVersion<T>(
  filePath: string,
  kind: string,
  read: (file: string, signal: AbortSignal) => Promise<T>,
): Promise<VersionObserver<T>> {
  const file = await canonicalFilePath(filePath);
  const key = kind + '\0' + file;
  let shared = versions.get(key) as SharedVersion<T> | undefined;
  if (shared === undefined) {
    shared = { refs: 0, hints: subscribeHints(file), controller: new AbortController() };
    versions.set(key, shared as SharedVersion<unknown>);
  }
  shared.refs += 1;
  const entry = shared;
  const local = new AbortController();
  const readVersion = async (signal?: AbortSignal): Promise<T> => {
    const opSignal = signal === undefined ? local.signal : AbortSignal.any([local.signal, signal]);
    if (opSignal.aborted) throw opSignal.reason;
    const generation = entry.hints.edges.version;
    if (entry.cached?.generation === generation) return entry.cached.value;
    if (entry.pending === undefined) {
      entry.pending = read(file, entry.controller.signal).then((value) => {
        entry.cached = { generation, value };
        return value;
      }).finally(() => { entry.pending = undefined; });
    }
    return abortable(entry.pending, opSignal);
  };
  return {
    get generation() { return entry.hints.edges.version; },
    hinted(since, timeoutMs, signal) {
      return entry.hints.edges.wait(since, timeoutMs, signal === undefined ? local.signal : AbortSignal.any([local.signal, signal]));
    },
    read: readVersion,
    async changed(since, timeoutMs, signal) {
      const timeout = new AbortController();
      const timer = Number.isFinite(timeoutMs) ? setTimeout(() => timeout.abort(), Math.min(Math.max(1, timeoutMs), 2_147_483_647)) : undefined;
      const deadline = Date.now() + Math.max(0, timeoutMs);
      const opSignal = AbortSignal.any([local.signal, timeout.signal, ...(signal === undefined ? [] : [signal])]);
      try {
        for (;;) {
          const edge = entry.hints.edges.version;
          if (!Object.is(await readVersion(opSignal), since)) return true;
          const remaining = deadline - Date.now();
          if (remaining <= 0) return false;
          // Another subscriber's in-flight read may predate the edge captured above.
          if (entry.cached?.generation !== entry.hints.edges.version) continue;
          if (!await entry.hints.edges.wait(edge, remaining, opSignal)) return false;
        }
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        if (local.signal.aborted || timeout.signal.aborted) return false;
        throw error;
      } finally { if (timer !== undefined) clearTimeout(timer); }
    },
    close() {
      if (local.signal.aborted) return;
      local.abort(new Error('Change subscription closed'));
      if (--entry.refs === 0) {
        entry.controller.abort(new Error('Change monitor closed'));
        entry.hints.close();
        versions.delete(key);
      }
    },
  };
}

/** File metadata invalidates a ledger projection; it is not presentation evidence. */
export function observeFileMetadata(file: string): Promise<VersionObserver<string>> {
  return observeFileVersion(file, 'metadata', async (target) => {
    try {
      const stat = await fs.promises.stat(target, { bigint: true });
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  });
}
