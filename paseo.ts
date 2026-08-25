/** Optional Paseo integration. Importing this entry requires the Paseo peer dependencies. */
export { PaseoAdapter } from './paseo-delivery.js';
export { PaseoWakeSendError, sendPaseoWake } from './wake-sink.js';
export {
  connectPaseoDaemon,
  paseoDaemonHosts,
  resolvePaseoDaemonTarget,
} from './paseo-connection.js';
export { discoverPaseoAgents, waitForPaseoWakeBoundary } from './paseo-state.js';
export type { PaseoAgent } from './paseo-state.js';
