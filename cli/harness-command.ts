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
  action: HarnessCommandAction;
  target?: string;
  force: boolean;
}

export interface HarnessCommandResult {
  lines: string[];
  notes: string[];
}

export const harnessCommand: CommandSpec<ParsedHarnessCommand, HarnessCommandResult> = {
  parse(argv) {
    const action = argv[0];
    if (action !== 'install' && action !== 'uninstall' && action !== 'doctor') {
      throw new Error('harness requires install, uninstall, or doctor');
    }
    const rest = argv.slice(1);
    const option = rest.find((argument) => argument.startsWith('-') && argument !== '-f' && argument !== '--force');
    if (option !== undefined) throw new Error(`Unknown harness option: ${option}`);
    return {
      action,
      target: rest.find((argument) => !argument.startsWith('-')),
      force: rest.includes('-f') || rest.includes('--force'),
    };
  },
  async execute(intent, context) {
    if (intent.target === undefined && intent.action !== 'doctor') {
      throw new Error('harness install/uninstall requires an explicit target: skills | claude | codex | opencode | pi');
    }
    const targetNames = intent.target === undefined
      ? harnessTargets().map((target) => target.name)
      : [intent.target];
    const results: HarnessTargetResult[] = [];
    for (const target of targetNames) {
      results.push(await executeHarnessTarget(target, intent.action, {
        homeDir: context.homeDir,
        squarePath: context.squarePath,
        force: intent.force,
      }));
    }
    return {
      notes: results.flatMap((result) => result.notes),
      lines: results.flatMap((result) => result.lines),
    };
  },
  present(result) {
    process.stdout.write(formatHarnessResult(result));
  },
};

export function formatHarnessResult(result: HarnessCommandResult): string {
  return `${[...result.notes, ...result.lines].join('\n')}\n`;
}

export function runHarnessCommand(argv: string[], squarePath?: string): Promise<string> {
  const context = { homeDir: os.homedir(), squarePath: squarePath ?? '.square/SQUARE.md', command: 'harness' };
  const intent = harnessCommand.parse(argv, context);
  return Promise.resolve(harnessCommand.execute(intent, context)).then(formatHarnessResult);
}
