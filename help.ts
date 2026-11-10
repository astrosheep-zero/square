import { JSON_COMMANDS } from './cli/json.js';

interface CommandHelp {
  names: readonly string[];
  usage: string;
  summary: string;
  group?: 'participant' | 'host' | 'maintenance';
  usesSquare?: boolean;
  details?: readonly string[];
  hiddenFromIndex?: boolean;
}

const COMMANDS: readonly CommandHelp[] = [
  { names: ['help'], usage: 'help [command]', summary: 'Show the command index or help for one command.' },
  { names: ['version'], usage: 'version', summary: 'Print the installed version.', hiddenFromIndex: true },
  { names: ['mcp-server'], usage: 'mcp-server', summary: 'Start the MCP stdio server.', hiddenFromIndex: true, details: ['Use list to find nearby squares; single-square tools require location on each call.', 'Participant tools accept as on each call; join requires an explicit name.', 'Session identity comes from request _meta.threadId (Codex) or _meta["ai.opencode/sessionID"] (OpenCode), falling back to the startup environment.'] },
  {
    names: ['build'], usage: 'build [--cap <N|unlimited>] [--template <name>] [--throttle N] [-f] < body.md', usesSquare: true, group: 'host',
    summary: 'Create a square from Markdown on stdin.',
    details: ['Options:', '  --cap <N|unlimited>  Set a per-participant activity cap (default unlimited).', '  --template <name>    Append a packaged activity guide.', '  --throttle <N>       Allow at most N public activities per minute.', '  -f, --force          Replace an existing artifact.'],
  },
  {
    names: ['list', 'ls'], usage: '{command} [--depth N] [--limit N] [--after path]', summary: 'List nearby squares and your joined names with waiting activity counts.', group: 'host',
    details: ['Options:', '  --depth <N>    Descend through at most N directory levels (default 4; maximum 16; 0 scans only the current directory).', '  --limit <N>    Show one page (default 20, maximum 100).', '  --after <path> Resume after a relative path from a previous page.'],
  },
  {
    names: ['join'], usage: '--as <name> join [--last N] [--takeover]', usesSquare: true, group: 'participant',
    summary: 'Step into the square and read its current context.',
    details: ['Options:', '  --last <N>  Show the last N public activities (default 10, maximum 100).', '  --takeover  End the standing participant and reclaim the name for this session.'],
  },
  {
    names: ['express'], usage: '--as <name> express [-f|--force] [--no-wait] [--metadata <json>] [--mention <name>... | --bell] [--no-mention] [--reply <activity-id>] [<activity> | -]', usesSquare: true, group: 'participant',
    summary: 'Speak, gesture, or do both.',
    details: [
      'Reach:',
      '  --mention <name>  Address one standing participant; repeat to address more.',
      '  @name             Also address a standing participant named in the body; `backticks` keep @text literal.',
      "  --bell            Call everyone; body @names stay literal. Cannot combine with --mention.",
      '  --no-mention      Keep body @names literal; explicit --mention and --reply still apply.',
      '  --reply <activity-id>   Also reach the author of an earlier activity (for example act/12).',
      '  Address with --mention, --bell, --reply, or a standing @name in the body. Otherwise the activity lands bare; unmatched @names stay literal, with a notice.',
      '  Bare activities are delivered only to participants listening to the sender.',
      '',
      'Options:',
      '  -f, --force       Express without first perceiving unread activity or satisfying attention etiquette.',
      '  --no-wait         If throttled, save a draft and return instead of waiting.',
      '  --metadata <json> Attach a bounded JSON object (at most 16 KiB UTF-8 and 256 nesting levels); it may be the only content.',
      '                    Metadata is returned in structured activity results but is not shown in human text or searchable.',
    ],
  },
  { names: ['listen'], usage: '--as <name> listen <participant>', usesSquare: true, group: 'participant', summary: 'Turn an ear toward one participant\'s future activity.' },
  { names: ['unlisten'], usage: '--as <name> unlisten <participant>', usesSquare: true, group: 'participant', summary: 'Stop listening without blocking that participant\'s mentions or replies.' },
  { names: ['ignore'], usage: '--as <name> ignore <participant>', usesSquare: true, group: 'participant', summary: 'Stop hearing one participant\'s future activity, except bells.' },
  {
    names: ['perceive'], usage: '--as <name> perceive [--id <activity-id>] [--idle <duration>] [--from <names>] [--mention] [--limit <count>] [--takeover]', usesSquare: true, group: 'participant',
    summary: 'Perceive directed conversation since you last looked.',
    details: ['Modes:', '  --id <activity-id> Open one activity addressed to you in full; repeats work. Use it alone.', '  --idle <duration> Wait for something relevant, or for quiet to last this long.', '', 'Attention:', '  Mentions arrive when you are addressed; bells arrive for everyone; bare says require listen.', '  listen and ignore are future-only and fixed when each say lands.', '', 'Filters:', '  --from <names>    Match only comma-separated participants.', '  --mention         Match direct attention for your current participant (and bells).', '  --limit <count>   Return one page (default 10, maximum 100).', '', 'Recovery:', '  --takeover        Take over from another active perceive for this participant.'],
  },
  { names: ['done'], usage: '--as <name> done', usesSquare: true, group: 'participant', summary: 'Step out of the square.', details: ['done takes no message. Use express before leaving to send one.'] },
  {
    names: ['stream'], usage: 'stream [--ndjson [--for <name>] [--last <N> | --after <id>]]', usesSquare: true, hiddenFromIndex: true,
    summary: 'Follow activity without marking it perceived.',
    details: ['Options:', '  --ndjson       Emit one JSON event per line.', '  --for <name>   With --ndjson, emit notifications for one participant.', '  --last <N>     Emit the last N eligible activities first (default 10, maximum 100).', '  --after <id>   Resume after a canonical activity id (act/12).'],
  },
  {
    names: ['inbox'], usage: 'inbox --for-owner <owner> [--limit <N>]', hiddenFromIndex: true,
    summary: 'Inspect a bounded machine-local notification snapshot for a native session.',
    details: ['Options:', '  --for-owner <id>    Required opaque owner.', '  --limit <N>         Snapshot memberships (default 20, maximum 100).'],
  },
  { names: ['codex-hook'], usage: '{command}', summary: 'Present pending attention at one native agent boundary.', hiddenFromIndex: true },
  { names: ['codex-watch'], usage: '{command}', summary: 'Observe pending attention from a native async Stop hook.', hiddenFromIndex: true },
  { names: ['codex-interrupt'], usage: '{command}', summary: 'Cancel pending attention at a native Interrupt boundary.', hiddenFromIndex: true },
  { names: ['claude-mod'], usage: '{command}', summary: 'Run the Claude mod delivery helper.', hiddenFromIndex: true },
  {
    names: ['history'], usage: 'history [filters] [output]', usesSquare: true, group: 'participant',
    summary: 'Read or search the archive without changing what you have perceived.',
    details: ['Filters:', '  --from <names>                  Match activities from participants.', '  --since <time>                  Match activities after a time.', '  --search <text> [--regex]      Search ids, participants, and original bodies; literal by default.', '  --mention <name>                Match direct attention for a participant.', '  --at <ids>                      Center on comma-separated activity ids; may repeat.', '  -C <N>                         Set symmetric context around every --at coordinate.', '  --before <id>                   Read the page immediately before an activity.', '  --after <id>                    Read the page immediately after an activity.', '', 'Results:', '  --limit <N>                     Page size (default 10, maximum 100).', '  --order <asc|desc>              Set display order (default oldest first).', '', 'Output:', '  --full  --json  --format <fields>', '  One result shows its full body; multiple results use previews.', '  --full shows every original body.'],
  },
  { names: ['status'], usage: '[--as <name>] status', usesSquare: true, group: 'participant', summary: 'Show who is present and what happened most recently.' },
  {
    names: ['install'], usage: 'install (--all | <target>...) [-f]', group: 'maintenance',
    summary: 'Install Square support for one or more agent hosts.',
    details: ['Targets:', '  claude, codex, opencode, pi', '', 'Options:', '  --all       Install every supported target.', '  -f, --force Replace existing managed links.'],
  },
  {
    names: ['uninstall'], usage: 'uninstall (--all | <target>...)', group: 'maintenance',
    summary: 'Remove Square support from one or more agent hosts.',
    details: ['Targets:', '  claude, codex, opencode, pi', '', 'Options:', '  --all  Remove every supported target.'],
  },
  {
    names: ['harness'], usage: 'harness doctor [claude|codex|opencode|pi|delivery]', usesSquare: true, group: 'maintenance', hiddenFromIndex: true,
    summary: 'Diagnose installed agent-host support.',
    details: ['Targets:', '  claude, codex, opencode, pi  Diagnose one installed adapter.', '  delivery                      Diagnose pending delivery and recent wake-release reasons for the selected square.'],
  },
  {
    names: ['doctor'], usage: 'doctor', usesSquare: true, group: 'maintenance',
    summary: 'Validate artifact integrity.',
  },
];

