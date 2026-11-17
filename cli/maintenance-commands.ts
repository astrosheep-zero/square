import { diagnoseSquare, migrateSquare, type MigrateSquareResult } from '../square-api.js';
import { renderDoctorClean, renderDoctorUnfixable, withPathOutput } from '../presentation.js';

import { requireSquarePath, squareInput, type CommandSpec, usage } from './context.js';

interface DoctorResult {
  output: string;
  exitCode?: number;
}

export const migrateCommand: CommandSpec<undefined, MigrateSquareResult> = {
  parse(argv, context) {
    if (argv.length > 0) usage(context.command);
    return undefined;
  },
  execute(_intent, context) { return migrateSquare(squareInput(context)); },
  present(result) {
    process.stdout.write(`${result.location}\nformat ${result.fromVersion} → ${result.toVersion}${result.changed ? '' : ' (unchanged)'}\n`);
  },
};

export const doctorCommand: CommandSpec<undefined, DoctorResult> = {
  parse(argv, context) {
    if (argv.length > 0) usage(context.command);
    return undefined;
  },
  async execute(_intent, context) {
    const squarePath = requireSquarePath(context);
    const diagnosis = await diagnoseSquare(squareInput(context));
    if (diagnosis.unfixable !== undefined || diagnosis.standingCount === undefined) {
      return {
        output: withPathOutput(
          squarePath,
          renderDoctorUnfixable(diagnosis.unfixable ?? 'the artifact could not be decoded'),
        ),
        exitCode: 2,
      };
    }
    return {
      output: withPathOutput(squarePath, renderDoctorClean(), {
        participantCount: diagnosis.standingCount,
      }),
    };
  },
  present(result) {
    process.stdout.write(result.output);
    if (result.exitCode !== undefined) process.exit(result.exitCode);
  },
};
