import path from 'node:path';
import { createArtifactPort } from './artifact.js';
import { discoverSquares, MAX_LIST_LIMIT } from './list.js';
import { canonicalPath } from './canonical-path.js';
import type { Owner } from './model.js';
import type { InboxMembershipSummary } from './square-facade.js';

/** Filesystem-scoped membership counts. This is a World read, not a delivery scan. */
export async function sessionInboxCounts(input: { readonly owner: Owner; readonly cwd?: string }, signal?: AbortSignal): Promise<InboxMembershipSummary[]> {
  const root = path.resolve(input.cwd ?? process.cwd());
  const rows: InboxMembershipSummary[] = [];
  let after: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await discoverSquares(root, { limit: MAX_LIST_LIMIT, ...(after === undefined ? {} : { after }) }, { signal });
    for (const item of page.items) {
      signal?.throwIfAborted();
      const location = await canonicalPath(path.resolve(root, item.path));
      const artifact = createArtifactPort(location, undefined, signal);
      try {
        rows.push(...(await artifact.read(facts => facts.seatsForOwner(input.owner)
          .filter(seat => facts.participant(seat.participant)?.joined)
          .map(seat => ({ name: seat.participant, squarePath: location,
            pending: facts.directedCount(seat.participant, { unseenOnly: true, currentGeneration: true }) })), signal)).value);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        // Discovery candidates may disappear or become unreadable before this read.
      } finally { await artifact.close(); }
    }
    after = page.next;
  } while (after !== undefined);
  return rows;
}
