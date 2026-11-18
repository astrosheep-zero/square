import {
  deliveryLedgerLocation, muteDeliveryLedger, selectOwnSeat, unmuteDeliveryLedger,
} from '../square-api.js';
import { renderMuteResult } from '../operation-presentation.js';
import { jsonResult } from './json.js';
import {
  type CommandContext, type CommandSpec,
  commandClock, commandIdentity, parseDurationMs, requireSquarePath, usage, withSquare,
} from './context.js';

function plainArgs(argv: string[], context: CommandContext): string[] {
  const args = argv.filter((arg) => arg !== '--json');
  if (args.some((arg) => arg.startsWith('--'))) usage(context.command);
  return args;
}

export const muteCommand: CommandSpec<{ durationMs: number }, string> = {
  parse(argv, context) {
    const args = plainArgs(argv, context);
    if (args.length !== 1) usage(context.command);
    return { durationMs: parseDurationMs(args[0], 'duration') };
  },
  async execute(intent, context) {
    if (context.squarePath === undefined) {
      const data = await muteDeliveryLedger({ durationMs: intent.durationMs,
        ledgerLocation: deliveryLedgerLocation(context.env, context.homeDir), clock: commandClock(context) });
      return context.json ? jsonResult(data) : renderMuteResult(undefined, 'mute', data);
    }
    const squarePath = requireSquarePath(context);
    const data = await withSquare(context, async (square) => (await selectOwnSeat(square,
      commandIdentity(context.env, context.owner).owner, context.name)).mute({ durationMs: intent.durationMs },
      context.json ? {} : { observe: true }));
    return context.json ? jsonResult(data) : renderMuteResult(squarePath, 'mute', data);
  },
  present: (result) => process.stdout.write(result),
};

export const unmuteCommand: CommandSpec<undefined, string> = {
  parse(argv, context) {
    if (plainArgs(argv, context).length !== 0) usage(context.command);
    return undefined;
  },
  async execute(_intent, context) {
    if (context.squarePath === undefined) {
      const data = await unmuteDeliveryLedger({ ledgerLocation: deliveryLedgerLocation(context.env, context.homeDir),
        clock: commandClock(context) });
      return context.json ? jsonResult(data) : renderMuteResult(undefined, 'unmute', data);
    }
    const squarePath = requireSquarePath(context);
    const data = await withSquare(context, async (square) => (await selectOwnSeat(square,
      commandIdentity(context.env, context.owner).owner, context.name)).unmute(context.json ? {} : { observe: true }));
    return context.json ? jsonResult(data) : renderMuteResult(squarePath, 'unmute', data);
  },
  present: (result) => process.stdout.write(result),
};
