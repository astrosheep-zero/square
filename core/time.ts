/** Validate one finite named mute deadline from an operation-entry clock. */
export function muteDeadline(now: number, durationMs: number): number {
  if (!Number.isFinite(now)) throw new RangeError('Expected finite clock time');
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new RangeError('Expected a positive safe integer mute duration');
  const expiresAt = now + durationMs;
  if (!Number.isSafeInteger(expiresAt) || Number.isNaN(new Date(expiresAt).getTime()))
    throw new RangeError('Mute expiry is outside the representable epoch range');
  return expiresAt;
}

export function parseDurationMs(value: string): number | undefined {
  const match = /^([1-9]\d*)(ms|s|m|h|d)$/.exec(value);
  if (match === null) return undefined;
  const ms = Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]]!);
  return Number.isSafeInteger(ms) ? ms : undefined;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

export function formatTimestamp(at: number): string {
  const date = new Date(at);
  const time =
    date.getMilliseconds() !== 0
      ? `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
      : date.getSeconds() !== 0
        ? `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
        : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const offsetMinutes = -date.getTimezoneOffset();
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time,
    `${offsetMinutes >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`,
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

/** A relative duration looks back from the operation clock. */
export function parseTimeOrRelative(value: string, now: number): number {
  const trimmed = value.trim();
  const duration = parseDurationMs(trimmed.replace(/^-/, ''));
  if (duration !== undefined) return now - duration;
  return /^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(trimmed) ? parseTimestamp(trimmed) : NaN;
}
