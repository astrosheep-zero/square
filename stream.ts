import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { loadSquare } from './artifact.js';
import { planActNotifications } from './delivery.js';
import { type SquareDoc, type StoredAct, sameName } from './model.js';
import { quoteShell } from './presentation.js';
import { SLEEP_MS } from './runtime.js';

export function streamNotificationFor(doc: SquareDoc, item: StoredAct, recipient: string) {
  return planActNotifications(doc, item).find((notification) => sameName(notification.recipient, recipient));
}

function streamRows(squarePath: string, doc: SquareDoc, cursor: number, recipient?: string): string[] {
  return doc.acts.filter((act) => act.index > cursor).flatMap((act) => {
    const notification = recipient === undefined ? undefined : streamNotificationFor(doc, act, recipient);
    if (recipient !== undefined && notification === undefined) return [];
    return [JSON.stringify({
      seq: act.index,
      square: squarePath,
      ...act,
      ...(notification === undefined ? {} : { route: notification.route }),
    })];
  });
}

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
      const doc = loadSquare(squarePath);
      for (const row of streamRows(squarePath, doc, cursor, recipient)) process.stdout.write(`${row}\n`);
      cursor = Math.max(cursor, ...doc.acts.map((act) => act.index));
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
