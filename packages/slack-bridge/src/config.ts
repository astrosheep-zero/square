import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { harnessOwner, requireOwner } from '@astrosheep/square';
import { isParticipantName } from './names.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface BridgeSettings {
  readonly owner: string;
  readonly square: string;
  readonly channel: string;
  readonly state: string;
  readonly bridge: { readonly appToken: string; readonly botToken: string };
  /** Persona participant name → its bot token. */
  readonly personas: ReadonlyMap<string, string>;
}

const TOP_LEVEL = new Set(['square', 'channel', 'state', 'owner', 'bridge', 'personas']);
const BRIDGE_FIELDS = new Set(['appTokenEnv', 'botTokenEnv']);
const PERSONA_FIELDS = new Set(['botTokenEnv']);

/**
 * Read the JSON configuration and resolve its paths and secret environment
 * variables. Every failure names the field or variable, never a token value.
 */
export async function loadConfig(file: string, env: NodeJS.ProcessEnv = process.env): Promise<BridgeSettings> {
  const location = resolve(file);
  let source: string;
  try {
    source = await readFile(location, 'utf8');
  }
  catch (error) {
    throw new ConfigError(`cannot read config file ${location}: ${describe(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  }
  catch {
    throw new ConfigError(`config file ${location} is not valid JSON`);
  }
  const config = fields(parsed, 'config');
  only(config, TOP_LEVEL, 'config');
  const base = dirname(location);
  const square = resolve(base, text(config.square, 'square'));
  const channel = text(config.channel, 'channel');
  if (!/^[A-Z0-9]{2,}$/.test(channel)) throw new ConfigError('channel must be a Slack channel ID such as C0123456789');
  const state = config.state === undefined ? `${square}.slack-bridge.json` : resolve(base, text(config.state, 'state'));
  const owner = config.owner ?? harnessOwner({ channel: 'slack-bridge', session: state, agent: channel });
  try { requireOwner(owner as string); }
  catch { throw new ConfigError('owner must be a non-empty identifier without control characters, at most 512 UTF-8 bytes'); }
  const bridge = fields(config.bridge, 'bridge');
  only(bridge, BRIDGE_FIELDS, 'bridge');
  const appTokenEnv = text(bridge.appTokenEnv, 'bridge.appTokenEnv');
  const botTokenEnv = text(bridge.botTokenEnv, 'bridge.botTokenEnv');
  const personas = new Map<string, string>();
  if (config.personas !== undefined) {
    for (const [name, value] of Object.entries(fields(config.personas, 'personas'))) {
      if (!isParticipantName(name)) throw new ConfigError(`personas.${name} is not a valid participant name`);
      if (name.split('/')[0]!.toLocaleLowerCase() === 'slack') throw new ConfigError(`personas.${name} cannot use the reserved slack/ participant prefix`);
      const persona = fields(value, `personas.${name}`);
      only(persona, PERSONA_FIELDS, `personas.${name}`);
      const variable = text(persona.botTokenEnv, `personas.${name}.botTokenEnv`);
      personas.set(name, secret(env, variable, `personas.${name}`));
    }
  }
  if (!(await stat(square).catch(() => undefined))?.isFile()) throw new ConfigError(`square does not exist: ${square}`);
  return {
    square, channel, state, owner: owner as string,
    bridge: { appToken: secret(env, appTokenEnv, 'bridge'), botToken: secret(env, botTokenEnv, 'bridge') },
    personas,
  };
}

function fields(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ConfigError(`${where} must be a JSON object`);
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new ConfigError(`${where} has unknown field "${key}"`);
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ConfigError(`${where} must be a non-empty string`);
  return value.trim();
}

function secret(env: NodeJS.ProcessEnv, variable: string, where: string): string {
  const value = env[variable];
  if (typeof value !== 'string' || value === '') throw new ConfigError(`${where} names environment variable ${variable}, which is not set`);
  return value;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
