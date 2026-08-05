import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadSquare } from '../artifact.js';
import { commandUsageHint } from '../help.js';
import { type HardCap, parseParticipantList, validateName } from '../model.js';

export const DEFAULT_SQUARE_PATH = '.square/SQUARE.md';

export interface CommandContext {
  squarePath: string;
  name?: string;
  homeDir: string;
  command: string;
}

export interface CommandSpec<Intent = unknown, Result = void> {
  parse(argv: string[], context: CommandContext): Intent;
  execute(intent: Intent, context: CommandContext): Promise<Result> | Result;
  present(result: Result, context: CommandContext): void;
}

export function readStdinSync(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function resolveBody(arg: string): string {
  return arg === '-' ? readStdinSync() : arg;
}

export function readPipedBodyFallback(): string | undefined {
  if (process.stdin.isTTY) return undefined;
  const content = readStdinSync();
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

function resolveDefaultSquarePath(): { path: string; multiple: boolean } {
  const directory = path.join(process.cwd(), '.square');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return { path: DEFAULT_SQUARE_PATH, multiple: false };
  }
  const candidates: Array<{ relPath: string; at: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const fullPath = path.join(directory, entry.name);
    try {
      const doc = loadSquare(fullPath);
      candidates.push({ relPath: path.relative(process.cwd(), fullPath), at: doc.acts.at(-1)?.at ?? fs.statSync(fullPath).mtimeMs });
    } catch {
      // Unreadable artifacts are not implicit command targets.
    }
  }
  candidates.sort((a, b) => b.at - a.at);
  return { path: candidates[0]?.relPath ?? DEFAULT_SQUARE_PATH, multiple: candidates.length > 1 };
}

export interface ParsedGlobalArgs {
  squarePath: string;
  explicitSquarePath: boolean;
  multipleSquares: boolean;
  name?: string;
  args: string[];
}

export function parseGlobalArgs(rawArgs: string[]): ParsedGlobalArgs {
  const args = [...rawArgs];
  let requestedPath: string | undefined;
  let name: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--square-path') {
      requestedPath = requireValue(args, index, args[index]);
      args.splice(index, 2);
      index -= 1;
    } else if (args[index] === '--as') {
      name = requireValue(args, index, args[index]);
      args.splice(index, 2);
      index -= 1;
    }
  }
  if (name !== undefined) validateName(name);
  const explicitSquarePath = requestedPath !== undefined;
  const command = args[0];
  const resolved = !explicitSquarePath && !['ls', 'list', 'version'].includes(command ?? '')
    ? resolveDefaultSquarePath()
    : { path: requestedPath ?? DEFAULT_SQUARE_PATH, multiple: false };
  return { squarePath: resolved.path, explicitSquarePath, multipleSquares: resolved.multiple, name, args };
}

export function defaultContext(command: string, squarePath: string, name?: string): CommandContext {
  return { command, squarePath, name, homeDir: os.homedir() };
}
