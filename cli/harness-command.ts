import os from 'node:os';

import {
  executeHarnessTarget,
  harnessTargets,
  type HarnessAction,
  type HarnessTargetResult,
} from '../harness.js';

import { type CommandSpec } from './context.js';

export type HarnessCommandAction = HarnessAction;
export interface ParsedHarnessCommand {
  target?: string;
}

export interface ParsedInstallCommand {
  targets: string[];
  all: boolean;
  force: boolean;
}

export interface HarnessCommandResult {
  lines: string[];
  notes: string[];
  failures: string[];
}

type HarnessTargetExecutor = typeof executeHarnessTarget;

function installTargets(intent: ParsedInstallCommand, action: 'install' | 'uninstall'): string[] {
  const available = harnessTargets().filter((target) => target.capabilities.includes(action));
  const names = intent.all ? available.map((target) => target.name) : [...new Set(intent.targets)];
  if (names.length === 0) throw new Error(`${action} requires one or more targets, or --all`);
  for (const name of names) {
    if (!available.some((target) => target.name === name)) {
      throw new Error(`Unknown ${action} target: ${name}`);
    }
  }
  return names;
}

function parseInstall(argv: string[], action: 'install' | 'uninstall'): ParsedInstallCommand {
  const all = argv.includes('--all');
  const force = argv.includes('-f') || argv.includes('--force');
  const allowedOptions = action === 'install' ? ['--all', '-f', '--force'] : ['--all'];
  const option = argv.find((argument) => argument.startsWith('-') && !allowedOptions.includes(argument));
  if (option !== undefined) throw new Error(`Unknown ${action} option: ${option}`);
  if (action === 'uninstall' && force) throw new Error(`Unknown uninstall option: ${argv.find((item) => item === '-f' || item === '--force')}`);
  const targets = argv.filter((argument) => !argument.startsWith('-'));
  if (all && targets.length > 0) throw new Error(`Cannot combine ${action} --all with named targets`);
  return { targets, all, force };
}

export async function executeTargetBatch(
  targets: string[],
  action: 'install' | 'uninstall',
  context: { homeDir: string; squarePath?: string; force: boolean },
  executeTarget: HarnessTargetExecutor = executeHarnessTarget
): Promise<HarnessCommandResult> {
  const results: HarnessTargetResult[] = [];
  const failures: string[] = [];
  for (const target of targets) {
    try {
      results.push(await executeTarget(target, action, context));
    } catch (error) {
      failures.push(`✕ ${target} ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    notes: results.flatMap((result) => result.notes),
    lines: results.flatMap((result) => result.lines),
    failures,
  };
}

function targetCommand(action: 'install' | 'uninstall'): CommandSpec<ParsedInstallCommand, HarnessCommandResult> {
  return {
    parse(argv) { return parseInstall(argv, action); },
    async execute(intent, context) {
      return executeTargetBatch(installTargets(intent, action), action, {
        homeDir: context.homeDir,
        squarePath: context.squarePath,
        force: intent.force,
      });
    },
    present(result) {
      process.stdout.write(formatHarnessResult(result));
      if (result.failures.length > 0) process.exitCode = 1;
    },
  };
}

export const installCommand = targetCommand('install');
export const uninstallCommand = targetCommand('uninstall');

export const harnessCommand: CommandSpec<ParsedHarnessCommand, HarnessCommandResult> = {
  parse(argv) {
    if (argv[0] !== 'doctor') throw new Error('harness only supports doctor');
    const rest = argv.slice(1);
    const option = rest.find((argument) => argument.startsWith('-'));
    if (option !== undefined) throw new Error(`Unknown harness option: ${option}`);
    if (rest.length > 1) throw new Error('harness doctor accepts at most one target');
    return {
      target: rest[0],
    };
  },
  async execute(intent, context) {
    const targetNames = intent.target === undefined
      ? harnessTargets().map((target) => target.name)
      : [intent.target];
    const results: HarnessTargetResult[] = [];
    for (const target of targetNames) {
      results.push(await executeHarnessTarget(target, 'doctor', {
        homeDir: context.homeDir,
        squarePath: context.squarePath,
        force: false,
      }));
    }
    return {
      notes: results.flatMap((result) => result.notes),
      lines: results.flatMap((result) => result.lines),
      failures: [],
    };
  },
  present(result) {
    process.stdout.write(formatHarnessResult(result));
  },
};

export function formatHarnessResult(result: HarnessCommandResult): string {
  return `${[...result.notes, ...result.lines, ...result.failures].join('\n')}\n`;
}

export function runHarnessCommand(argv: string[], squarePath?: string): Promise<string> {
  const context = { homeDir: os.homedir(), ...(squarePath === undefined ? {} : { squarePath }), command: 'harness' };
  const intent = harnessCommand.parse(argv, context);
  return Promise.resolve(harnessCommand.execute(intent, context)).then(formatHarnessResult);
}
