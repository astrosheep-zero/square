import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import crossSpawn from 'cross-spawn';
import { applyEdits, createScanner, findNodeAtLocation, modify, parse, parseTree, SyntaxKind, type ParseError } from 'jsonc-parser';

import { SQUARE_IDENTITY } from './identity.js';
import { truncateExternalDiagnostic } from './presentation.js';

export type OpenCodeCommandRunner = (homeDir: string, args: string[]) => { status: number; stdout: string; stderr: string };

function runOpenCode(homeDir: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const prefix = (() => {
    try {
      const parsed = JSON.parse(process.env.SQUARE_OPENCODE_BIN_ARGS ?? '[]') as unknown;
      return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
    } catch {
      return [];
    }
  })();
  const result = crossSpawn.sync(process.env.SQUARE_OPENCODE_BIN || 'opencode', [...prefix, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? path.join(homeDir, '.config') },
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

export function installOpenCodePlugin(homeDir: string, force = false, run: OpenCodeCommandRunner = runOpenCode): string[] {
  // Explicit `square install` replaces owned pins/duplicates with one unpinned
  // current-field entry; updating an exact old pin otherwise succeeds unchanged.
  void force;
  const configs = readOpenCodeConfigs(homeDir);
  const entries = configs.flatMap((config) => config.entries);
  const options = entries.map((entry) => entry.options).filter((value) => value !== undefined);
  if (options.some((value) => !isDeepStrictEqual(value, options[0]))) {
    throw new Error('Conflicting Square plugin options in OpenCode configuration; reconcile the owned plugin/plugins entries before installing.');
  }
  const canonical = options.length ? { package: SQUARE_IDENTITY.packageName, options: options[0] } : SQUARE_IDENTITY.packageName;
  const targets = configs.length ? configs : [{ target: openCodeConfigPaths(homeDir)[0], source: '{}', entries: [] }];
  const alreadyCanonical = entries.length === 1 && configs[0]?.entries[0]?.field === 'plugins'
    && isDeepStrictEqual(entries[0].value, canonical);
  const changes = alreadyCanonical ? [] : targets.map(({ target, source, entries }, index) => {
    let next = source;
    for (const { field, index } of entries.toReversed()) next = removeOpenCodeEntry(next, field, index);
    if (index === 0) next = applyEdits(next, modify(next, ['plugins', -1], canonical, {}));
    return { target, source, next };
  }).filter(({ source, next }) => source !== next);
  // Appending just our element avoids native add's whole-array rewrite, which
  // drops comments belonging to unrelated plugins. Native add still owns npm.
  for (const { target, next } of changes) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, next);
  }
  if (!entries.some(({ spec }) => spec === SQUARE_IDENTITY.packageName)) {
    try { openCodeCommand(homeDir, ['plugin', 'add', SQUARE_IDENTITY.packageName], run, 'install'); } catch (error) {
      // Undo only our preparation, never files the native command/user changed.
      for (const { target, source, next } of changes) {
        if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === next) {
          if (configs.length) fs.writeFileSync(target, source);
          else fs.rmSync(target);
        }
      }
      throw error;
    }
  }
  // Even add can reuse an older cached package. Always request the latest.
  openCodeCommand(homeDir, ['plugin', 'update', SQUARE_IDENTITY.packageName], run, 'update');
  return [SQUARE_IDENTITY.packageName];
}

function openCodeCommand(homeDir: string, args: string[], run: OpenCodeCommandRunner, operation: string): string {
  const result = run(homeDir, args);
  if (result.status !== 0) throw new Error(`OpenCode ${operation} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`);
  return result.stdout;
}

function openCodeConfigPaths(homeDir: string): string[] {
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(homeDir, '.config');
  const root = path.resolve(configHome, 'opencode');
  return [root, path.join(root, '.opencode')].flatMap((directory) => ['opencode.json', 'opencode.jsonc'].map((name) => path.join(directory, name)));
}

