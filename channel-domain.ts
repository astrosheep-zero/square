import { SquareError, validateOwner } from './neutral.js';
import { sameName, validateName } from './channel-values.js';
import type { ChannelRead, ChannelWrite, ChannelWriteAuthority, EndpointRef } from './channel-ports.js';
import { validateEndpointGeneration } from './message.js';

/** Endpoint custody and operation authority without participant membership or social events. */
export function wrapChannelWrite(read: ChannelRead, write: ChannelWrite, authority: ChannelWriteAuthority): ChannelWrite {
  if (!authority || !['send', 'endpoint', 'endpoint-cleanup', 'participant'].includes(authority.kind))
    throw new SquareError('invalid_args', 'Channel writes require an explicit authority.');
  const name = authority.kind === 'send' ? authority.actor : authority.kind === 'endpoint' ? authority.participant : authority.seat.participant;
  validateName(name);
  if (authority.kind !== 'send') validateOwner(authority.kind === 'endpoint' ? authority.owner : authority.seat.owner);
  const fail = (): never => { throw new SquareError('already_joined', 'This operation needs its captured Channel endpoint.'); };
  const captured = authority.kind === 'participant' || authority.kind === 'endpoint-cleanup' ? authority.seat : undefined;
  if (captured) validateEndpointGeneration(captured.generation);
  function current(ref: EndpointRef, allowDetached = false): void {
    const actual = read.endpoint(ref.participant);
    if (!actual || !sameName(ref.participant, name) || actual.owner !== ref.owner || actual.generation !== ref.generation
      || !allowDetached && actual.attachment !== 'attached') fail();
  }
  function own(ref: EndpointRef, allowDetached = false): void {
    if (authority.kind === 'endpoint') {
      if (!sameName(ref.participant, name) || ref.owner !== authority.owner) fail();
    } else if (!captured || !sameName(ref.participant, captured.participant) || ref.owner !== captured.owner || ref.generation !== captured.generation) fail();
    current(ref, allowDetached);
  }
  if (authority.kind === 'participant') current(authority.seat);
  const forbidden = (): never => { throw new SquareError('invalid_args', 'This Channel authority does not permit that mutation.'); };
  const facts = Object.assign({}, read, Object.fromEntries(Object.keys(write)
    .filter(key => !(key in read)).map(key => [key, forbidden]))) as unknown as ChannelWrite;
  if (authority.kind === 'send' || authority.kind === 'participant') {
    facts.publishMessage = draft => {
      if (!sameName(draft.from, name)) fail();
      if (captured) current(captured);
      return write.publishMessage(draft);
    };
  }
  if (authority.kind === 'endpoint') {
    facts.storeEndpoint = endpoint => {
      if (!sameName(endpoint.participant, name) || endpoint.owner !== authority.owner) fail();
      return write.storeEndpoint(endpoint);
    };
    facts.reattachEndpoint = (ref, address) => { own(ref, true); return write.reattachEndpoint(ref, address); };
  }
  if (authority.kind === 'endpoint' || authority.kind === 'participant')
    facts.updateWakeAddress = (ref, address) => { own(ref); return write.updateWakeAddress(ref, address); };
  if (authority.kind === 'endpoint-cleanup') {
    // Cleanup races are harmless; storage compares the captured owner and generation.
    const cleanup = (ref: EndpointRef): void => {
      if (!captured || !sameName(ref.participant, captured.participant) || ref.owner !== captured.owner || ref.generation !== captured.generation) fail();
    };
    facts.detachEndpoint = ref => { cleanup(ref); return write.detachEndpoint(ref); };
    facts.removeEndpoint = ref => { cleanup(ref); return write.removeEndpoint(ref); };
  }
  if (authority.kind === 'participant') {
    facts.markSeen = (recipient, indexes, at) => { own({ ...authority.seat, participant: recipient }); return write.markSeen(recipient, indexes, at); };
    facts.cancelThrough = (ref, through) => {
      own(ref);
      if (!Number.isSafeInteger(through) || through < 0 || through >= read.header().nextMessageIndex)
        throw new SquareError('invalid_args', 'Cancellation boundary must be an assigned message index below the allocator.');
      return write.cancelThrough(ref, through);
    };
    facts.claimDelivery = input => { own(input.seat); return write.claimDelivery(input); };
    facts.prepareDelivery = input => { own(input.seat); return write.prepareDelivery(input); };
    facts.completeDelivery = input => { own(input.seat); return write.completeDelivery(input); };
    facts.observeNativeDelivery = input => { own(input.seat); return write.observeNativeDelivery(input); };
    facts.putDeliveryDeferral = (ref, ...args) => { own(ref); return write.putDeliveryDeferral(ref, ...args); };
    facts.renewDeliveryDeferral = (ref, ...args) => { own(ref); return write.renewDeliveryDeferral(ref, ...args); };
    facts.releaseDeliveryDeferral = (ref, ...args) => { own(ref); return write.releaseDeliveryDeferral(ref, ...args); };
    facts.putReceiveClaim = claim => { own({ ...authority.seat, participant: claim.owner, generation: claim.generation }); return write.putReceiveClaim(claim); };
    facts.removeReceiveClaim = (owner, namespace, id) => { own({ ...authority.seat, participant: owner }); return write.removeReceiveClaim(owner, namespace, id); };
  }
  return facts;
}
