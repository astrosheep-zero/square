import { sameName } from './model.js';
import { audienceIncludes, type Audience } from './square-core.js';

/** Pure filter over settled audience facts; unread/directed eligibility and paging belong to callers. */
export function matchesCatchSelection(
  actor: string,
  audience: Audience,
  filter: { readonly participants?: readonly string[]; readonly mention?: string },
  replyAuthor?: string,
): boolean {
  if (filter.participants !== undefined && !filter.participants.some((participant) => sameName(participant, actor))) {
    return false;
  }
  if (filter.mention === undefined) return true;
  // A reply is directed attention in its own right: the viewer is reached as the
  // author of the activity they answered, exactly like a mention.
  return audienceIncludes(audience, filter.mention)
    || (replyAuthor !== undefined && sameName(replyAuthor, filter.mention));
}
