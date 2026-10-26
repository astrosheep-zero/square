export { Square, squareLocation, squareClock, createSquareResourceOwner, discover, inbox, diagnoseSquare, migrateSquare } from './square-api.js';
export { SquareError } from './model.js';
export type { WakeTransportPort, WakeRequest, WakeOutcome } from './ports.js';
export type { WakeTransports } from './notifications.js';
export { createDefaultWakeTransport } from './notifications.js';
export type { PresentationSinkPort } from './ports.js';
// Public operation contracts; no alternate runtime surface.
export type * from './square-backend.js';
export type * from './square-facade.js';
