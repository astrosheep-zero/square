import fs from 'node:fs';
import path from 'node:path';

import type { DirectedNotificationRoute } from './delivery.js';

export interface NotificationFailure {
  actIndex: number;
  recipient?: string;
  route?: DirectedNotificationRoute;
  sink: string;
  message: string;
  at: number;
  diagnostic?: unknown;
}

type FailureInput = Omit<NotificationFailure, 'at'>;

const MAX_BYTES = 1_000_000;

export function notificationFailuresPath(squarePath: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.SQUARE_NOTIFICATION_FAILURES ?? path.join(path.dirname(squarePath), 'notification-failures.ndjsonl');
}

function redact(value: unknown, secret = process.env.PASEO_PASSWORD): unknown {
  if (typeof value === 'string') return secret ? value.split(secret).join('[redacted]') : value;
  if (Array.isArray(value)) return value.map((item) => redact(item, secret));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secret)]));
  }
  return value;
}

function parseRows(file: string): NotificationFailure[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => {
      if (line.trim() === '') return [];
      try {
        const row = JSON.parse(line) as Partial<NotificationFailure> & { v?: number; op?: string };
        return row.v === 1 && row.op === 'failed' && typeof row.actIndex === 'number' && typeof row.sink === 'string' && typeof row.message === 'string' && typeof row.at === 'number'
          ? [{ actIndex: row.actIndex, recipient: row.recipient, route: row.route, sink: row.sink, message: row.message, at: row.at, ...(row.diagnostic === undefined ? {} : { diagnostic: row.diagnostic }) }]
          : [];
      } catch { return []; }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function readNotificationFailures(squarePath: string, env: NodeJS.ProcessEnv = process.env): NotificationFailure[] {
  return parseRows(notificationFailuresPath(squarePath, env));
}

/** Append diagnosable delivery failures without ever persisting Paseo credentials. */
export function recordNotificationFailure(
  squarePath: string,
  input: FailureInput,
  at = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  const file = notificationFailuresPath(squarePath, env);
  const safe = redact({ ...input, at }, env.PASEO_PASSWORD) as FailureInput & { at: number };
  const row = { v: 1, op: 'failed', ...safe };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(row)}\n`;
  if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(text) > MAX_BYTES) {
    const retained = parseRows(file).slice(-500);
    fs.writeFileSync(file, retained.map((item) => JSON.stringify({ v: 1, op: 'failed', ...item })).join('\n') + (retained.length ? '\n' : ''), { mode: 0o600 });
  }
  fs.appendFileSync(file, text, { mode: 0o600 });
}
