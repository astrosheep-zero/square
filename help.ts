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
  {
    names: ['build'], usage: 'build [--cap <N|unlimited>] [--template <name>] [--throttle N] [-f] < body.md', usesSquare: true, group: 'host',
    summary: 'Create a square from Markdown on stdin.',
    details: ['Options:', '  --cap <N|unlimited>  Set a per-participant activity cap (default unlimited).', '  --template <name>    Append a packaged activity guide.', '  --throttle <N>       Allow at most N public activities per minute.', '  -f, --force          Replace an existing artifact.'],
  },
  {
    names: ['list', 'ls'], usage: '{command} [--depth N]', summary: 'List nearby squares below the current directory.', group: 'host',
    details: ['Options:', '  --depth <N>  Descend through at most N directory levels (default 4; 0 scans only the current directory).'],
  },
  {
    names: ['join'], usage: '--as <name> join [--last N] [--kick]', usesSquare: true, group: 'participant',
    summary: 'Step into the square and read its current context.',
    details: ['Options:', '  --last <N>  Show the last N public activities (default 10, maximum 100).'],
  },
  {
    names: ['express'], usage: '--as <name> express [-f|--force] [--no-wait] (--mention <name>... | --no-mention | --bell) [--reply <activity-id>] <activity | ->', usesSquare: true, group: 'participant',
    summary: 'Speak, gesture, or do both.',
    details: ['Reach:', '  --mention <name>  Address one participant; repeat for multiple participants. The body stays unchanged.', '  --no-mention      Land a bare activity explicitly; listen opts someone into future bare delivery.', "  --bell            Call every participant's attention to this activity.", '', 'Options:', '  -f, --force       Express without first catching unread activity or attention etiquette.', '  --no-wait         If held or throttled, save a draft and return.', '  --reply <activity-id>   Mark this activity as a reply to an earlier activity (for example act/12).'],
  },
  { names: ['listen'], usage: '--as <name> listen <participant>', usesSquare: true, group: 'participant', summary: 'Turn an ear toward one participant\'s future bare says.' },
  { names: ['ignore'], usage: '--as <name> ignore <participant>', usesSquare: true, group: 'participant', summary: 'Ignore one participant\'s future mentions and bare says.' },
  { names: ['listening'], usage: '--as <name> listening', usesSquare: true, group: 'participant', summary: 'Show who you are turned toward.', details: ['Listening is future-only: the edge is fixed when a say lands; it never rewrites history.'] },
  {
    names: ['catch'], usage: '--as <name> catch (--now | --idle <duration>) [--from <names>] [--mention [name]] [--replace]', usesSquare: true, group: 'participant',
    summary: 'Catch directed conversation since you last looked.',
    details: ['Modes:', '  --now             Catch up immediately.', '  --idle <duration> Wait for something relevant, or for quiet to last this long.', '', 'Attention:', '  Mentions arrive when you are addressed; bells arrive for everyone; bare says require listen.', '  listen and ignore are future-only and fixed when each say lands.', '', 'Filters:', '  --from <names>    Match only comma-separated participants.', '  --mention [name]  Match direct attention for a name, or your own name when omitted.', '', 'Recovery:', '  --replace         Replace another active catch for this participant.'],
  },
  { names: ['done'], usage: '--as <name> done [final | -]', usesSquare: true, group: 'participant', summary: 'Step out, optionally leaving a final note.' },
  {
    names: ['stream'], usage: 'stream [--ndjson [--for <name>]]', usesSquare: true, hiddenFromIndex: true,
    summary: 'Follow activity without consuming participant presence.',
    details: ['Options:', '  --ndjson       Emit one JSON event per line.', '  --for <name>   With --ndjson, emit notifications for one participant.'],
  },
  {
    names: ['inbox'], usage: 'inbox --for-session <session-id> [--json]', hiddenFromIndex: true,
    summary: 'Inspect bounded machine-local notifications for a native session.',
    details: ['Options:', '  --for-session <id>  Required harness session id.', '  --json              Emit structured JSON.'],
  },
  { names: ['claude-hook', 'codex-hook'], usage: '{command}', summary: 'Present pending attention at one native agent boundary.', hiddenFromIndex: true },
  {
    names: ['history'], usage: 'history [filters] [output]', usesSquare: true, group: 'participant',
    summary: 'Read or search the archive without changing what you have caught.',
    details: ['Filters:', '  --from <names>                  Match activities from participants.', '  --since <time>                  Match activities after a time.', '  --grep <regex> | --fixed <s>    Search activity ids, participants, and original bodies.', '  --mention <name>                Match direct attention for a participant.', '  --at <ids>                      Center on comma-separated activity ids; may repeat.', '  -B, -A, -C <N>                 Set non-negative context around every --at coordinate.', '  --before <id>                   Read the page immediately before an activity.', '  --after <id>                    Read the page immediately after an activity.', '', 'Results:', '  --limit <N>                     Page size (default 10, maximum 100).', '  --order <asc|desc>              Set display order (default oldest first).', '', 'Output:', '  --no-truncate  --json  --format <fields>', '  One result shows its full body; multiple results use previews.', '  --no-truncate shows every original body.'],
  },
  { names: ['status'], usage: '[--as <name>] status', usesSquare: true, group: 'participant', summary: 'Show who is present and what happened most recently.' },
  {
    names: ['participants'], usage: 'participants [--limit <count>]', usesSquare: true, group: 'host',
    summary: 'Show the participant roster and current states.',
    details: ['Options:', '  --limit <count>  Show the first count names in roster order (default 20, maximum 100).'],
  },
  { names: ['hold'], usage: '--as <name> hold [reason | -]', usesSquare: true, group: 'participant', summary: 'Raise a hand and pause participant activity.' },
  { names: ['resume'], usage: '--as <name> resume', usesSquare: true, group: 'participant', summary: 'Lower the raised hand and resume activity.' },
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
    details: ['Targets:', '  claude, codex, opencode, pi  Diagnose one installed adapter.', '  delivery                      Diagnose delivery for the selected square.'],
  },
  {
    names: ['doctor'], usage: 'doctor', usesSquare: true, group: 'maintenance',
    summary: 'Validate binary artifact integrity.',
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
    { key: 'participant', title: 'In the square:', order: ['join', 'express', 'listen', 'ignore', 'listening', 'catch', 'history', 'status', 'hold', 'resume', 'done'] },
    { key: 'host', title: 'Prepare and manage:', order: ['build', 'list', 'participants'] },
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
    'Usage: square [--location <square>] [--as <name>] <command> [args...]',
    'Environment: SQUARE_LOCATION sets the CLI location; square-accessing commands require it or --location. SQUARE_PARTICIPANT_NAME sets the participant name.',
    'CLI flags override environment values. Automatic provider sessions use only .square/PUBLIC.square.',
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
  const usage = definition.usage.replace('{command}', command);
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
    "Run 'square help' to list available commands.",
    '',
  ].join('\n');
}

export function helpRequest(rawArgs: string[]): { command?: string } | undefined {
  const args: string[] = [];
  let hasExplicitName = false;
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (arg === '--location' || arg === '--as') {
      const value = rawArgs[index + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      if (arg === '--as') hasExplicitName = true;
      index++;
      continue;
    }
    args.push(arg);
  }

  if (hasExplicitName && args[0] === 'history') return undefined;

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
    : "Run 'square help' to list commands.\n";
}
