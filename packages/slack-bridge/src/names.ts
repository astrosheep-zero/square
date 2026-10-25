// Square's own name grammar, mirrored so a Slack display name can become a
// participant name without importing Square's private modules.
const TEXT_GRAPHEME = String.raw`[[\p{L}\p{N}\p{M}_\x2D]--[\p{Variation_Selector}]]`;
/** One name grapheme, exactly as Square accepts it in a name segment. */
export const NAME_GRAPHEME_SOURCE = `${TEXT_GRAPHEME}|\\p{RGI_Emoji}`;
/** One or more slash-separated name segments. */
export const NAME_SOURCE = `(?:${NAME_GRAPHEME_SOURCE})+(?:/(?:${NAME_GRAPHEME_SOURCE})+)*`;

const PARTICIPANT = new RegExp(`^${NAME_SOURCE}$`, 'v');
const GRAPHEME = new RegExp(`^(?:${NAME_GRAPHEME_SOURCE})$`, 'v');
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function isParticipantName(name: string): boolean {
  return name.length > 0 && PARTICIPANT.test(name);
}

/** One Square name segment from a Slack display name; runs of invalid characters become `-`. */
export function slackName(display: string, userId: string): string {
  let name = '';
  let separator = false;
  for (const { segment } of graphemes.segment(display)) {
    if (GRAPHEME.test(segment)) {
      if (separator && name.length > 0) name += '-';
      separator = false;
      name += segment;
    }
    else separator = true;
  }
  return name.length > 0 ? name : userId;
}
