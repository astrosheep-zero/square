import fs from 'node:fs';

import { doctorDeliveryHealth } from './delivery-health.js';
import { wakeGraceMs } from './notifications.js';

import {
  doctorClaudePlugin,
  installClaudePlugin,
  uninstallClaudePlugin,
} from './harness-claude.js';
import {
  doctorCodexPlugin,
  installCodexPlugin,
  uninstallCodexPlugin,
} from './harness-codex.js';
import {
  doctorHarnessLinks,
  installHarnessLinks,
  opencodeExtensionLink,
  piExtensionLink,
  skillLinks,
  uninstallHarnessLinks,
  verifyOpenCodeRuntime,
} from './harness-links.js';

export type HarnessTargetName = 'claude' | 'codex' | 'opencode' | 'pi' | 'delivery';
export type HarnessAction = 'install' | 'uninstall' | 'doctor';

export interface HarnessTargetContext {
  homeDir: string;
  squarePath?: string;
  force: boolean;
}

export interface HarnessTargetResult {
  lines: string[];
  notes: string[];
}

export interface HarnessTarget {
  name: HarnessTargetName;
  capabilities: readonly HarnessAction[];
  install?(context: HarnessTargetContext): Promise<HarnessTargetResult> | HarnessTargetResult;
  uninstall?(context: HarnessTargetContext): Promise<HarnessTargetResult> | HarnessTargetResult;
  doctor?(context: HarnessTargetContext): Promise<HarnessTargetResult> | HarnessTargetResult;
}

function result(lines: string[], notes: string[] = []): HarnessTargetResult {
  return { lines, notes };
}

async function doctorHost(label: string, inspect: () => Promise<string[]>): Promise<HarnessTargetResult> {
  try {
    return result(await inspect());
  } catch (error) {
    return result([`○ ${label} doctor unavailable (${error instanceof Error ? error.message : String(error)})`]);
  }
}

function openCodeLinks(homeDir: string) {
  return [opencodeExtensionLink(homeDir), ...skillLinks(homeDir, ['.agents'])];
}

function readableSquarePath(squarePath: string | undefined): squarePath is string {
  if (squarePath === undefined) return false;
  try {
    return fs.statSync(squarePath).isFile() && (fs.accessSync(squarePath, fs.constants.R_OK), true);
  } catch {
    return false;
  }
}

const TARGETS: readonly HarnessTarget[] = [
  {
    name: 'claude',
    capabilities: ['install', 'uninstall', 'doctor'],
    async install({ homeDir }) {
      const installed = await installClaudePlugin(homeDir);
      return result([installed.marketplaceRoot, installed.pluginRoot]);
    },
    async uninstall({ homeDir }) {
      const removed = await uninstallClaudePlugin(homeDir);
      return result(removed.paths, removed.notes);
    },
    async doctor({ homeDir }) { return doctorHost('Claude', () => doctorClaudePlugin(homeDir)); },
  },
  {
    name: 'codex',
    capabilities: ['install', 'uninstall', 'doctor'],
    async install({ homeDir }) {
      const installed = await installCodexPlugin(homeDir, undefined, process.env.CODEX_HOME);
      const lines = [
        installed.configPath,
        installed.marketplaceRoot,
        installed.pluginRoot,
        installed.installedPath,
      ].filter((line): line is string => line !== undefined);
      return result(lines, installed.notes);
    },
    async uninstall({ homeDir }) {
      const removed = await uninstallCodexPlugin(homeDir, undefined, process.env.CODEX_HOME);
      return result(removed.paths, removed.notes);
    },
    async doctor({ homeDir }) { return doctorHost('Codex', () => doctorCodexPlugin(homeDir, undefined, process.env.CODEX_HOME)); },
  },
  {
    name: 'opencode',
    capabilities: ['install', 'uninstall', 'doctor'],
    install: ({ homeDir, force }) => result(installHarnessLinks(openCodeLinks(homeDir), force)),
    uninstall: ({ homeDir }) => result(uninstallHarnessLinks(openCodeLinks(homeDir))),
    doctor: ({ homeDir }) => result([...doctorHarnessLinks(openCodeLinks(homeDir)), verifyOpenCodeRuntime(homeDir)]),
  },
  {
    name: 'pi',
    capabilities: ['install', 'uninstall', 'doctor'],
    install: ({ homeDir, force }) => result(installHarnessLinks([piExtensionLink(homeDir)], force)),
    uninstall: ({ homeDir }) => result(uninstallHarnessLinks([piExtensionLink(homeDir)])),
    doctor: ({ homeDir }) => result(doctorHarnessLinks([piExtensionLink(homeDir)])),
  },
  {
    name: 'delivery',
    capabilities: ['doctor'],
    doctor: ({ squarePath }) => result(readableSquarePath(squarePath)
      ? doctorDeliveryHealth(squarePath, wakeGraceMs())
      : ['○ delivery health skipped (no readable square path)']),
  },
];

export function harnessTargets(): readonly HarnessTarget[] {
  return TARGETS;
}

function requireHarnessCapability(target: string, action: HarnessAction): HarnessTarget {
  const found = TARGETS.find((candidate) => candidate.name === target);
  if (found === undefined || !found.capabilities.includes(action)) throw new Error(`Unsupported harness capability: ${action} ${target}`);
  return found;
}

export async function executeHarnessTarget(
  targetName: string,
  action: HarnessAction,
  context: HarnessTargetContext
): Promise<HarnessTargetResult> {
  const target = requireHarnessCapability(targetName, action);
  const capability = target[action];
  if (capability === undefined) throw new Error(`Unsupported harness capability: ${action} ${targetName}`);
  return capability(context);
}
