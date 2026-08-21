import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { quoteShell } from './presentation.js';
import { SLEEP_MS } from './runtime.js';
import { openFileApplication } from './square-file-adapter.js';

/** Machine-readable tailing stays available; interactive terminal rendering was retired. */
export async function cmdStreamNdjson(squarePath: string, recipient?: string): Promise<void> {
  if (!fs.existsSync(squarePath)) {
    process.stderr.write(`square not found: ${squarePath}\n`);
    process.exitCode = 2;
    return;
  }
  let cursor = -1;
  while (true) {
    try {
      const application = await openFileApplication(squarePath);
      try {
        const projection = await application.streamProjection(cursor, recipient);
        for (const item of projection.activities) {
          process.stdout.write(`${JSON.stringify({
            seq: item.activity.index,
            square: squarePath,
            ...item.activity,
            ...(item.route === undefined ? {} : { route: item.route }),
          })}\n`);
        }
        cursor = projection.cursor;
      } finally {
        await application.close();
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
