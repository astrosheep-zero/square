import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SQUARE_IDENTITY } from './identity.js';
import { stageReplacement } from './harness-stage.js';

export const CODEX_HOOK_COMMAND = SQUARE_IDENTITY.hookCommand;
export const SQUARE_CODEX_MARKER = SQUARE_IDENTITY.hookMarker;
export const CODEX_PLUGIN_ID = SQUARE_IDENTITY.pluginId;
export const CODEX_MARKETPLACE_NAME = SQUARE_IDENTITY.marketplaceName;
const LEGACY_MARKETPLACES = ['astrosheep-square'];
export interface CodexCommandResult { status: number; stdout: string; stderr: string; }
export type CodexCommandRunner = (homeDir: string, args: string[]) => CodexCommandResult;
export interface CodexInstallResult { configPath: string; marketplaceRoot: string; pluginRoot: string; installedPath?: string; notes: string[]; }

export function codexMarketplaceRoot(homeDir: string): string {
  return path.join(homeDir, '.square', 'codex', 'marketplaces', CODEX_MARKETPLACE_NAME);
}
function configuredMarketplaceRoot(homeDir: string, configText: string): string | undefined {
  const lines = configText.split('\n');
  const header = `[marketplaces.${CODEX_MARKETPLACE_NAME}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^\s*\[[^\]]+\]/.test(line));
  const section = lines.slice(start + 1, end < 0 ? undefined : end);
  const sourceType = section.find((line) => /^\s*source_type\s*=/.test(line));
  if (sourceType && !/=\s*["']local["']\s*$/.test(sourceType)) return undefined;
  const source = section.find((line) => /^\s*source\s*=/.test(line));
  const match = source?.match(/^\s*source\s*=\s*("(?:\\.|[^"])*"|'[^']*')\s*$/);
  if (!match) return undefined;
  const value = match[1].startsWith('"') ? JSON.parse(match[1]) as string : match[1].slice(1, -1);
  return path.isAbsolute(value) ? value : path.resolve(codexHome(homeDir), value);
}
function activeMarketplaceRoot(homeDir: string, configText: string): string {
  return configuredMarketplaceRoot(homeDir, configText) ?? codexMarketplaceRoot(homeDir);
}
export function codexPluginRoot(homeDir: string, marketplaceRoot = codexMarketplaceRoot(homeDir)): string {
  return path.join(marketplaceRoot, 'plugins', SQUARE_IDENTITY.pluginName);
}
export function codexPluginHooksPath(homeDir: string, marketplaceRoot = codexMarketplaceRoot(homeDir)): string {
  return path.join(codexPluginRoot(homeDir, marketplaceRoot), 'hooks', 'hooks.json');
}
function codexHome(homeDir: string): string { return path.join(homeDir, '.codex'); }
export function codexHomeHooksPath(homeDir: string): string { return path.join(codexHome(homeDir), 'hooks.json'); }
export function codexConfigPath(homeDir: string): string { return path.join(codexHome(homeDir), 'config.toml'); }

function runCodex(homeDir: string, args: string[]): CodexCommandResult {
  const result = spawnSync(process.env.SQUARE_CODEX_BIN || 'codex', args, {
    encoding: 'utf8', env: { ...process.env, HOME: homeDir, CODEX_HOME: codexHome(homeDir) }, timeout: 30_000,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function requireSuccess(result: CodexCommandResult, operation: string, allowMissing = false): void {
  if (result.status === 0 || (allowMissing && /not configured|not installed|not found/i.test(result.stderr))) return;
  throw new Error(`Codex ${operation} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`);
}

export function upsertTomlSectionKey(text: string, section: string, key: string, value: string): string {
  const lines = text.replace(/\n$/, '').split('\n').filter((line, i) => line !== '' || i < text.length);
  const header = `[${section}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return `${text.trimEnd()}${text.trim() ? '\n\n' : ''}${header}\n${key} = ${value}\n`;
  const end = lines.findIndex((line, i) => i > start && /^\s*\[[^\]]+\]/.test(line));
  const stop = end < 0 ? lines.length : end;
  const match = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*=`);
  const existing = lines.findIndex((line, i) => i > start && i < stop && match.test(line));
  if (existing < 0) lines.splice(stop, 0, `${key} = ${value}`); else lines[existing] = `${key} = ${value}`;
  return `${lines.join('\n')}\n`;
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export async function installCodexPlugin(homeDir: string, run: CodexCommandRunner = runCodex): Promise<CodexInstallResult> {
  const config = codexConfigPath(homeDir);
  const current = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '';
  const root = activeMarketplaceRoot(homeDir, current);
  const staged = stageReplacement(root, (stage) => {
    const plugin = path.join(stage, 'plugins', SQUARE_IDENTITY.pluginName);
    fs.cpSync(fileURLToPath(new URL('../codex-plugin/', import.meta.url)), plugin, { recursive: true });
    const skill = path.join(plugin, 'skills', 'square', 'SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.copyFileSync(path.join(fileURLToPath(new URL('../skills/square/', import.meta.url)), 'SKILL.md'), skill);
    writeAtomic(path.join(stage, '.agents', 'plugins', 'marketplace.json'), `${JSON.stringify({ name: CODEX_MARKETPLACE_NAME, plugins: [{ name: SQUARE_IDENTITY.pluginName, source: { source: 'local', path: './plugins/square' } }] }, null, 2)}\n`);
  });
  const notes: string[] = [];
  try {
    writeAtomic(config, upsertTomlSectionKey(current, 'features', 'hooks', 'true'));
    requireSuccess(run(homeDir, ['plugin', 'marketplace', 'add', root, '--json']), 'marketplace install', true);
    const installed = run(homeDir, ['plugin', 'add', CODEX_PLUGIN_ID, '--json']);
    requireSuccess(installed, 'plugin install');
    let installedPath: string | undefined;
    try { const value = JSON.parse(installed.stdout).installedPath; if (typeof value === 'string') installedPath = value; } catch { notes.push('Codex returned non-JSON installation output.'); }
    for (const marketplace of LEGACY_MARKETPLACES) {
      const pluginId = `${SQUARE_IDENTITY.pluginName}@${marketplace}`;
      if (!current.includes(`[marketplaces.${marketplace}]`) && !current.includes(`[plugins."${pluginId}"]`)) continue;
      requireSuccess(run(homeDir, ['plugin', 'remove', pluginId, '--json']), 'legacy plugin removal', true);
      requireSuccess(run(homeDir, ['plugin', 'marketplace', 'remove', marketplace, '--json']), 'legacy marketplace removal', true);
      notes.push(`retired ${pluginId}`);
    }
    staged.finalize();
    return { configPath: config, marketplaceRoot: root, pluginRoot: codexPluginRoot(homeDir, root), ...(installedPath ? { installedPath } : {}), notes };
  } catch (error) {
    staged.rollback();
    throw error;
  }
}

export async function uninstallCodexPlugin(homeDir: string, run: CodexCommandRunner = runCodex): Promise<{ paths: string[]; notes: string[] }> {
  const config = codexConfigPath(homeDir);
  const current = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '';
  const root = activeMarketplaceRoot(homeDir, current);
  requireSuccess(run(homeDir, ['plugin', 'remove', CODEX_PLUGIN_ID, '--json']), 'plugin removal', true);
  requireSuccess(run(homeDir, ['plugin', 'marketplace', 'remove', CODEX_MARKETPLACE_NAME, '--json']), 'marketplace removal', true);
  for (const marketplace of LEGACY_MARKETPLACES) {
    requireSuccess(run(homeDir, ['plugin', 'remove', `${SQUARE_IDENTITY.pluginName}@${marketplace}`, '--json']), 'legacy plugin removal', true);
    requireSuccess(run(homeDir, ['plugin', 'marketplace', 'remove', marketplace, '--json']), 'legacy marketplace removal', true);
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(codexHomeHooksPath(homeDir), { force: true });
  return { paths: [root, codexConfigPath(homeDir), codexHomeHooksPath(homeDir)], notes: [] };
}

export async function doctorCodexPlugin(homeDir: string, run: CodexCommandRunner = runCodex): Promise<string[]> {
  const config = codexConfigPath(homeDir);
  const current = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '';
  const root = activeMarketplaceRoot(homeDir, current);
  const listed = run(homeDir, ['plugin', 'list', '--json']);
  return [
    /^hooks\s*=\s*true$/m.test(current) ? `✓ features.hooks=true in ${config}` : `○ features.hooks missing in ${config}`,
    fs.existsSync(codexPluginHooksPath(homeDir, root)) ? `✓ Square plugin hooks ${codexPluginHooksPath(homeDir, root)}` : `○ Square plugin bundle missing ${root}`,
    listed.status === 0 && listed.stdout.includes(CODEX_PLUGIN_ID) ? `✓ ${CODEX_PLUGIN_ID} installed` : `○ ${CODEX_PLUGIN_ID} unavailable`,
  ];
}
