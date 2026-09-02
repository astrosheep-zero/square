import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crossSpawn from 'cross-spawn';

import { SQUARE_IDENTITY } from './identity.js';
import { stageReplacement } from './harness-stage.js';

export const CLAUDE_PLUGIN_ID = SQUARE_IDENTITY.pluginId;
export const CLAUDE_MARKETPLACE_NAME = SQUARE_IDENTITY.marketplaceName;
export interface ClaudeCommandResult { status: number; stdout: string; stderr: string; }
export type ClaudeCommandRunner = (homeDir: string, args: string[]) => ClaudeCommandResult;
export interface ClaudeInstallResult { marketplaceRoot: string; pluginRoot: string; }

export function claudeMarketplaceRoot(homeDir: string): string {
  return path.join(homeDir, '.square', 'claude', 'marketplaces', CLAUDE_MARKETPLACE_NAME);
}

function runClaude(homeDir: string, args: string[]): ClaudeCommandResult {
  const command = process.env.SQUARE_CLAUDE_BIN || 'claude';
  const result = crossSpawn.sync(command, args, {
    encoding: 'utf8', env: { ...process.env, HOME: homeDir, CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude') }, timeout: 30_000,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Claude CLI not found: ${command}. Install Claude Code or set SQUARE_CLAUDE_BIN to its executable path.`);
    }
    throw result.error;
  }
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function requireSuccess(result: ClaudeCommandResult, operation: string, allowMissing = false): void {
  if (result.status === 0 || (allowMissing && /not configured|not installed|not found/i.test(result.stderr))) return;
  throw new Error(`Claude ${operation} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`);
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function installClaudePlugin(homeDir: string, run: ClaudeCommandRunner = runClaude): Promise<ClaudeInstallResult> {
  const marketplaceRoot = claudeMarketplaceRoot(homeDir);
  const staged = stageReplacement(marketplaceRoot, (stage) => {
    const plugin = path.join(stage, 'plugins', SQUARE_IDENTITY.pluginName);
    fs.cpSync(fileURLToPath(new URL('../claude-plugin/', import.meta.url)), plugin, { recursive: true });
    const skill = path.join(plugin, 'skills', 'square', 'SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.copyFileSync(path.join(fileURLToPath(new URL('../skills/square/', import.meta.url)), 'SKILL.md'), skill);
    writeJson(path.join(stage, '.claude-plugin', 'marketplace.json'), {
      name: CLAUDE_MARKETPLACE_NAME,
      owner: { name: 'Square' },
      plugins: [{ name: SQUARE_IDENTITY.pluginName, source: './plugins/square' }],
    });
  });
  try {
    const add = run(homeDir, ['plugin', 'marketplace', 'add', marketplaceRoot]);
    requireSuccess(add, 'marketplace install', true);
    requireSuccess(run(homeDir, ['plugin', 'install', CLAUDE_PLUGIN_ID]), 'plugin install');
    requireSuccess(run(homeDir, ['plugin', 'update', CLAUDE_PLUGIN_ID]), 'plugin update');
    staged.finalize();
  } catch (error) {
    staged.rollback();
    throw error;
  }
  return { marketplaceRoot, pluginRoot: path.join(marketplaceRoot, 'plugins', SQUARE_IDENTITY.pluginName) };
}

export async function uninstallClaudePlugin(homeDir: string, run: ClaudeCommandRunner = runClaude): Promise<{ paths: string[]; notes: string[] }> {
  const root = claudeMarketplaceRoot(homeDir);
  requireSuccess(run(homeDir, ['plugin', 'remove', CLAUDE_PLUGIN_ID]), 'plugin removal', true);
  requireSuccess(run(homeDir, ['plugin', 'marketplace', 'remove', CLAUDE_MARKETPLACE_NAME]), 'marketplace removal', true);
  fs.rmSync(root, { recursive: true, force: true });
  return { paths: [root], notes: [] };
}

export async function doctorClaudePlugin(homeDir: string, run: ClaudeCommandRunner = runClaude): Promise<string[]> {
  const root = claudeMarketplaceRoot(homeDir);
  const bundle = path.join(root, 'plugins', SQUARE_IDENTITY.pluginName);
  const listed = run(homeDir, ['plugin', 'list', '--json']);
  const installed = listed.status === 0 && listed.stdout.includes(CLAUDE_PLUGIN_ID);
  return [
    fs.existsSync(bundle) ? `✓ Square Claude plugin bundle ${root}` : `○ Square Claude plugin bundle missing ${root}`,
    installed ? `✓ ${CLAUDE_PLUGIN_ID} installed` : `○ ${CLAUDE_PLUGIN_ID} unavailable`,
  ];
}
