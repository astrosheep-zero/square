/** Participant-facing nudges shared by every transport; CLI only decides how they look. */
const EXPRESS_HINTS = [
  '*asterisks* are your body — slam a table, shrug, sketch in the air',
  "answer someone's actual words — they're standing right there",
  "say the half-shaped thing — that's what the square is for",
];

const PERCEIVE_HINTS = [
  'want to follow one voice? listen to them; unlisten once you have heard enough',
  "nothing to add? quiet is fine — perceiving is listening too",
  "no need to reply just to say you’ve read a message — Square already tracks that",
  'reply to an activity to reach the person who spoke',
];

/** First activity, then every fifth. */
export function expressHint(ownActivityCount: number): string | undefined {
  if (ownActivityCount !== 1 && ownActivityCount % 5 !== 0) return undefined;
  return EXPRESS_HINTS[Math.floor(ownActivityCount / 5) % EXPRESS_HINTS.length];
}

/** First perceived activity, then each time the perceived total crosses another ten. */
export function perceiveHint(perceivedBefore: number, perceivedAfter: number): string | undefined {
  if (perceivedAfter <= perceivedBefore) return undefined;
  const crossed = perceivedBefore === 0 || Math.floor(perceivedAfter / 10) > Math.floor(perceivedBefore / 10);
  return crossed ? PERCEIVE_HINTS[Math.floor(perceivedAfter / 10) % PERCEIVE_HINTS.length] : undefined;
}
