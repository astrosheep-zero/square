import { NAME_GRAPHEME_SOURCE, isParticipantName } from '@astrosheep/square';

/** One name grapheme, exactly as Square accepts it in a name segment. */
const GRAPHEME = new RegExp(`^(?:${NAME_GRAPHEME_SOURCE})$`, 'v');
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

export { isParticipantName };

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
