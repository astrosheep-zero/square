#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { SqliteSquare } from './sqlite-square.js';
import { SquareError } from './model.js';
import { canonicalPath } from './canonical-path.js';
import { STDIO_PROTOCOL_VERSION, STDIO_MAX_FRAME_BYTES, encodeError, identityVariables } from './square-stdio.js';
import { parseSquareLocation } from './square-location.js';
import type { OperationControl, SquareBuildInput } from './square-facade.js';

/** Serve the existing resource API. This adapter contains no activity policy. */
export async function runSquareStdioServer(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  root = await canonicalPath(root);
  const baseEnv = { ...process.env };
  let square: SqliteSquare | undefined;
  let location: string | undefined;
  let opening = false, closing = false;
  const running = new Map<number, { controller: AbortController; work: Promise<void> }>();
  const write = (message: unknown) => { if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(message) + '\n'); };
  const response = (id: number, result: unknown) => write({ jsonrpc: '2.0', id, result });
  const fail = (id: number, error: unknown) => write({ jsonrpc: '2.0', id, error: encodeError(error) });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> => shutdown ??= (async () => {
    closing = true;
    for (const request of running.values()) request.controller.abort();
    await Promise.allSettled([...running.values()].map(request => request.work));
    await square?.close();
    lines.close();
    process.stdin.pause();
  })();
  const fatal = () => { void close().finally(() => { process.exitCode = 1; }); };
  let frameBytes = 0;
  process.stdin.on('data', chunk => {
    for (const byte of Buffer.from(chunk)) {
      if (byte === 10) frameBytes = 0;
      else if (++frameBytes > STDIO_MAX_FRAME_BYTES) { fatal(); break; }
    }
  });
  process.stdout.on('error', fatal);
  process.once('SIGTERM', fatal);
  process.once('SIGINT', fatal);
  lines.on('close', () => { if (!closing) void close(); });

  async function invoke(method: string, params: any, control: OperationControl): Promise<unknown> {
    if (method === 'square/open') {
      if (square || opening) throw new SquareError('invalid_args', 'One logical open is allowed per connection');
      opening = true;
      try {
        if (params.version !== STDIO_PROTOCOL_VERSION) throw new SquareError('invalid_args', 'Unsupported Square stdio protocol version');
        const parsed = parseSquareLocation(params.location);
        if (parsed.kind !== 'stdio' || parsed.key !== params.key) throw new SquareError('invalid_args', 'Open requires a matching stdio location and key');
        const target = path.join(root, `${parsed.key}.square`);
        const canonical = await canonicalPath(target);
        if (path.dirname(canonical) !== root) throw new SquareError('invalid_args', 'Square key escapes the configured backend root');
        const env = { ...baseEnv };
        for (const key of identityVariables) {
          const value = params.identity?.[key];
          if (value !== undefined && typeof value !== 'string') throw new SquareError('invalid_args', 'Invalid operation identity');
          env[key] = value ?? '';
        }
        const input = { path: target, env, participant: params.participant };
        square = params.build === undefined ? await SqliteSquare.at(input, control, false)
          : await SqliteSquare.build({ ...params.build as SquareBuildInput, ...input }, control, false);
        location = parsed.uri;
        return { version: STDIO_PROTOCOL_VERSION, handle: 'square' };
      } finally { opening = false; }
    }
    if (!square || params.handle !== 'square') throw new SquareError('invalid_args', 'Open a logical square first');
    if (!Array.isArray(params.args)) throw new SquareError('invalid_args', 'Operation args must be an array');
    // JSON null represents omitted optional arguments, never the meaningful history limit:null inside an options object.
    const args = params.args.map((arg: unknown) => arg === null ? undefined : arg);
    let result: any;
    switch (method) {
      case 'participant': return (await square.participant(args[0])).name;
      case 'join': {
        const joined = await square.join(args[0], args[1], control);
        result = { ...joined, participant: joined.participant.name }; break;
      }
      case 'history': result = await square.history(args[0], control); break;
      case 'status': result = await square.status(args[0], control); break;
      case 'participants': result = await square.participants(args[0], control); break;
      case 'recovery': result = await square.recovery(args[0], control); break;
      default: {
        if (typeof params.participant !== 'string') throw new SquareError('invalid_args', 'Participant operation requires a name');
        const participant = await square.participant(params.participant);
        switch (method) {
          case 'express': result = await participant.express(args[0], args[1], control); break;
          case 'catch': result = await participant.catch(args[0], control); break;
          case 'listen': result = await participant.listen(args[0], args[1], control); break;
          case 'ignore': result = await participant.ignore(args[0], args[1], control); break;
          case 'unlisten': result = await participant.unlisten(args[0], args[1], control); break;
          case 'listening': result = await participant.listening(args[0], control); break;
          case 'hold': result = await participant.hold(args[0], args[1], control); break;
          case 'resume': result = await participant.resume(args[0], control); break;
          case 'done': result = await participant.done(args[0], args[1], control); break;
          default: throw new SquareError('invalid_args', 'Unsupported stdio operation');
        }
      }
    }
    if (result?.observation) result = { ...result, observation: { ...result.observation, location, automaticDeliveryAvailable: false } };
    return result;
  }

  lines.on('line', line => {
    if (closing) return;
    let message: any;
    try {
      message = JSON.parse(line);
      if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.params || typeof message.params !== 'object') throw new Error();
      if (message.method === '$/cancelRequest') { running.get(message.params.id)?.controller.abort(); return; }
      if (!Number.isSafeInteger(message.id) || running.has(message.id)) throw new Error();
    } catch { fatal(); return; }
    if (message.method === 'square/close') {
      void close().then(() => { response(message.id, null); process.stdout.end(); });
      return;
    }
    const controller = new AbortController();
    // Start on a microtask so the request is tracked before progress/cleanup can run.
    const work = Promise.resolve().then(() => invoke(message.method, message.params, {
      signal: controller.signal,
      onProgress: progress => write({ jsonrpc: '2.0', method: 'square/progress', params: { id: message.id, progress } }),
    })).then(result => response(message.id, result), error => fail(message.id, error)).finally(() => { running.delete(message.id); });
    running.set(message.id, { controller, work });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== '--root') {
    process.stderr.write('usage: node dist/stdio-server.js --root <backend-artifact-directory>\n');
    process.exitCode = 2;
  } else {
    await runSquareStdioServer(path.resolve(process.argv[3]));
  }
}
