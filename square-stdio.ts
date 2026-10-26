import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { SquareError, type SquareErrorCode, type SquareErrorFacts } from './model.js';
import { harnessSessionSources } from './participant-identity.js';
import type { SquareBackends, SquareBackend } from './square-backend.js';
import type { ParsedSquareLocation } from './square-location.js';
import type { Participant, OperationControl, OperationFailureDetail, SquareAtInput, SquareBuildInput } from './square-facade.js';
import { requireJoinName } from './seats.js';

export const STDIO_PROTOCOL_VERSION = 1;
export const STDIO_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const identityVariables = [...harnessSessionSources.flatMap(source => [source.variable, ...(source.childVariable ? [source.childVariable] : [])])];
export function wireIdentity(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(identityVariables.map(key => [key, env[key] ?? '']));
}

export interface WireError {
  readonly code: number;
  readonly message: string;
  readonly data?: { readonly code?: SquareErrorCode; readonly facts?: SquareErrorFacts; readonly operation?: OperationFailureDetail };
}
export function encodeError(error: unknown): WireError {
  const e = error as Error & { code?: SquareErrorCode; facts?: SquareErrorFacts; operation?: OperationFailureDetail };
  return { code: -32000, message: e.message ?? 'Backend request failed', data: { code: e.code, facts: e.facts, operation: e.operation } };
}
function decodeError(error: WireError): Error {
  return Object.assign(error.data?.code ? new SquareError(error.data.code, error.message, error.data.facts) : new Error(error.message),
    error.data?.operation ? { operation: error.data.operation } : {});
}
export function unsupported(feature: string): never {
  throw new SquareError('invalid_args', `The stdio backend does not support ${feature}; use explicit catch/history or a local resource`);
}

/** One process per opened Square. No replay, pooling, or operation policy. */
class Connection {
  private nextId = 0;
  private closed = false;
  private closing?: Promise<void>;
  private pending = new Map<number, { resolve(value: any): void; reject(error: unknown): void; control?: OperationControl; dispose(): void; method: string }>();
  readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  constructor(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(command, [...args], { cwd, env, shell: false, stdio: 'pipe' });
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
    // Diagnostic bytes are deliberately not included in errors (they can contain credentials).
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    let frameBytes = 0;
    this.child.stdout.on('data', chunk => {
      for (const byte of chunk) {
        if (byte === 10) frameBytes = 0;
        else if (++frameBytes > STDIO_MAX_FRAME_BYTES) { this.fail('Backend frame exceeds the protocol limit'); break; }
      }
    });
    lines.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.jsonrpc !== '2.0') throw new Error();
        if (message.method === 'square/progress') {
          const pending = this.pending.get(message.params?.id);
          if (pending && message.params?.progress) {
            try { pending.control?.onProgress?.(message.params.progress); } catch { /* progress observers cannot corrupt framing */ }
          }
          return;
        }
        if (!Number.isSafeInteger(message.id) || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) throw new Error();
        const pending = this.pending.get(message.id);
        if (!pending) throw new Error();
        this.pending.delete(message.id); pending.dispose();
        if (message.error) pending.reject(decodeError(message.error));
        else pending.resolve(message.result);
      } catch { this.fail('Malformed backend protocol response'); }
    });
    lines.once('close', () => this.fail('Backend stdout ended'));
    this.child.once('error', () => this.fail('Cannot start configured backend; check command and cwd'));
    this.child.once('exit', () => this.fail('Backend process exited'));
    this.child.stdin.on('error', () => this.fail('Backend stdin closed'));
  }
  private fail(message: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.dispose();
      const error = new SquareError('unavailable', message);
      if (pending.method === 'express') Object.assign(error, { operation: { operation: 'express', expressEffect: 'unknown' } });
      pending.reject(error);
    }
    this.pending.clear();
    this.child.stdin.destroy();
    this.child.kill();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 500); timer.unref();
    void this.exited.then(() => clearTimeout(timer));
  }
  request(method: string, params: Record<string, unknown>, control?: OperationControl): Promise<any> {
    if (control?.signal?.aborted) return Promise.reject(control.signal.reason ?? new Error('Operation cancelled'));
    if (this.closed) return Promise.reject(new SquareError('unavailable', 'Backend connection is closed'));
    const id = ++this.nextId;
    let frame: string;
    try {
      frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }, (_key, value) => {
        if (typeof value === 'number' && !Number.isFinite(value))
          throw new Error('Non-finite number');
        return value;
      }) + '\n';
      if (Buffer.byteLength(frame) > STDIO_MAX_FRAME_BYTES)
        throw new Error('Frame too large');
    } catch {
      const error = new SquareError('invalid_args', 'Backend request must be JSON-serializable with finite numbers and fit the protocol frame limit');
      if (method === 'express') Object.assign(error, { operation: { operation: 'express', expressEffect: 'unsent' } });
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        // Wait for the response: server cleanup (including catch lease release) must finish first.
        if (!this.closed) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }) + '\n');
      };
      this.pending.set(id, { resolve, reject, method, control, dispose: () => control?.signal?.removeEventListener('abort', abort) });
      control?.signal?.addEventListener('abort', abort, { once: true });
      this.child.stdin.write(frame);
    });
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      const timer = setTimeout(() => this.fail('Backend close timed out'), 1000);
      try {
        if (!this.closed) await this.request('square/close', {});
      } catch { /* disconnect already rejects outstanding work */ }
      finally {
        clearTimeout(timer);
        this.fail('Backend connection closed');
        await this.exited;
      }
    })();
  }
}

