import path from 'node:path';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { SquareError } from './model.js';
import type { SquareAtInput, SquareLocation } from './square-facade.js';
import type { SquareBackends } from './square-backend.js';

export type ParsedSquareLocation = { readonly kind: 'local'; readonly path: string }
  | { readonly kind: 'stdio'; readonly backend: string; readonly key: string; readonly uri: string };

export function parseSquareLocation(value: string): ParsedSquareLocation {
  // Windows roots include drive-relative prefixes such as D:.
  if (path.win32.parse(value).root !== '' || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return { kind: 'local', path: value };
  // Parse the raw components, before URL dot-segment normalization or host lowercasing.
  const match = /^stdio:\/\/([A-Za-z0-9_-]+)\/([^/?#]+)$/.exec(value);
  if (!match) throw new SquareError('invalid_args', 'Expected a local path or stdio://<configured-name>/<encoded-square-key>; no credentials, port, query or fragment');
  let key: string;
  try { key = decodeURIComponent(match[2]); }
  catch { throw new SquareError('invalid_args', 'Invalid percent encoding in stdio square key'); }
  if (!key || key === '.' || key === '..' || /[/\\\x00-\x1f\x7f]/.test(key))
    throw new SquareError('invalid_args', 'A stdio square key must be one nonempty name, not a path');
  return { kind: 'stdio', backend: match[1], key, uri: `stdio://${match[1]}/${encodeURIComponent(key)}` };
}

export function squareLocation(input: SquareLocation): string {
  const selected = input.path ?? (input.env ?? process.env).SQUARE_LOCATION;
  if (selected === undefined || selected.trim() === '') throw new SquareError('invalid_args', 'Square needs a location');
  const location = parseSquareLocation(selected);
  return location.kind === 'local' ? path.resolve(input.cwd ?? process.cwd(), location.path) : location.uri;
}

export function localSquareLocation(input: SquareLocation): string {
  const location = squareLocation(input);
  if (parseSquareLocation(location).kind !== 'local')
    throw new SquareError('invalid_args', 'This file operation requires a local square artifact; backend URIs are not supported');
  return location;
}

function validateBackends(value: unknown): SquareBackends {
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const invalid = () => new SquareError('invalid_args', 'Invalid backend configuration: expected {backends:{name:{command,args?,cwd?,env?}}}');
  if (!object(value)) throw invalid();
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || !object(entry) || typeof entry.command !== 'string' || !entry.command.trim()
      || Object.keys(entry).some(key => !['command', 'args', 'cwd', 'env'].includes(key))
      || (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== 'string')))
      || (entry.cwd !== undefined && typeof entry.cwd !== 'string')
      || (entry.env !== undefined && (!object(entry.env) || Object.values(entry.env).some(v => typeof v !== 'string')))) throw invalid();
  }
  return value as SquareBackends;
}

export async function backendConfiguration(input: SquareAtInput): Promise<SquareBackends> {
  if (input.backends !== undefined) return validateBackends(input.backends);
  const env = input.env ?? process.env;
  const configured = env.SQUARE_BACKENDS_CONFIG;
  const file = configured === undefined ? path.join(env.HOME ?? os.homedir(), '.config/square/backends.json')
    : path.resolve(input.cwd ?? process.cwd(), configured);
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (configured === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new SquareError('invalid_args', 'Cannot read backend configuration; check SQUARE_BACKENDS_CONFIG');
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.keys(parsed).some(key => key !== 'backends') || parsed.backends === undefined)
      throw new Error();
    return validateBackends(parsed.backends);
  } catch { throw new SquareError('invalid_args', 'Invalid backend configuration; expected {backends:{name:{command,args?,cwd?,env?}}}'); }
}
