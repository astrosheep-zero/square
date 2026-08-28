import os from 'node:os';

import { commandUsageHint } from '../help.js';
import { type HardCap, parseParticipantList, validateName } from '../model.js';
import { createHostLedgerPort } from '../host-ledger-file-adapter.js';
import { projectSessionBindings, sessionIdsFromEnvironment } from '../square-projections.js';

export interface CommandContext {
  squarePath?: string;
  name?: string;
  homeDir: string;
  command: string;
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

export async function readPipedBodyFallback(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const content = await readStdin();
  return content.trim() === '' ? undefined : content;
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
  if (value === undefined || value.startsWith('--')) fail(`Missing value for ${flag}.`);
  return value;
}

export function parseDurationMs(value: string, flag: string): number {
  const match = value.match(/^([1-9]\d*)(ms|s|m|h)$/);
  if (!match) fail(`Invalid ${flag}: expected a positive duration with unit ms, s, m, or h (for example 500ms, 30s, 3m, 1h).`);
  const amount = Number.parseInt(match[1], 10);
  const multiplier: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  const milliseconds = amount * multiplier[match[2]];
  if (!Number.isSafeInteger(milliseconds)) fail(`Invalid ${flag}: duration is too large.`);
  return milliseconds;
}

export function parsePositiveInteger(value: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(value)) fail(`Invalid ${flag}: expected a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`Invalid ${flag}: value is too large.`);
  return parsed;
}

export function parseNonNegativeInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) fail(`Invalid ${flag}: expected a non-negative integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`Invalid ${flag}: value is too large.`);
  return parsed;
}

export function parseHardCap(value: string): HardCap {
  if (value === 'unlimited') return null;
  if (!/^[1-9]\d*$/.test(value)) fail('Invalid build option: --cap must be a positive integer or unlimited.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail('Invalid build option: --cap must be a positive integer or unlimited.');
  return parsed;
}

export function parseNameList(value: string, flag: string): string[] {
  const names = parseParticipantList(value);
  if (names.length === 0) fail(`Invalid ${flag}: expected at least one participant name.`);
  for (const name of names) validateName(name);
  return names;
}

export function requireParticipant(name: string | undefined): string {
  if (!name) fail('Missing required option: --as <name>.');
  validateName(name);
  return name;
}

const LOCATION_REQUIRED_COMMANDS = new Set([
  'build',
  'stream',
  'join',
  'catch',
  'express',
  'listen',
  'ignore',
  'listening',
  'done',
  'hold',
  'resume',
  'history',
  'status',
  'participants',
  'doctor',
]);

function configuredLocation(): string | undefined {
  const value = process.env.SQUARE_LOCATION?.trim();
  return value === '' ? undefined : value;
}

function configuredName(): string | undefined {
  const value = process.env.SQUARE_PARTICIPANT_NAME?.trim();
  if (!value) return undefined;
  validateName(value);
  return value;
}

export interface ParsedGlobalArgs {
  squarePath?: string;
  explicitSquarePath: boolean;
  multipleSquares: boolean;
  name?: string;
  args: string[];
}

export async function parseGlobalArgs(rawArgs: string[]): Promise<ParsedGlobalArgs> {
  const args = [...rawArgs];
  let requestedPath: string | undefined;
  let name: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--location') {
      requestedPath = requireValue(args, index, args[index]);
      args.splice(index, 2);
      index -= 1;
    } else if (args[index] === '--as') {
      name = requireValue(args, index, args[index]);
      args.splice(index, 2);
      index -= 1;
    }
  }
  if (name === undefined) name = configuredName();
  if (name !== undefined) validateName(name);
  const explicitSquarePath = requestedPath !== undefined;
  const command = args[0];
  const configured = configuredLocation();
  if (command !== undefined && !['--help', '-h'].includes(command) && locationIsRequired(command) && requestedPath === undefined && configured === undefined) {
    fail(`✕ ${command} needs a square location\n» square ls`);
  }
  const squarePath = requestedPath ?? configured;
  if (name === undefined && squarePath !== undefined && command !== undefined && locationIsRequired(command)) {
    const bindings = (await Promise.all(sessionIdsFromEnvironment().map((sessionId) => projectSessionBindings({
      hostLedger: createHostLedgerPort(),
      location: squarePath,
      sessionId,
      scopes: ['user', 'local'],
    })))).flat();
    const names = new Set(bindings.map((binding) => binding.participant));
    name = names.size === 1 ? [...names][0] : undefined;
  }
  return { squarePath, explicitSquarePath: explicitSquarePath || configured !== undefined, multipleSquares: false, name, args };
}

export function locationIsRequired(command: string): boolean {
  return LOCATION_REQUIRED_COMMANDS.has(command);
}

export function defaultContext(command: string, squarePath?: string, name?: string): CommandContext {
  return { command, squarePath, name, homeDir: os.homedir() };
}

export function requireSquarePath(context: CommandContext): string {
  if (context.squarePath === undefined) fail(`✕ ${context.command} needs a square location\n» square ls`);
  return context.squarePath;
}
