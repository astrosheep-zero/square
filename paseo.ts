/** Optional Paseo integration. Importing this entry requires the Paseo peer dependencies. */
export { PaseoWakeTransport } from './hosts/paseo-delivery.js';
export { sendPaseoWake } from './hosts/wake-sink.js';
export type { PaseoWakeRequest } from './hosts/wake-sink.js';
export { discoverPaseoAgents, waitForPaseoWakeBoundary } from './hosts/paseo-state.js';
export type { PaseoAgent } from './hosts/paseo-state.js';
