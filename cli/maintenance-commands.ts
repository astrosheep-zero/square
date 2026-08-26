import { diagnoseSquareFile } from '../square-storage.js';
import { renderDoctorClean, renderDoctorUnfixable, withPathOutput } from '../presentation.js';
import { inSquareCount } from '../runtime.js';

import { requireSquarePath, type CommandSpec, usage } from './context.js';

interface DoctorResult {
  output: string;
  exitCode?: number;
}

export const doctorCommand: CommandSpec<undefined, DoctorResult> = {
  parse(argv, context) {
    if (argv.length > 0) usage(context.command);
    return undefined;
  },
  async execute(_intent, context) {
    const squarePath = requireSquarePath(context);
    const diagnosis = await diagnoseSquareFile(squarePath);
    if (diagnosis.unfixable !== undefined || diagnosis.state === undefined) {
      return {
        output: withPathOutput(
          squarePath,
          renderDoctorUnfixable(diagnosis.unfixable ?? 'the snapshot could not be decoded'),
        ),
        exitCode: 2,
      };
    }
    return {
      output: withPathOutput(squarePath, renderDoctorClean(), {
        participantCount: inSquareCount(diagnosis.state),
      }),
    };
  },
  present(result) {
    process.stdout.write(result.output);
    if (result.exitCode !== undefined) process.exit(result.exitCode);
  },
};
