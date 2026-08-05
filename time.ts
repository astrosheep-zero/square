function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function formatOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function formatTimestamp(at: number): string {
  const date = new Date(at);
  const time =
    date.getMilliseconds() !== 0
      ? `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
      : date.getSeconds() !== 0
        ? `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
        : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time,
    formatOffset(date),
  ].join(' ');
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return 'a while';
  if (ms < 1000) return `${Math.max(0, ms)}ms`;

  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function formatRelativeTime(at: number, now?: number): string {
  const diff = Math.max(0, (now ?? Date.now()) - at);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatTimestamp(at);
}

export function parseTimestamp(value: string): number {
  const trimmed = value.trim();
  const local = trimmed.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?) ([+-]\d{2}:\d{2})$/);
  const normalized = local ? `${local[1]}T${local[2]}${local[3]}` : trimmed;
  return Date.parse(normalized);
}

/** Relative offsets like -3d, -24h, -30m, -90s; absolute timestamps via parseTimestamp. */
export function parseTimeOrRelative(value: string, now = Date.now()): number {
  const trimmed = value.trim();
  const relative = trimmed.match(/^(-?)(\d+)(ms|s|m|h|d)$/i);
  if (relative) {
    const sign = relative[1] === '-' ? -1 : 1;
    const amount = Number(relative[2]);
    const unit = relative[3].toLowerCase();
    const multipliers: Record<string, number> = {
      ms: 1,
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    return now + sign * amount * multipliers[unit];
  }
  return parseTimestamp(trimmed);
}
