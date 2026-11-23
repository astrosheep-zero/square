import { CLI_OPERATIONS } from '../surfaces/operations.js';

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
    names: ['migrate'], usage: 'migrate', usesSquare: true, group: 'maintenance',
    summary: 'Explicitly upgrade one offline Format12 artifact to Format13.',
    details: ['Stop all old writers first. Uses only the artifact; never opens or upgrades the host delivery ledger.', 'Format13 is fully validated read-only and left unchanged. Other versions are refused.', 'Usage: square --location ./example.square migrate'],
  },
  { names: ['doctor'], usage: 'doctor', usesSquare: true, group: 'maintenance', summary: 'Validate artifact integrity.' },
  ...CLI_OPERATIONS.map(({ fields, names, summary, operation }) => {
    const coordinates = ['location', 'as'].flatMap(key => fields.filter(field => field.key === key));
    const options = [...fields.filter(field => !coordinates.includes(field) && !field.positional), ...fields.filter(field => field.positional)];
    const usage = (field: typeof fields[number], separator: string) => {
      const flags = field.positional ? '' : [field.short, field.flag].filter(Boolean).join(separator);
      return [flags, field.kind === 'boolean' ? '' : `<${field.value}>${field.kind === 'array' ? '...' : ''}`].filter(Boolean).join(' ');
    };
    const slot = (field: typeof fields[number]) => field.required ? usage(field, '|') : `[${usage(field, '|')}]`;
    return { names, summary, group: operation.group, usage: [...coordinates.map(slot), '{command}', ...options.map(slot)].join(' '),
      details: ['Options:', ...[...coordinates, ...options].map(field => `  ${usage(field, ', ')}  ${field.schema.description ?? ''}`)] };
  }),
];

function definitionFor(command: string): CommandHelp | undefined {
  return COMMANDS.find(item => item.names.includes(command));
}

function isHelpFlag(value: string): boolean { return value === '--help' || value === '-h'; }

export function renderGlobalHelp(): string {
  const groups = { participant: 'In the square:', host: 'Prepare and manage:', maintenance: 'Setup:' } as const;
  return [
    'Usage: square [--location <square>] [--as <name>] [--owner <id>] <command> [args...]',
    'Location: square-accessing commands require --location <square>. Use square list to find nearby squares and your joined names; use --as to select a participant.',
    '', ...Object.entries(groups).flatMap(([group, title]) => [title, ...COMMANDS
      .filter(item => item.group === group && !item.hiddenFromIndex)
      .map(item => `  ${item.names[0]}\n      ${item.summary}`), '']),
    "Run 'square <command> --help' for command options.", '',
  ].join('\n');
}

export function renderSubcommandHelp(command: string): string | undefined {
  const definition = definitionFor(command);
  if (definition === undefined) return undefined;
  const aliases = definition.names.filter(name => name !== command);
  return [
    `Usage: square ${definition.usesSquare ? '[--location <square>] ' : ''}${definition.usage.replace('{command}', command)}`,
    ...(aliases.length > 0 ? [`Aliases: ${aliases.join(', ')}`] : []),
    '', definition.summary, ...(definition.details === undefined ? [] : ['', ...definition.details]),
    '', 'Help:', '  -h, --help  Show this command help.',
    '', "Run 'square --help' to list available commands.", '',
  ].join('\n');
}

export function helpRequest(rawArgs: string[]): { command?: string } | undefined {
  const args: string[] = [];
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (arg === '--') break;
    if (arg === '--location' || arg === '--as' || arg === '--owner') {
      const value = rawArgs[++index];
      if (value === undefined || value.startsWith('--')) return undefined;
    } else args.push(arg);
  }
  if (isHelpFlag(args[0])) return {};
  if (args[0] === 'help') {
    if (args.length === 1) return {};
    if (args.length === 2) return { command: isHelpFlag(args[1]) ? 'help' : args[1] };
    return undefined;
  }
  if (args.length > 1 && args.slice(1).some(isHelpFlag)) return { command: args[0] };
}

export function commandUsageHint(command: string | undefined): string {
  return command !== undefined && definitionFor(command) !== undefined
    ? `Run 'square ${command} --help' for usage.\n`
    : "Run 'square --help' to list available commands.\n";
}
