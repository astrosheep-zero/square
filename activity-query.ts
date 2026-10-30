import { SquareError, validateName } from './model.js';
import { parseActivityId } from './square-core.js';
import { validateMetadataMatch } from './delivery-deferral.js';
import { compileSearchPattern } from './search.js';
import type { ActivityFilter } from './ports.js';
import type { ActivityQuery } from './square-facade.js';

/** Both public read paths compile the same filters; neither resolves senders through membership. */
export function activityQueryFilter(query: ActivityQuery, extraFields: readonly string[] = []): ActivityFilter {
  const fail = (message: string): never => { throw new SquareError('invalid_args', message); };
  const fields = ['at', 'from', 'match', 'search', 'cursor', 'limit', ...extraFields];
  if (typeof query !== 'object' || query === null || Array.isArray(query)) fail('Activity query must be an object.');
  for (const field of Object.keys(query))
    if (!fields.includes(field)) fail(`Unknown activity query field: ${field}`);
  const indexes = query.at === undefined ? undefined : !Array.isArray(query.at) ? fail('Query at must be an array of activity IDs.')
    : Array.from(query.at, id => {
      const index = parseActivityId(id);
      return index === undefined ? fail(`Invalid activity id: ${id}`) : index;
    });
  const actors = query.from === undefined ? undefined : !Array.isArray(query.from) ? fail('Query from must be an array of sender names.')
    : Array.from(query.from, name => {
      if (typeof name !== 'string') fail('Query from must contain sender names.');
      validateName(name);
      return name;
    });
  const metadataMatch = query.match === undefined ? undefined : validateMetadataMatch(query.match);
  let afterIndex: number | undefined, beforeIndex: number | undefined;
  if (query.cursor !== undefined) {
    const cursor = query.cursor;
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)
      || !['before', 'after'].includes(cursor.direction) || Object.keys(cursor).some(key => !['id', 'direction'].includes(key)))
      fail('Query cursor requires an activity ID and before/after direction.');
    const index = parseActivityId(cursor.id);
    if (index === undefined) fail(`Invalid activity id: ${cursor.id}`);
    if (cursor.direction === 'after') afterIndex = index;
    else beforeIndex = index;
  }
  let search = query.search;
  if (search !== undefined) {
    if (typeof search !== 'object' || search === null || Array.isArray(search)
      || typeof search.text !== 'string' || search.text === '' || !['literal', 'regex'].includes(search.mode)
      || Object.keys(search).some(key => !['text', 'mode'].includes(key)))
      fail('Query search requires non-empty text and literal/regex mode.');
    compileSearchPattern(search.text, search.mode === 'literal');
    search = { text: search.text, mode: search.mode };
  }
  return { indexes, actors, metadataMatch, search, afterIndex, beforeIndex };
}
