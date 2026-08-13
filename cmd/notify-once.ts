#!/usr/bin/env node

import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { processActNotificationsOnce, wakeGraceMs } from '../notifications.js';

function args(argv: string[]): { squarePath: string; actIndex: number } {
  let squarePath: string | undefined;
  let actIndex: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--location' && argv[index + 1] !== undefined) squarePath = resolve(argv[++index]);
    else if (argv[index] === '--act-index' && /^\d+$/.test(argv[index + 1] ?? '')) actIndex = Number(argv[++index]);
    else throw new Error(`Unknown notify-once argument: ${argv[index]}`);
  }
  if (squarePath === undefined || actIndex === undefined) throw new Error('notify-once requires --location and --act-index.');
  return { squarePath, actIndex };
}

async function main(): Promise<void> {
  if (process.env.SQUARE_DISABLE_PASEO_WAKE === '1') return;
  const { squarePath, actIndex } = args(process.argv.slice(2));
  await sleep(wakeGraceMs());
  await processActNotificationsOnce(squarePath, actIndex);
}

main().catch(() => {
  process.exitCode = 0;
});
