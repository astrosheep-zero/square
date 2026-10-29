export { Square, squareLocation, squareClock, createSquareResourceOwner, withDefaultWakeTransport, discover, inbox, diagnoseSquare, migrateSquare } from './square-api.js';
export { SquareError, ACTIVITY_METADATA_MAX_BYTES } from './model.js';
export { selectOwnSeat, requireOwner, localUserOwner, harnessOwner, decodeHarnessOwner } from './square-api.js';
export type { WakeTransportPort, WakeRequest, WakeOutcome } from './ports.js';
export type { WakeTransports } from './notifications.js';
export { createDefaultWakeTransport } from './notifications.js';
// Public operation contracts; no alternate runtime surface.
export type * from './square-facade.js';
