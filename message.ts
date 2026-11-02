// Message coordinates belong to Channel alone; Agora activity ids are a separate coordinate.
import crypto from 'node:crypto';

export type MessageId = `msg/${number}`;
/** Opaque endpoint custody token, allocated when an endpoint is established. */
export type EndpointGeneration = string;

export function formatMessageId(index: number): MessageId {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(`Invalid message index: ${index}`);
  return `msg/${index}`;
}
export function parseMessageId(value: string): number | undefined {
  if (value === 'msg/0') return 0;
  if (typeof value !== 'string' || !/^msg\/[1-9]\d*$/.test(value)) return undefined;
  const index = Number(value.slice(4));
  return Number.isSafeInteger(index) ? index : undefined;
}

export function newEndpointGeneration(): EndpointGeneration {
  return `endpoint/${crypto.randomUUID()}`;
}
export function validateEndpointGeneration(value: unknown): EndpointGeneration {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    throw new TypeError('Endpoint generation must be a non-empty opaque token without control characters.');
  return value;
}
