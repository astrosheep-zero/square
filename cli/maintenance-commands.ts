import { diagnoseSquare, migrateSquare } from '../square-api.js';
import { commandPrefix, renderDoctorClean, renderDoctorUnfixable, withPathOutput } from '../presentation.js';

import { requireSquarePath, squareInput, type CommandSpec, usage } from './context.js';

interface DoctorResult {
  output: string;
  exitCode?: number;
}

interface MigrateResult {
  output: string;
}

export const migrateCommand: CommandSpec<undefined, MigrateResult> = {
  parse(argv, context) {
    if (argv.length > 0) usage(context.command);
    return undefined;
  },
  async execute(_intent, context) {
    const squarePath = requireSquarePath(context);
    const outcome = await migrateSquare(squareInput(context));
    const body = outcome.status === 'migrated' && outcome.counts !== undefined
      ? [
        '✓ migrated to row storage',
        `  · ${outcome.counts.activities} activities · ${outcome.counts.receipts} receipts · ${outcome.counts.leases} leases · ${outcome.counts.routes} routes`,
      ].join('\n')
      : '· already format 2 — nothing changed';
    return { output: withPathOutput(squarePath, body, { participantCount: outcome.standing }) };
  },
  present(result) {
    process.stdout.write(result.output);
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
    if (diagnosis.migrationRequired !== undefined) {
      return { output: withPathOutput(squarePath, `${diagnosis.migrationRequired}\n${commandPrefix(squarePath)} migrate\n`), exitCode: 2 };
    }
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
