/** Optional Paseo integration. Importing this entry requires the Paseo peer dependencies. */
export { PaseoAdapter } from './paseo-delivery.js';
export { paseoWakeMessageId, sendPaseoWake } from './wake-sink.js';
export type { PaseoWakeRequest } from './wake-sink.js';
export { discoverPaseoAgents, waitForPaseoWakeBoundary } from './paseo-state.js';
export type { PaseoAgent } from './paseo-state.js';
