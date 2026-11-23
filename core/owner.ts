import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { type Owner, validateOwner } from './neutral.js';

export type { Owner } from './neutral.js';

export interface AkumaActor {
  readonly world: string;
  readonly akuId: string;
}

/** Keep the host's exact pair; physical World and full AkuId proof belongs to Keiyaku. */
export function requireAkumaActor(value: unknown): AkumaActor {
  const { world, akuId } = (value ?? {}) as Partial<AkumaActor>;
  if (typeof world !== 'string' || !path.isAbsolute(world) || path.resolve(world) !== world || world.includes('\0')
    || typeof akuId !== 'string' || !/^aku\/[^/\x00-\x1f\x7f]+\/[a-f0-9]{8}$/u.test(akuId)) {
    throw new Error('Keiyaku actor identity needs a canonical absolute World and a full AkuId.');
  }
  return { world, akuId };
}

/** The stable Square delivery owner shared by host binding and confirmed retirement. */
export function akumaDeliveryOwner(actor: AkumaActor): Owner {
  const { world, akuId } = requireAkumaActor(actor);
  const digest = createHash('sha256').update(JSON.stringify(['square:akuma-owner:v1', world, akuId])).digest('hex');
  return `square-akuma-v1:${digest}`;
}

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

export function localUserOwner(login = os.userInfo().username): Owner {
  return validateOwner(`user:${login}@${os.hostname()}`);
}

function nonempty(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Harness ${label} must be non-empty.`);
  return value;
}
