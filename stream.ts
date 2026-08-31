import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

import { quoteShell } from './presentation.js';
import { SLEEP_MS } from './runtime.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { streamProjection, streamTailProjection } from './views.js';

export type StreamStart =
  | { readonly kind: 'tail'; readonly last: number }
  | { readonly kind: 'after'; readonly after: number };

async function writeNdjson(value: object): Promise<void> {
  if (!process.stdout.write(`${JSON.stringify(value)}\n`)) await once(process.stdout, 'drain');
}

/** Machine-readable tailing stays available; interactive terminal rendering was retired. */
export async function cmdStreamNdjson(squarePath: string, recipient?: string, start: StreamStart = { kind: 'tail', last: 10 }): Promise<void> {
  if (!fs.existsSync(squarePath)) {
    process.stderr.write(`square not found: ${squarePath}\n`);
    process.exitCode = 2;
    return;
  }
  let cursor = start.kind === 'after' ? start.after : -1;
  let initial = start.kind === 'tail' ? start : undefined;
  while (true) {
    try {
      const square = await openSquare(squarePath);
      try {
        const projection = initial === undefined
          ? await streamProjection(square, cursor, recipient)
          : await streamTailProjection(square, initial.last, recipient);
        for (const item of projection.activities) {
          await writeNdjson({
            seq: item.activity.index,
            square: squarePath,
            ...item.activity,
            ...(item.route === undefined ? {} : { route: item.route }),
          });
        }
        cursor = projection.cursor;
        initial = undefined;
        if (projection.hasMore) continue;
      } finally {
        await closeOpenSquare(square);
      }
    } catch {
      // A concurrent artifact replacement is retried on the next poll.
    }
    await sleep(SLEEP_MS);
  }
}

export async function cmdStream(squarePath: string): Promise<void> {
  process.stderr.write('✕ interactive stream was removed\n');
  process.stderr.write(`» square --location ${quoteShell(path.resolve(squarePath))} stream --ndjson\n`);
  process.exitCode = 2;
}
