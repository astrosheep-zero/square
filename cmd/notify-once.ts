#!/usr/bin/env node

import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { recordNotificationFailure } from '../notification-failures.js';
import { notificationDeliveryWaitMs, processActNotificationsOnce } from '../notifications.js';

function args(argv: string[]): { squarePath: string; actIndex: number } {
  let squarePath: string | undefined;
  let actIndex: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--square-path' && argv[index + 1] !== undefined) squarePath = resolve(argv[++index]);
    else if (argv[index] === '--act-index' && /^\d+$/.test(argv[index + 1] ?? '')) actIndex = Number(argv[++index]);
    else throw new Error(`Unknown notify-once argument: ${argv[index]}`);
  }
  if (squarePath === undefined || actIndex === undefined) throw new Error('notify-once requires --square-path and --act-index.');
  return { squarePath, actIndex };
}

async function main(): Promise<void> {
  if (process.env.SQUARE_DISABLE_PASEO_WAKE === '1') return;
  const { squarePath, actIndex } = args(process.argv.slice(2));
  await sleep(notificationDeliveryWaitMs());
  await processActNotificationsOnce(squarePath, actIndex);
}

main().catch((error) => {
  const squarePath = process.argv.includes('--square-path') ? process.argv[process.argv.indexOf('--square-path') + 1] : undefined;
  if (squarePath) {
    recordNotificationFailure(squarePath, {
      actIndex: Number(process.argv[process.argv.indexOf('--act-index') + 1]) || 0,
      sink: 'worker',
      message: error instanceof Error ? error.message : String(error),
      diagnostic: { phase: 'worker' },
    });
  }
  process.exitCode = 0;
});
