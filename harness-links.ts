import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crossSpawn from 'cross-spawn';

export interface HarnessLink {
  source: string;
  target: string;
  kind?: 'skill' | 'extension';
}

function packageRoot(): string {
  // Emitted modules live in dist; package assets are one level above them.
  return fileURLToPath(new URL('../', import.meta.url));
}

function lstatMaybe(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function installHarnessLinks(links: HarnessLink[], force = false): string[] {
  const prepared = links.map((link) => {
    if (!fs.existsSync(link.source)) {
      throw new Error(`Harness link source is missing: ${link.source}`);
    }
    const existing = lstatMaybe(link.target);
    return {
      ...link,
      existing,
      sourceIsDirectory: fs.statSync(link.source).isDirectory(),
      alreadyManaged: existing !== undefined && sameLink(link.source, link.target),
    };
  });
  for (const { target, existing, alreadyManaged } of prepared) {
    if (existing !== undefined && !alreadyManaged && !force) throw new Error(`Refusing to overwrite existing link: ${target}\nPass -f to replace it.`);
  }
  for (const { source, target, existing, sourceIsDirectory, alreadyManaged } of prepared) {
    if (alreadyManaged) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (existing !== undefined) fs.rmSync(target, { recursive: true, force: true });
    const symlinkType = os.platform() === 'win32' && sourceIsDirectory ? 'junction' : 'file';
    fs.symlinkSync(source, target, symlinkType);
  }
  return prepared.map(({ target }) => target);
}

function sameLink(source: string, target: string): boolean {
  try {
    return fs.realpathSync(source) === fs.realpathSync(target);
  } catch {
    return false;
  }
}

export function uninstallHarnessLinks(links: HarnessLink[]): string[] {
  const removed: string[] = [];
  for (const link of links) {
    try {
      if (fs.lstatSync(link.target).isSymbolicLink() && sameLink(link.source, link.target)) {
        fs.rmSync(link.target, { force: true });
        removed.push(link.target);
      }
    } catch {
      // A missing or user-owned target is preserved.
    }
  }
  return removed;
}

export function doctorHarnessLinks(links: HarnessLink[]): string[] {
  return links.map((link) => sameLink(link.source, link.target)
    ? `✓ Square ${link.kind ?? 'link'} ${link.target}`
    : `○ Square ${link.kind ?? 'link'} missing ${link.target}`);
}

export type OpenCodeCommandRunner = (homeDir: string, args: string[]) => { status: number; stdout: string; stderr: string };

function runOpenCode(homeDir: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = crossSpawn.sync(process.env.SQUARE_OPENCODE_BIN || 'opencode', args, {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? path.join(homeDir, '.config') },
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/** Verify that OpenCode accepts its resolved runtime configuration after links are installed. */
export function verifyOpenCodeRuntime(homeDir: string, run: OpenCodeCommandRunner = runOpenCode): string {
  try {
    const result = run(homeDir, ['debug', 'config']);
    if (result.status !== 0) {
      return `✕ OpenCode debug config failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`;
    }
    let config: { config?: { plugin?: unknown } };
    try {
      config = JSON.parse(result.stdout) as { config?: { plugin?: unknown } };
    } catch {
      return '✕ OpenCode debug config returned invalid JSON';
    }
    const plugin = config.config?.plugin;
    const expected = pathToFileURL(opencodeExtensionLink(homeDir).target).href;
    if (Array.isArray(plugin) && plugin.includes(expected)) return '✓ OpenCode debug config loaded';
    return `○ OpenCode plugin not loaded: ${expected}`;
  } catch (error) {
    return `○ OpenCode runtime unavailable (${error instanceof Error ? error.message : String(error)})`;
  }
}

export function skillLinks(homeDir = os.homedir(), parents: Array<'.claude' | '.agents'> = ['.claude', '.agents']): HarnessLink[] {
  return parents.flatMap((parent) => ['square', 'brainstorm'].map((name) => ({
    source: path.join(packageRoot(), 'skills', name),
    target: path.join(homeDir, parent, 'skills', name),
    kind: 'skill' as const,
  })));
}

export function opencodeExtensionLink(homeDir = os.homedir()): HarnessLink {
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(homeDir, '.config');
  return {
    source: path.join(packageRoot(), 'extensions', 'square-opencode.js'),
    target: path.join(configHome, 'opencode', 'plugins', 'square.js'),
    kind: 'extension',
  };
}
