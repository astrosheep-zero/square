import os from 'node:os';
import { harnessOwner, localUserOwner, type Owner } from '../square-api.js';
import { harnessSessionSources } from '../participant-identity.js';
import { codexWakeAddress } from '../codex-address.js';

import { commandUsageHint } from '../help.js';
import { type HardCap, parseParticipantList, validateName } from '../model.js';
import { Square, squareClock } from '../square-api.js';
import type { OperationControl } from '../square-facade.js';

export interface CommandContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  squarePath?: string;
  name?: string;
  owner?: Owner;
  homeDir: string;
  command: string;
  json?: boolean;
}

export interface CommandSpec<Intent = unknown, Result = void> {
  parse(argv: string[], context: CommandContext): Intent;
  execute(intent: Intent, context: CommandContext): Promise<Result> | Result;
  present(result: Result, context: CommandContext): void;
}

export async function readStdin(): Promise<string> {
  try {
    let content = '';
    for await (const chunk of process.stdin.setEncoding('utf8')) content += chunk;
    return content;
  } catch {
    return '';
  }
}

export async function resolveBody(arg: string): Promise<string> {
  return arg === '-' ? readStdin() : arg;
}

export function fail(message: string, exitCode = 2): never {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

export function usage(command: string): never {
  process.stderr.write(`✕ invalid arguments${command === '' ? '' : ` for ${command}`}\n`);
  process.stderr.write(commandUsageHint(command || undefined));
  process.exit(2);
}

export function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) fail(`✕ missing value for ${flag}`);
  return value;
}

export function parseDurationMs(value: string, flag: string): number {
  const match = value.match(/^([1-9]\d*)(ms|s|m|h)$/);
  if (!match) fail(`✕ invalid ${flag}: expected a positive duration with unit ms, s, m, or h (for example 500ms, 30s, 3m, 1h)`);
  const amount = Number.parseInt(match[1], 10);
  const multiplier: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  const milliseconds = amount * multiplier[match[2]];
  if (!Number.isSafeInteger(milliseconds)) fail(`✕ invalid ${flag}: duration is too large`);
  return milliseconds;
}

export function parsePositiveInteger(value: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(value)) fail(`✕ invalid ${flag}: expected a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`✕ invalid ${flag}: value is too large`);
  return parsed;
}

export function parseBoundedLimit(value: string | undefined, flag: string, max: number, retry: string): number {
  if (value === undefined || value.startsWith('--') || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    fail(`✕ ${flag} needs a positive integer\n${retry}`);
  }
  const parsed = Number(value);
  if (parsed > max) fail(`✕ ${flag} is capped at ${max}\n${retry}`);
  return parsed;
}

export function parseNonNegativeInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) fail(`✕ invalid ${flag}: expected a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`✕ invalid ${flag}: value is too large`);
  return parsed;
}

export function parseHardCap(value: string): HardCap {
  if (value === 'unlimited') return null;
  if (!/^[1-9]\d*$/.test(value)) fail('✕ invalid build option: --cap must be a positive integer or unlimited');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail('✕ invalid build option: --cap must be a positive integer or unlimited');
  return parsed;
}

export function parseNameList(value: string, flag: string): string[] {
  const names = parseParticipantList(value);
  if (names.length === 0) fail(`✕ invalid ${flag}: expected at least one participant name`);
  for (const name of names) validateName(name);
  return names;
}

const LOCATION_REQUIRED_COMMANDS = new Set([
  'build',
  'stream',
  'join',
  'catch',
  'express',
  'listen',
  'ignore',
  'unlisten',
  'listening',
  'done',
  'hold',
  'resume',
  'history',
  'status',
  'participants',
  'doctor',
  'migrate',
]);

export interface ParsedGlobalArgs {
  squarePath?: string;
  explicitSquarePath: boolean;
  multipleSquares: boolean;
  name?: string;
  owner?: Owner;
  args: string[];
}

export async function parseGlobalArgs(rawArgs: string[]): Promise<ParsedGlobalArgs> {
  const args = [...rawArgs];
  let requestedPath: string | undefined;
  let name: string | undefined;
  let owner: Owner | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--location') {
      requestedPath = requireValue(args, index, args[index]);
      args.splice(index, 2);
      index -= 1;
    } else if (args[index] === '--owner') {
      owner = requireValue(args, index, args[index]);
      args.splice(index, 2);
      index -= 1;
    } else if (args[index] === '--as') {
      name = requireValue(args, index, args[index]);
      args.splice(index, 2);
      index -= 1;
    }
  }
  const command = args[0];
  if (name !== undefined) validateName(name);
  const explicitSquarePath = requestedPath !== undefined;
  const configuredLocation = process.env.SQUARE_LOCATION?.trim();
  const configured = configuredLocation === '' ? undefined : configuredLocation;
  if (command !== undefined && !['--help', '-h'].includes(command) && locationIsRequired(command) && requestedPath === undefined && configured === undefined) {
    fail(`✕ ${command} needs a square location\nsquare ls`);
  }
  const squarePath = requestedPath ?? configured;
  return { squarePath, explicitSquarePath: explicitSquarePath || configured !== undefined, multipleSquares: false, name, owner, args };
}

export function locationIsRequired(command: string): boolean {
  return LOCATION_REQUIRED_COMMANDS.has(command);
}

export function defaultContext(command: string, squarePath?: string, name?: string): CommandContext {
  return { command, cwd: process.cwd(), env: { ...process.env }, squarePath, name, owner: undefined, homeDir: os.homedir() };
}

export function squareInput(context: CommandContext) {
  return { cwd: context.cwd, env: context.env, path: context.squarePath };
}

export function commandIdentity(env: NodeJS.ProcessEnv, explicit?: Owner): { owner: Owner; wakeAddress?: import('../model.js').WakeAddress } {
  if (explicit !== undefined) return { owner: explicit };
  const configured = env.SQUARE_OWNER;
  if (configured !== undefined) return { owner: configured };
  const selected = harnessSessionSources.flatMap(({ variable, channel }) => env[variable]?.trim() ? [{ channel, session: env[variable]!.trim() }] : []);
  const native = selected.filter(source => source.channel !== 'paseo');
  if (env.CLAUDE_CODE_CHILD_SESSION === '1') throw new Error('Harness identity is incomplete; provide --owner explicitly.');
  if (native.length > 1) throw new Error('Multiple harness execution coordinates are present; select one explicit owner.');
  const paseo = selected.find(source => source.channel === 'paseo');
  const coordinate = native[0] ?? paseo;
  if (coordinate === undefined) return { owner: localUserOwner() };
  const owner = harnessOwner({ channel: coordinate.channel, session: coordinate.session });
  const wakeAddress = coordinate.channel === 'codex' ? codexWakeAddress(coordinate.session, env)
    : paseo === undefined ? undefined : { kind: 'paseo' as const, address: { agentId: paseo.session } };
  return { owner, ...(wakeAddress === undefined ? {} : { wakeAddress }) };
}

/** Adapter lifetime only; each callback uses the actual public resource API. */
export async function withSquare<T>(context: CommandContext, run: (square: Square) => Promise<T>, control?: OperationControl): Promise<T> {
  const square = await Square.at(squareInput(context), control);
  try { return await run(square); }
  finally { await square.close(); }
}

export function now(context: CommandContext): number { return squareClock(context.env)(); }

export function requireSquarePath(context: CommandContext): string {
  if (context.squarePath === undefined) fail(`✕ ${context.command} needs a square location\nsquare ls`);
  return context.squarePath;
}
