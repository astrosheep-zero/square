import { createArtifactStore, createStoreFile, replaceStoreFile, type StoreTransaction } from './artifact-store.js';
import { channelStoreFormat, initializeStandaloneChannel } from './channel-sqlite-schema.js';
import { createChannelSqlite } from './sqlite-channel.js';
import { wrapChannelWrite } from './channel-domain.js';
import { deliverPending } from './delivery-operations.js';
import { InternalSquareError } from './neutral.js';
import type { ChannelArtifact, ChannelRead, ChannelWrite } from './channel-ports.js';
import type { WakeTransportPort, WakeProjection } from './channel-transport.js';

const readMethods: readonly (keyof ChannelRead)[] = [
  'header', 'message', 'messages', 'messageHeads', 'messageCount', 'addresses', 'receipt', 'receiptFacts',
  'directed', 'directedCount', 'endpoint', 'endpointsForOwner', 'endpoints', 'deliveryEvidence', 'deliveryByToken',
  'cancelledThrough', 'deliveryDeferrals', 'receiveClaims', 'claimLease', 'suppressed',
];
export function channelReads(channel: ChannelRead, guard: StoreTransaction['guard']): ChannelRead {
  return Object.fromEntries(readMethods.map(name => [name, guard(channel[name] as (...args: never[]) => unknown)])) as unknown as ChannelRead;
}
export function channelWrites(channel: ChannelWrite, guard: StoreTransaction['guard']): ChannelWrite {
  return Object.fromEntries(Object.entries(channel).filter(([, value]) => typeof value === 'function')
    .map(([name, value]) => [name, guard(value)])) as unknown as ChannelWrite;
}
function channelPort(location: string, initialize?: Parameters<typeof createArtifactStore>[2], signal?: AbortSignal): ChannelArtifact {
  const store = createArtifactStore(location, channelStoreFormat, initialize, signal);
  const port: ChannelArtifact = {
    read: (select, signal) => store.run(false, ({ db, guard }) => select(channelReads(createChannelSqlite(db), guard)), signal),
    transactAs: (authority, change, signal) => store.run(true, ({ db, guard, track }) => {
      const channel = createChannelSqlite(db);
      track(channel);
      return change(wrapChannelWrite(channelReads(channel, guard), channelWrites(channel, guard), authority));
    }, signal),
    async claimDelivery(input, signal) { return (await port.transactAs({ kind: 'participant', seat: input.seat }, facts => facts.claimDelivery(input), signal)).value; },
    async prepareDelivery(input, signal) { return (await port.transactAs({ kind: 'participant', seat: input.seat }, facts => facts.prepareDelivery(input), signal)).value; },
    async completeDelivery(input, signal) { return (await port.transactAs({ kind: 'participant', seat: input.seat }, facts => facts.completeDelivery(input), signal)).value; },
    async cancelDeliveries(seat, through, signal) {
      return (await port.transactAs({ kind: 'participant', seat }, facts => {
        const boundary = through ?? facts.header().lastMessageIndex;
        return boundary < 0 ? false : facts.cancelThrough(seat, boundary);
      }, signal)).value;
    },
    changed: store.changed, close: store.close,
  };
  return port;
}
/** Native Channel factories use only lower SQL and the shared physical-store lifetime. */
export function openChannelArtifact(location: string, signal?: AbortSignal): ChannelArtifact { return channelPort(location, undefined, signal); }
export function createMemoryChannelArtifact(description = '# Channel\n'): ChannelArtifact {
  return channelPort(':memory:', db => initializeStandaloneChannel(db, 0, description));
}
export async function createChannelArtifactFile(location: string, description: string, force: boolean, signal?: AbortSignal): Promise<void> {
  if (force) await replaceStoreFile(location, channelStoreFormat, (db, revision) => initializeStandaloneChannel(db, revision, description), signal);
  else if (!await createStoreFile(location, channelStoreFormat, db => initializeStandaloneChannel(db, 0, description), signal))
    throw new InternalSquareError('conflict', `Refusing to overwrite existing square: ${location}\nPass -f to overwrite.`);
}
export function channelCourier(artifact: ChannelArtifact, transport: WakeTransportPort, location: string, clock: () => number, preparePresentation?: WakeProjection) {
  return (message?: number) => deliverPending({ artifact, transport, location, now: clock(),
    ...(preparePresentation === undefined ? {} : { preparePresentation }), ...(message === undefined ? {} : { message }) });
}
