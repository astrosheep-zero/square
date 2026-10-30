/** Storage-independent delivery custody. Effects and transaction ownership belong to callers. */
export { claimAttempt, prepareAttempt, settleAttempt, presentationBlocksDispatch, automaticDispatchEligible } from './delivery-attempts.js';
export type { DeliveryPurpose, AttemptOutcome, Attempt, AttemptRows, AttemptClaim } from './delivery-attempts.js';