function readOpenCodeConfigs(homeDir: string) {
  return openCodeConfigPaths(homeDir).flatMap((target) => {
    let source: string;
    try { source = fs.readFileSync(target, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const errors: ParseError[] = [];
    const config: unknown = parse(source, errors, { allowTrailingComma: true });
    if (errors.length || typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new Error(`Invalid OpenCode configuration: ${target}`);
    }
    const entries = ['plugin', 'plugins'].flatMap((field) => {
      const plugins = (config as Record<string, unknown>)[field];
      if (plugins === undefined) return [];
      if (!Array.isArray(plugins)) throw new Error(`Invalid OpenCode ${field} configuration: ${target}`);
      return plugins.flatMap((entry, index) => {
        const spec = openCodePluginSpec(entry);
        const options = Array.isArray(entry) ? entry[1]
          : typeof entry === 'object' && entry !== null ? entry.options : undefined;
        return spec === undefined ? [] : [{ field, index, spec, options, value: entry }];
      });
    });
    return [{ target, source, entries }];
  });
}

export function uninstallOpenCodePlugin(homeDir: string): string[] {
  // Native remove only handles `plugins` in one file. Delete our elements in
  // both fields/files, from the end so indexes remain stable, keeping JSONC.
  const changes = readOpenCodeConfigs(homeDir).filter(({ entries }) => entries.length).map(({ target, source, entries }) => {
    for (const { field, index } of entries.reverse()) {
      source = removeOpenCodeEntry(source, field, index);
    }
    return { target, source };
  });
  for (const { target, source } of changes) fs.writeFileSync(target, source);
  return changes.length ? [SQUARE_IDENTITY.packageName] : [];
}

// jsonc-parser's array `modify` also removes intervening comments. Use its AST
// and scanner to remove only the owned value and one separator, not the trivia.
function removeOpenCodeEntry(source: string, field: string, index: number): string {
  const array = findNodeAtLocation(parseTree(source)!, [field])!;
  const node = array.children![index];
  const scanner = createScanner(source, true);
  scanner.setPosition(node.offset + node.length);
  let comma = scanner.scan() === SyntaxKind.CommaToken ? scanner.getTokenOffset() : undefined;
  if (comma === undefined && index > 0) {
    const previous = array.children![index - 1];
    scanner.setPosition(previous.offset + previous.length);
    if (scanner.scan() === SyntaxKind.CommaToken) comma = scanner.getTokenOffset();
  }
  return applyEdits(source, [
    { offset: node.offset, length: node.length, content: '' },
    ...(comma === undefined ? [] : [{ offset: comma, length: 1, content: '' }]),
  ]);
}

function openCodePluginSpec(entry: unknown): string | undefined {
  const spec = typeof entry === 'string' ? entry : Array.isArray(entry) ? entry[0]
    : typeof entry === 'object' && entry !== null && 'package' in entry ? entry.package : undefined;
  return typeof spec === 'string' && (spec === SQUARE_IDENTITY.packageName || spec.startsWith(`${SQUARE_IDENTITY.packageName}@`))
    ? spec : undefined;
}

interface OpenCodeConfigSource {
  type: string;
  path?: string;
  info?: { plugins?: unknown[] };
}

function parseOpenCodeConfig(stdout: string): OpenCodeConfigSource[] {
  let sources: unknown;
  try { sources = JSON.parse(stdout); } catch { throw new Error('OpenCode debug config returned invalid JSON'); }
  if (!Array.isArray(sources) || sources.some((source) => source === null || typeof source !== 'object'
    || !['document', 'directory'].includes(source.type))) {
    throw new Error('OpenCode debug config returned unexpected configuration sources');
  }
  return sources as OpenCodeConfigSource[];
}

/** Config sources prove configuration, not that a running session loaded the plugin. */
export function verifyOpenCodeRuntime(homeDir: string, run: OpenCodeCommandRunner = runOpenCode): string {
  try {
    const result = run(homeDir, ['debug', 'config']);
    if (result.status !== 0) {
      const diagnostic = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
      return `✕ OpenCode debug config failed: ${truncateExternalDiagnostic(diagnostic)}`;
    }
    let sources: OpenCodeConfigSource[];
    try { sources = parseOpenCodeConfig(result.stdout); } catch (error) {
      return `✕ ${(error as Error).message}`;
    }
    const configured = sources.some((source) => source.type === 'document'
      && Array.isArray(source.info?.plugins) && source.info.plugins.some((entry) => openCodePluginSpec(entry) !== undefined));
    return configured
      ? '✓ OpenCode npm plugin configured (runtime loading not verified)'
      : `○ OpenCode npm plugin not configured: ${SQUARE_IDENTITY.packageName}`;
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    return `○ OpenCode runtime unavailable (${truncateExternalDiagnostic(diagnostic)})`;
  }
}
