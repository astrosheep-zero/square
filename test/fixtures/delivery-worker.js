import fs from 'node:fs';

import { processActNotificationsOnce } from '../../dist/notifications.js';

const [squarePath, actIndexText, mode, callLog] = process.argv.slice(2);
if (!squarePath || !/^\d+$/.test(actIndexText ?? '') || !mode || !callLog) {
  throw new Error('delivery-worker requires squarePath, actIndex, mode, and callLog');
}

const adapter = {
  kind: 'paseo',
  async dispatch(_route, _request, beforeSend) {
    if (!(await beforeSend())) return { outcome: 'cancelled' };
    fs.appendFileSync(callLog, `${process.pid}\n`);
    if (mode === 'hold-after-send') {
      process.stdout.write('sent\n');
      await new Promise(() => {});
    }
    if (mode !== 'accepted') throw new Error(`unknown delivery worker mode: ${mode}`);
    return { outcome: 'accepted' };
  },
};

await processActNotificationsOnce(squarePath, Number(actIndexText), {
  env: process.env,
  adapters: [adapter],
});