class StdioSquare implements SquareBackend {
  constructor(readonly location: string, private readonly connection: Connection, private readonly handle: string) {}
  private call(method: string, args: readonly unknown[], control?: OperationControl, participant?: string): Promise<any> {
    return this.connection.request(method, { handle: this.handle, args, ...(participant === undefined ? {} : { participant }) }, control);
  }
  private participantHandle(name: string): Participant {
    return {
      name,
      express: (body, options, control) => this.call('express', [body, options], control, name),
      catch: (options, control) => this.call('catch', [options], control, name),
      listen: (target, options, control) => this.call('listen', [target, options], control, name),
      ignore: (target, options, control) => this.call('ignore', [target, options], control, name),
      unlisten: (target, options, control) => this.call('unlisten', [target, options], control, name),
      listening: (options, control) => this.call('listening', [options], control, name),
      hold: (reason, options, control) => this.call('hold', [reason, options], control, name),
      resume: (options, control) => this.call('resume', [options], control, name),
      done: (body, options, control) => this.call('done', [body, options], control, name),
      history: (query, control) => this.history(query, control),
    };
  }
  async participant(name?: string) { return this.participantHandle(await this.call('participant', [name])); }
  async join(...[name, options, control]: Parameters<SquareBackend['join']>): ReturnType<SquareBackend['join']> {
    requireJoinName(name);
    const result = await this.call('join', [name, options], control);
    return { ...result, participant: this.participantHandle(result.participant) };
  }
  history(...[query, control]: Parameters<SquareBackend['history']>): ReturnType<SquareBackend['history']> { return this.call('history', [query], control); }
  status(...[options, control]: Parameters<SquareBackend['status']>): ReturnType<SquareBackend['status']> { return this.call('status', [options], control); }
  participants(...[options, control]: Parameters<SquareBackend['participants']>): ReturnType<SquareBackend['participants']> { return this.call('participants', [options], control); }
  recovery(...[name, control]: Parameters<SquareBackend['recovery']>): ReturnType<SquareBackend['recovery']> { return this.call('recovery', [name], control); }
  snapshot(): ReturnType<SquareBackend['snapshot']> { return Promise.reject(new SquareError('invalid_args', 'stdio does not support function-valued snapshot; use status/participants/history')); }
  stream(): ReturnType<SquareBackend['stream']> { unsupported('stream'); }
  recognize(): ReturnType<SquareBackend['recognize']> { return Promise.reject(new SquareError('invalid_args', 'stdio does not support host recognition; select a participant explicitly')); }
  implicitJoin(): ReturnType<SquareBackend['implicitJoin']> { unsupported('host implicit join'); }
  endOwnedSession(): ReturnType<SquareBackend['endOwnedSession']> { unsupported('host session cleanup'); }
  cancelDeliveries(): ReturnType<SquareBackend['cancelDeliveries']> { unsupported('host delivery cancellation'); }
  close() { return this.connection.close(); }
}

export async function openStdioSquare(location: string, selected: Extract<ParsedSquareLocation, { kind: 'stdio' }>, input: SquareAtInput,
  backends: SquareBackends, build?: Pick<SquareBuildInput, 'markdown' | 'hardCap' | 'throttlePerMinute' | 'template' | 'force'>, control?: OperationControl): Promise<SquareBackend> {
  if (input.clock || input.wakeTransport) unsupported('client clock or wakeTransport injection');
  if (control?.signal?.aborted) throw control.signal.reason ?? new Error('Operation cancelled');
  const backend = Object.hasOwn(backends, selected.backend) ? backends[selected.backend] : undefined;
  if (!backend) throw new SquareError('invalid_args', `Backend ${selected.backend} is not configured; set backends or SQUARE_BACKENDS_CONFIG`);
  const cwd = input.cwd ?? process.cwd();
  const command = backend.command.includes('/') || backend.command.includes('\\') ? path.resolve(cwd, backend.command) : backend.command;
  const connection = new Connection(command, backend.args ?? [], path.resolve(cwd, backend.cwd ?? '.'), { ...(input.env ?? process.env), ...backend.env });
  try {
    const result = await connection.request('square/open', { version: STDIO_PROTOCOL_VERSION, key: selected.key, location,
      identity: wireIdentity(input.env ?? process.env), body: input.body, participant: input.participant, build }, control);
    if (result.version !== STDIO_PROTOCOL_VERSION || typeof result.handle !== 'string') throw new SquareError('unavailable', 'Backend protocol version mismatch');
    return new StdioSquare(location, connection, result.handle);
  } catch (error) { await connection.close(); throw error; }
}