function definitionFor(command: string): CommandHelp | undefined {
  return COMMANDS.find((item) => item.names.includes(command));
}

function isHelpFlag(value: string): boolean {
  return value === '--help' || value === '-h';
}

export function renderGlobalHelp(): string {
  const groups: ReadonlyArray<{ key: NonNullable<CommandHelp['group']>; title: string; order: readonly string[] }> = [
    { key: 'participant', title: 'In the square:', order: ['join', 'express', 'listen', 'unlisten', 'ignore', 'perceive', 'history', 'status', 'done'] },
    { key: 'host', title: 'Prepare and manage:', order: ['build', 'list'] },
    { key: 'maintenance', title: 'Setup:', order: ['install', 'uninstall', 'doctor'] },
  ];
  const commandLines = groups.flatMap(({ key, title, order }) => [
    title,
    ...COMMANDS
      .filter((item) => item.group === key && item.hiddenFromIndex !== true)
      .sort((left, right) => order.indexOf(left.names[0]) - order.indexOf(right.names[0]))
      .map((item) => `  ${item.names[0]}\n      ${item.summary}`),
    '',
  ]);
  return [
    'Usage: square [--location <square>] [--as <name>] [--owner <id>] <command> [args...]',
    'Location: square-accessing commands require --location <square>. Use square list to find nearby squares and your joined names; use --as to select a participant.',
    'Identity: --owner overrides SQUARE_OWNER, then a complete harness identity, then user:<OS user>@<host>. Incomplete or ambiguous harness identities refuse. Owners without wake use perceive --idle.',
    'Output: --json on join, express, perceive, history, listen, ignore, unlisten, done, status and inbox prints the SDK result without observation; a participant handle becomes {name}.',
    'History emits one JSON document; stream --ndjson emits one SDK record per line.',
    '',
    ...commandLines,
    "Run 'square <command> --help' for command options.",
    '',
  ].join('\n');
}

