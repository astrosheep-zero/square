import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { DaemonClient, type WebSocketFactory } from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';

const DEFAULT_HOST = 'localhost:6767';
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

export type PaseoDaemonTarget =
  | { type: 'tcp'; url: string; password?: string }
  | { type: 'ipc'; url: string; socketPath: string; password?: string };

function paseoHome(env: NodeJS.ProcessEnv): string {
  return env.PASEO_HOME?.trim() || path.join(homedir(), '.paseo');
}

function expandHome(value: string): string {
  return value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
}

function normalizeHost(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const value = raw.trim();
  if (value.startsWith('unix://') || value.startsWith('pipe://') || value.startsWith('tcp://')) return value;
  if (value.startsWith('\\\\.\\pipe\\')) return `pipe://${value}`;
  if (value.startsWith('/') || value.startsWith('~/')) return `unix://${expandHome(value)}`;
  if (/^\d+$/.test(value)) return `127.0.0.1:${value}`;
  return value.includes(':') ? value : undefined;
}

function configuredHost(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(paseoHome(env), 'config.json'), 'utf8')) as {
      daemon?: { listen?: unknown };
      listen?: unknown;
    };
    return normalizeHost(config.daemon?.listen ?? config.listen);
  } catch {
    return undefined;
  }
}

function pidHost(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const pid = JSON.parse(fs.readFileSync(path.join(paseoHome(env), 'paseo.pid'), 'utf8')) as {
      listen?: unknown;
      sockPath?: unknown;
    };
    return normalizeHost(pid.listen ?? pid.sockPath);
  } catch {
    return undefined;
  }
}

function isIpc(host: string | undefined): host is string {
  return host !== undefined && (host.startsWith('unix://') || host.startsWith('pipe://'));
}

function supportsIpcHost(host: string): boolean {
  return process.platform !== 'win32' || !host.startsWith('unix://');
}

/** Match the host precedence used by the Paseo CLI for local daemon connections. */
export function paseoDaemonHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = normalizeHost(env.PASEO_HOST);
  if (explicit !== undefined) return [explicit];

  const candidates: string[] = [];
  const listen = normalizeHost(env.PASEO_LISTEN);
  const pid = pidHost(env);
  const configured = configuredHost(env);
  if (isIpc(listen) && supportsIpcHost(listen)) candidates.push(listen);
  if (isIpc(pid) && supportsIpcHost(pid)) candidates.push(pid);
  if (isIpc(configured) && supportsIpcHost(configured)) candidates.push(configured);
  if (configured !== undefined && !isIpc(configured) && configured !== '127.0.0.1:6767') candidates.push(configured);
  candidates.push(DEFAULT_HOST);
  return [...new Set(candidates)];
}

function uriPassword(uri: URL): string | undefined {
  const value = uri.searchParams.get('password');
  return value === null || value === '' ? undefined : value;
}

export function resolvePaseoDaemonTarget(host: string, env: NodeJS.ProcessEnv = process.env): PaseoDaemonTarget {
  const passwordFromEnv = env.PASEO_PASSWORD?.trim() || undefined;
  if (host.startsWith('unix://') || host.startsWith('pipe://')) {
    if (process.platform === 'win32' && host.startsWith('unix://')) {
      throw new Error('Paseo Unix socket targets are unsupported on Windows; use pipe:// or tcp://.');
    }
    const prefix = host.startsWith('unix://') ? 'unix://' : 'pipe://';
    const socketPath = expandHome(host.slice(prefix.length).trim());
    if (socketPath === '') throw new Error('Invalid Paseo IPC target: missing socket path.');
    return {
      type: 'ipc',
      url: host.startsWith('unix://') ? `ws+unix://${socketPath}:/ws` : 'ws://localhost/ws',
      socketPath,
      ...(passwordFromEnv === undefined ? {} : { password: passwordFromEnv }),
    };
  }

  if (host.startsWith('tcp://')) {
    const uri = new URL(host);
    const hostname = uri.hostname.replace(/^\[|\]$/g, '');
    const endpoint = `${hostname.includes(':') ? `[${hostname}]` : hostname}:${uri.port || '6767'}`;
    const secure = uri.searchParams.get('ssl') === 'true';
    const password = uriPassword(uri) ?? passwordFromEnv;
    return {
      type: 'tcp',
      url: `${secure ? 'wss' : 'ws'}://${endpoint}/ws`,
      ...(password === undefined ? {} : { password }),
    };
  }

  return {
    type: 'tcp',
    url: `ws://${host.replace(/\/$/, '')}/ws`,
    ...(passwordFromEnv === undefined ? {} : { password: passwordFromEnv }),
  };
}

function webSocketFactory(target: PaseoDaemonTarget): WebSocketFactory {
  return (url, options) => new WebSocket(url, options?.protocols, {
    headers: options?.headers,
    ...(target.type === 'ipc' ? { socketPath: target.socketPath } : {}),
  }) as unknown as ReturnType<WebSocketFactory>;
}

export async function connectPaseoDaemon(
  env: NodeJS.ProcessEnv = process.env,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS
): Promise<DaemonClient> {
  let lastError: unknown;
  for (const host of paseoDaemonHosts(env)) {
    const target = resolvePaseoDaemonTarget(host, env);
    const client = new DaemonClient({
      url: target.url,
      clientId: `square-${process.pid}-${Date.now()}`,
      clientType: 'cli',
      appVersion: 'square',
      password: target.password,
      connectTimeoutMs,
      webSocketFactory: webSocketFactory(target),
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.close().catch(() => {});
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Unable to connect to the Paseo daemon.');
}
