import path from 'node:path';
import { once } from 'node:events';
import { runClaudeMod } from '../hosts/claude-mod.js';
import { runCodexHook, runCodexInterrupt } from '../hosts/codex-hook.js';
import { runCodexWatch } from '../hosts/codex-watch.js';
import { isSquareError } from '../core/model.js';
import { truncateChars } from '../core/neutral.js';
import type { ActivityId, StreamStart } from '../api/types.js';
import { quoteShell, spellAction } from '../surfaces/presentation.js';
import { inbox, PAGE_CAP, formatActivityId, parseActivityId } from '../api/square-api.js';
import { type CommandSpec, withSquare, squareInput, fail, parseBoundedLimit, parseNonNegativeInteger, readStdin, requireSquarePath, requireValue, usage } from './context.js';

interface StreamIntent { ndjson: boolean; forName?: string; start: StreamStart; }

export const streamCommand: CommandSpec<StreamIntent> = {
  parse(argv, context) {
    let ndjson = false;
    let forName: string | undefined;
    let last = 10;
    let after: ActivityId | undefined;
    let hasLast = false;
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '--ndjson') ndjson = true;
      else if (argv[index] === '--for') {
        forName = requireValue(argv, index, argv[index]);
        index += 1;
      } else if (argv[index] === '--last') {
        if (after !== undefined) fail('Invalid stream options: --last and --after cannot be combined.');
        last = parseNonNegativeInteger(requireValue(argv, index, argv[index]), '--last');
        if (last > PAGE_CAP) fail(`Invalid --last: maximum is ${PAGE_CAP}.`);
        hasLast = true;
        index += 1;
      } else if (argv[index] === '--after') {
        if (hasLast) fail('Invalid stream options: --last and --after cannot be combined.');
        const cursor = parseActivityId(requireValue(argv, index, argv[index]));
        if (cursor === undefined) fail('Invalid --after: expected an activity id like act/12');
        after = formatActivityId(cursor);
        index += 1;
      } else usage(context.command);
    }
    if (!ndjson && argv.length > 0) usage(context.command);
    return { ndjson, forName, start: after === undefined ? { kind: 'tail', last } : { kind: 'after', after } };
  },
  async execute(intent, context) {
    const squarePath = requireSquarePath(context);
    if (!intent.ndjson) {
      process.stderr.write(`✕ interactive stream was removed\nsquare --location ${quoteShell(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(squarePath) ? squarePath : path.resolve(context.cwd, squarePath))} stream --ndjson\n`);
      process.exitCode = 2;
      return;
    }
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once('SIGINT', interrupt);
    try {
      await withSquare(context, async (square) => {
        for await (const record of square.stream({ recipient: intent.forName, start: intent.start }, { signal: controller.signal })) {
          if (!process.stdout.write(`${JSON.stringify(record)}\n`)) await once(process.stdout, 'drain', { signal: controller.signal });
        }
      }, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) process.exitCode = 130;
      else if (isSquareError(error) && error.code === 'unavailable') {
        process.stderr.write(`square not found: ${squarePath}\n`);
        process.exitCode = 2;
      } else throw error;
    } finally { process.off('SIGINT', interrupt); }
  },
  present: () => {},
};

const INBOX_DEFAULT_LIMIT = 20;
const INBOX_DISPLAY_CHARS = 160;

function inboxDisplay(value: string): string {
  const truncated = truncateChars(value, INBOX_DISPLAY_CHARS - 1);
  return truncated.remaining === 0 ? truncated.text : `${truncated.text}…`;
}

interface InboxIntent { owner: string; limit: number; }
export const inboxCommand: CommandSpec<InboxIntent, string> = {
  parse(argv, context) {
    let owner: string | undefined;
    let limitValue: string | undefined;
    let hasLimit = false;
    let duplicateLimit = false;
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '--for-owner') { owner = requireValue(argv, index, argv[index]); index += 1; }
      else if (argv[index] === '--limit') {
        if (hasLimit) duplicateLimit = true;
        hasLimit = true;
        const value = argv[index + 1];
        if (value !== undefined && !value.startsWith('--')) { limitValue = value; index += 1; }
      }
      else usage(context.command);
    }
    if (!owner) fail('inbox requires --for-owner <owner>.');
    const retry = spellAction({ operation: 'inbox', args: { forOwner: owner, limit: PAGE_CAP } });
    if (duplicateLimit) fail(`✕ inbox accepts one --limit\n${retry}`);
    const limit = hasLimit ? parseBoundedLimit(limitValue, '--limit', PAGE_CAP, retry) : INBOX_DEFAULT_LIMIT;
    return { owner, limit };
  },
  async execute(intent, context) {
    const data = await inbox(squareInput(context), intent.owner, { limit: intent.limit });
    return [
      ...data.rows.map((row) => `${inboxDisplay(row.name)}\t${inboxDisplay(row.squarePath)}\t${row.pending}\n`),
      ...(data.rows.length < data.total ? [`${data.rows.length} of ${data.total} memberships shown\n`] : []),
    ].join('');
  },
  present: (result) => process.stdout.write(result),
};

function hookCommand(runHook: (input: string) => Promise<unknown>): CommandSpec<undefined, void> {
  return {
    parse(argv, context) { if (argv.length > 0) usage(context.command); return undefined; },
    async execute() { await runHook(await readStdin()); },
    present: () => {},
  };
}

export const claudeModCommand = hookCommand(input => runClaudeMod(input, process.env));
export const codexHookCommand = hookCommand(input => runCodexHook(input, process.env, text => new Promise<void>((resolve, reject) => {
  process.stdout.write(text, error => error ? reject(error) : resolve());
})));
export const codexWatchCommand = hookCommand(input => runCodexWatch(input, process.env));
export const codexInterruptCommand = hookCommand(input => runCodexInterrupt(input, process.env));
