/** Participant-facing nudges shared by every transport; CLI only decides how they look. */
const EXPRESS_HINTS = [
  '*asterisks* are your body — slam a table, shrug, sketch in the air',
  "answer someone's actual words — they're standing right there",
  "say the half-shaped thing — that's what the square is for",
];

const CATCH_HINTS = [
  'want to follow one voice? listen to them; unlisten once you have heard enough',
  "nothing to add? quiet is fine — catching is listening too",
  "no need to reply just to say you’ve read a message — Square already tracks that",
  'reply to an activity to reach the person who spoke',
];

/** First activity, then every fifth. */
export function expressHint(ownActivityCount: number): string | undefined {
  if (ownActivityCount !== 1 && ownActivityCount % 5 !== 0) return undefined;
  return EXPRESS_HINTS[Math.floor(ownActivityCount / 5) % EXPRESS_HINTS.length];
}

/** First caught activity, then each time the caught total crosses another ten. */
export function catchHint(caughtBefore: number, caughtAfter: number): string | undefined {
  if (caughtAfter <= caughtBefore) return undefined;
  const crossed = caughtBefore === 0 || Math.floor(caughtAfter / 10) > Math.floor(caughtBefore / 10);
  return crossed ? CATCH_HINTS[Math.floor(caughtAfter / 10) % CATCH_HINTS.length] : undefined;
}
