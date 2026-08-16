import fs from 'node:fs';

import { diagnoseSquareFile, loadSquare } from '../artifact.js';
import {
  renderDoctorClean,
  renderDoctorProblems,
  renderDoctorRepaired,
  renderDoctorUnfixable,
  withPathOutput,
} from '../presentation.js';
import { inSquareCount } from '../runtime.js';
import { repairSquare } from '../square-application.js';
import { pruneRegistry } from '../registry.js';

import { type CommandSpec, usage } from './context.js';

interface DoctorIntent {
  fix: boolean;
}

interface DoctorResult {
  output: string;
  exitCode?: number;
}

function quarantinePath(squarePath: string): string {
  return squarePath.replace(/\.md$/, '') + '.quarantine.md';
}

function registryActs(squarePath: string): ReturnType<typeof loadSquare>['acts'] | undefined {
  if (!fs.existsSync(squarePath)) return [];
  try {
    return loadSquare(squarePath).acts;
  } catch {
    // A temporarily unreadable artifact cannot disprove a cache binding.
    return undefined;
  }
}

export const doctorCommand: CommandSpec<DoctorIntent, DoctorResult> = {
  parse(argv, context) {
    let fix = false;
    for (let index = 0; index < argv.length; index++) {
      const argument = argv[index];
      if (argument === '--fix') fix = true;
      else if (argument === '--before') {
        index += 1;
        if (argv[index] === undefined) usage(context.command);
      } else usage(context.command);
    }
    return { fix };
  },
  async execute(intent, context) {
    if (!intent.fix) {
      const diagnosis = diagnoseSquareFile(context.squarePath);
      if (diagnosis.unfixable) {
        return {
          output: withPathOutput(context.squarePath, renderDoctorUnfixable(diagnosis.unfixable), { participantCount: inSquareCount(loadSquare(context.squarePath)) }),
          exitCode: 2,
        };
      }
      const summary = diagnosis.problems.length === 0 ? renderDoctorClean() : renderDoctorProblems(diagnosis.problems);
      return {
        output: withPathOutput(context.squarePath, summary, { participantCount: inSquareCount(loadSquare(context.squarePath)) }),
        exitCode: diagnosis.problems.length === 0 ? 0 : 1,
      };
    }
    const repair = await repairSquare(context.squarePath);
    if (repair.diagnosis.unfixable) {
      return {
        output: withPathOutput(context.squarePath, renderDoctorUnfixable(repair.diagnosis.unfixable), { participantCount: inSquareCount(loadSquare(context.squarePath)) }),
        exitCode: 2,
      };
    }
    const repaired = repair.repaired!;
    const registry = pruneRegistry(registryActs);
    if (registry.removed > 0) {
      repaired.actions.push({ message: `pruned ${registry.removed} obsolete registry membership(s)` });
    }
    const sidecar = quarantinePath(context.squarePath);
    return {
      output: withPathOutput(
        context.squarePath,
        renderDoctorRepaired(repaired.actions, repaired.quarantinedBlocks.length, repaired.quarantinedBlocks.length > 0 ? sidecar : undefined),
        { participantCount: inSquareCount(loadSquare(context.squarePath)) }
      ),
    };
  },
  present(result) {
    process.stdout.write(result.output);
    if (result.exitCode !== undefined) process.exit(result.exitCode);
  },
};
