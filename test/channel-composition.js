import { Channel } from '../dist/channel-internal.js';
import { channelArtifact } from '../dist/artifact.js';
import { channelCourier } from '../dist/channel-artifact.js';
import { squareIndexPath } from '../dist/square-index.js';

/** Test the same lower implementation inside an already-open Square artifact. */
export function composedChannel(location, resources, { env = process.env, clock = Date.now, wakeTransport } = {}) {
  const artifact = channelArtifact(resources.artifact(location));
  return Channel.fromPort({ location, artifact, clock, indexPath: squareIndexPath(env), closesArtifact: false,
    ...(wakeTransport ? { deliverEffect: channelCourier(artifact, wakeTransport, location, clock) } : {}) });
}
