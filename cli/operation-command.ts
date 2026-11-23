import * as api from '../api/square-api.js';
import { issueText } from '../core/operation-inputs.js';
import type { CLI_OPERATIONS, Input, OperationBinding } from '../surfaces/operations.js';
import { spellAction } from '../surfaces/presentation.js';
import { operationText } from '../surfaces/operation-presentation.js';
import { type CommandSpec, commandClock, commandIdentity, fail, readStdin } from './context.js';
import { expressFromCli } from './express-presentation.js';

type CliOperation = typeof CLI_OPERATIONS[number];
function unknownOption(command: string, option: string): never {
  fail(`✕ ${command} does not know ${option}\nsquare ${command} --help`);
}

export function operationCommand({ operation, fields, fixed }: CliOperation): CommandSpec<Input, string> {
  const positional = fields.find(field => field.positional);
  const options = fields.filter(field => field !== positional && field.key !== 'location' && field.key !== 'as');
  return {
    parse(argv, context) {
      const input: Input = { ...fixed };
      if (context.squarePath !== undefined && operation.cliSchema.shape.location) input.location = context.squarePath;
      if (context.name !== undefined && operation.cliSchema.shape.as) input.as = context.name;
      const refuse = (message: string) => fail(`✕ ${message}\nsquare ${context.command} --help`);
      let literal = false;
      for (let index = 0; index < argv.length; index++) {
        const word = argv[index];
        if (!literal && word === '--') { literal = true; continue; }
        const equals = word.indexOf('=');
        const flag = equals < 0 ? word : word.slice(0, equals);
        const field = literal ? undefined : options.find(field => field.flag === flag || field.short === flag);
        if (field === undefined) {
          if (!literal && word.startsWith('-') && word !== '-') unknownOption(context.command, word);
          if (positional === undefined || Object.hasOwn(input, positional.key)) refuse(`${context.command} does not know ${word}`);
          input[positional!.key] = word;
          continue;
        }
        if (field.once && Object.hasOwn(input, field.key)) refuse(`${context.command} accepts one ${flag}`);
        if (field.kind === 'boolean' && equals < 0) { input[field.key] = true; continue; }
        const value = equals < 0 ? argv[++index] : word.slice(equals + 1);
        if (value === undefined || (equals < 0 && (value.startsWith('--') || options.some(field => field.short === value))))
          refuse(`missing value for ${flag}`);
        if (field.kind === 'array') {
          const values = field.split?.(value) ?? value.split(',');
          if (values.length === 0 && !field.repeat) refuse(`${flag} needs at least one value`);
          input[field.key] = [...(input[field.key] as string[] | undefined ?? []), ...values];
        } else input[field.key] = field.kind === 'number' && /^-?\d+$/.test(value) ? Number(value) : value;
      }
      operation.prepare?.(input, process.stdin.isTTY === true);
      return input;
    },
    async execute(input, context) {
      const binding: OperationBinding = { api, surface: 'cli', text: operationText, expressFromCli, cwd: context.cwd,
        stdin: { tty: process.stdin.isTTY === true, read: readStdin },
        identity: () => commandIdentity(context.env, context.owner), clock: () => commandClock(context)(),
        ledgerLocation: api.deliveryLedgerLocation(context.env, context.homeDir), ownerFlag: context.owner ?? context.env.SQUARE_OWNER,
        exit: code => { process.exitCode = code; }, progress: text => { process.stderr.write(`${text}\n`); } };
      const parsed = operation.cliSchema.safeParse(input);
      if (!parsed.success) {
        const message = issueText(parsed.error);
        if (parsed.error.issues.some(issue => issue.path[0] === 'location'))
          fail(`${message}\n✕ ${context.command} needs a square location\n${spellAction({ operation: 'ls' })}`);
        const recovery = operation.invalid?.(input, parsed.error, binding);
        if (recovery !== undefined) return recovery;
        fail(message);
      }
      // Keep the caller's option order in CLI continuations; only the validated values run.
      const args = { ...input, ...parsed.data };
      if (operation.interrupted === undefined) return operation.run(binding, args, {});
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.once('SIGINT', interrupt);
      try { return await operation.run(binding, args, { signal: controller.signal }); }
      catch (error) {
        if (!controller.signal.aborted) throw error;
        process.exitCode = 130;
        return operation.interrupted(context.squarePath!, binding.text);
      } finally { process.off('SIGINT', interrupt); }
    },
    present(result) { if (result !== '') process.stdout.write(result); },
  };
}