export function renderSubcommandHelp(command: string): string | undefined {
  const definition = definitionFor(command);
  if (definition === undefined) return undefined;
  const aliases = definition.names.filter((name) => name !== command);
  const usage = definition.usage.replace('{command}', command) + (JSON_COMMANDS.has(command) ? ' [--json]' : '');
  return [
    `Usage: square ${definition.usesSquare ? '[--location <square>] ' : ''}${usage}`,
    ...(aliases.length > 0 ? [`Aliases: ${aliases.join(', ')}`] : []),
    '',
    definition.summary,
    ...(definition.details === undefined ? [] : ['', ...definition.details]),
    '',
    'Help:',
    '  -h, --help  Show this command help.',
    '',
    "Run 'square --help' to list available commands.",
    '',
  ].join('\n');
}

export function helpRequest(rawArgs: string[]): { command?: string } | undefined {
  const args: string[] = [];
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (arg === '--location' || arg === '--as' || arg === '--owner') {
      const value = rawArgs[index + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      index++;
      continue;
    }
    args.push(arg);
  }

  if (isHelpFlag(args[0])) return {};
  if (args[0] === 'help') {
    if (args.length === 1) return {};
    if (args.length === 2) return { command: isHelpFlag(args[1]) ? 'help' : args[1] };
    return undefined;
  }
  if (args.length > 1 && args.slice(1).some(isHelpFlag)) return { command: args[0] };
  return undefined;
}

export function commandUsageHint(command: string | undefined): string {
  return command !== undefined && definitionFor(command) !== undefined
    ? `Run 'square ${command} --help' for usage.\n`
    : "Run 'square --help' to list commands.\n";
}
