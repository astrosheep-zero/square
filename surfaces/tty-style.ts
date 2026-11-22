export type StyleRole = 'blocked' | 'release' | 'changed' | 'dim' | 'match';

const PALETTE: Record<StyleRole, string> = {
  blocked: '\x1b[38;5;203m',
  release: '\x1b[38;5;114m',
  changed: '\x1b[38;5;179m',
  dim: '\x1b[38;5;244m',
  match: '\x1b[38;5;222m\x1b[1m',
};

export function style(
  role: StyleRole,
  text: string,
  opts: { stream?: { isTTY?: boolean }; env?: NodeJS.ProcessEnv } = {}
): string {
  if (!(opts.stream ?? process.stdout).isTTY || (opts.env ?? process.env).NO_COLOR !== undefined || text === '') {
    return text;
  }
  return `${PALETTE[role]}${text}\x1b[0m`;
}
