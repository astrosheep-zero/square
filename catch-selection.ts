import { sameName } from './model.js';
import { audienceIncludes, type Audience } from './square-core.js';

/** Pure filter over settled audience facts; unread/directed eligibility and paging belong to callers. */
export function matchesCatchSelection(
  actor: string,
  audience: Audience,
  filter: { readonly participants?: readonly string[]; readonly mention?: string },
): boolean {
  if (filter.participants !== undefined && !filter.participants.some((participant) => sameName(participant, actor))) {
    return false;
  }
  return filter.mention === undefined || audienceIncludes(audience, filter.mention);
}
