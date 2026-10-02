import fs from 'node:fs';
import path from 'node:path';
import { applyEdits, createScanner, parseTree, printParseErrorCode, SyntaxKind, type Edit, type Node, type ParseError } from 'jsonc-parser';

import { SQUARE_IDENTITY } from './identity.js';

function pluginArray(source: string, target: string): Node | undefined {
  const errors: ParseError[] = [];
  const root = parseTree(source, errors, { allowTrailingComma: true, allowEmptyContent: true });
  if (errors.length > 0) {
    throw new Error(`Invalid OpenCode config ${target}: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
  }
  if (root === undefined) return undefined;
  if (root.type !== 'object') throw new Error(`Invalid OpenCode config ${target}: expected an object`);
  const properties = root.children?.filter((node) => node.children?.[0].value === 'plugin') ?? [];
  if (properties.length > 1) throw new Error(`Ambiguous OpenCode config ${target}: duplicate plugin properties`);
  const plugin = properties[0]?.children?.[1];
  if (plugin !== undefined && plugin.type !== 'array') {
    throw new Error(`Invalid OpenCode config ${target}: plugin must be an array`);
  }
  return plugin;
}

function isSquarePlugin(node: Node): boolean {
  // OpenCode accepts a package string or [package, options].
  const name = node.type === 'array' ? node.children?.[0] : node;
  return name?.type === 'string'
    && (name.value === SQUARE_IDENTITY.packageName || name.value.startsWith(`${SQUARE_IDENTITY.packageName}@`));
}

function withoutSquarePlugin(source: string, target: string): string {
  const plugin = pluginArray(source, target);
  const entries = plugin?.children ?? [];
  const removed = entries.map(isSquarePlugin);
  if (!removed.some(Boolean)) return source;

  // Remove values and their separators, not whole lines or trivia. In particular,
  // comments between entries belong to the user's config and stay byte-for-byte.
  const scanner = createScanner(source, true);
  const commas = entries.map((entry) => {
    scanner.setPosition(entry.offset + entry.length);
    return scanner.scan() === SyntaxKind.CommaToken ? scanner.getTokenOffset() : undefined;
  });
  const trailingComma = commas.at(-1) !== undefined;
  const lastKept = removed.lastIndexOf(false);
  const edits: Edit[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (removed[index]) edits.push({ offset: entries[index].offset, length: entries[index].length, content: '' });
    const comma = commas[index];
    if (comma !== undefined && (removed[index] || (index === lastKept && !trailingComma))) {
      edits.push({ offset: comma, length: 1, content: '' });
    }
  }
  const next = applyEdits(source, edits);
  pluginArray(next, target);
  return next;
}

/** Remove registrations from every global config source, including shadowed ones. */
export function removeOpenCodePluginConfig(homeDir: string): boolean {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
  const directory = path.join(configHome, 'opencode');
  const prepared: Array<{ target: string; source: string; next: string }> = [];
  const seen = new Set<string>();
  // OpenCode merges all three files in this order. Only editing the preferred
  // file can revive a lower-precedence registration on the next launch.
  for (const filename of ['config.json', 'opencode.json', 'opencode.jsonc']) {
    const target = path.join(directory, filename);
    try {
      fs.lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const real = fs.realpathSync(target);
    if (seen.has(real)) continue;
    seen.add(real);
    const source = fs.readFileSync(target, 'utf8');
    const next = withoutSquarePlugin(source, target);
    if (next !== source) prepared.push({ target, source, next });
  }
  // Validate every source and planned write before changing any file or link.
  // Read/parse/permission failures must reach the CLI instead of implying success.
  for (const { target, source } of prepared) {
    fs.accessSync(target, fs.constants.W_OK);
    if (fs.readFileSync(target, 'utf8') !== source) throw new Error(`OpenCode config changed during uninstall: ${target}`);
  }
  for (const { target, next } of prepared) fs.writeFileSync(target, next);
  return prepared.length > 0;
}
