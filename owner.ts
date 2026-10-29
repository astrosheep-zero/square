import os from 'node:os';
import { type Owner, validateOwner } from './model.js';

export type { Owner } from './model.js';

export interface HarnessCoordinate {
  readonly channel: string;
  readonly session: string;
  readonly agent?: string;
}

export function harnessOwner(coordinate: HarnessCoordinate): Owner {
  const channel = nonempty(coordinate.channel, 'channel');
  const session = nonempty(coordinate.session, 'session');
  const agent = coordinate.agent === undefined ? undefined : nonempty(coordinate.agent, 'agent');
  return validateOwner([channel, session, ...(agent === undefined ? [] : ['agent', agent])].map(encodeURIComponent).join(':'));
}

/** Decode only at harness adapter boundaries; core never consumes the coordinate. */
export function decodeHarnessOwner(owner: Owner): HarnessCoordinate | undefined {
  const parts = owner.split(':');
  if ((parts.length !== 2 && parts.length !== 4) || (parts.length === 4 && parts[2] !== 'agent')) return undefined;
  try {
    const [channel, session] = parts;
    const decoded = { channel: decodeURIComponent(channel), session: decodeURIComponent(session) } as HarnessCoordinate;
    if (parts.length === 4) return { ...decoded, agent: decodeURIComponent(parts[3]) };
    return decoded;
  } catch {
    return undefined;
  }
}

export function localUserOwner(): Owner {
  return validateOwner(`user:${os.userInfo().username}@${os.hostname()}`);
}

function nonempty(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Harness ${label} must be non-empty.`);
  return value;
}
