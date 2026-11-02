import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.join(import.meta.dirname, '..');

test('Channel and Agora query coordinates remain distinct in their public types', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'square-query-types-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(fixture, 'consumer.ts'), `
    import type { Channel, ChannelEndpoint, MessageCursor, MessageQuery, ChannelHistoryQuery,
      ChannelPendingOptions } from ${JSON.stringify(path.join(root, 'channel.js'))};
    import type { Square, Participant, ActivityQuery, PendingOptions } from ${JSON.stringify(path.join(root, 'index.js'))};
    const cursor: MessageCursor = { direction: 'after', id: 'msg/1' };
    const message: MessageQuery = { at: ['msg/1'], from: ['Alice'], cursor,
      match: { fields: [{ path: ['job'], equals: 'one' }] }, search: { text: 'hello', mode: 'literal' } };
    const history: ChannelHistoryQuery = { ...message, order: 'desc', limit: null };
    const pending: ChannelPendingOptions = { ...message, limit: 1 };
    const activity: ActivityQuery = { at: ['act/1'], cursor: { direction: 'before', id: 'act/2' } };
    const activityPending: PendingOptions = { ...activity, limit: 1 };
    function query(channel: Channel, endpoint: ChannelEndpoint, square: Square, participant: Participant) {
      channel.history(history); endpoint.pending(pending); endpoint.receive(pending); endpoint.ack(['msg/1']);
      square.history(activity); participant.pending(activityPending);
      // @ts-expect-error Channel at accepts message IDs, not activity IDs
      channel.history({ at: ['act/1'] });
      // @ts-expect-error Channel cursor accepts message IDs, not activity IDs
      endpoint.pending({ cursor: { direction: 'after', id: 'act/1' } });
      // @ts-expect-error receive also uses message coordinates
      endpoint.receive({ at: ['act/1'] });
      // @ts-expect-error Channel acknowledgements use message coordinates
      endpoint.ack(['act/1']);
      // @ts-expect-error Agora at accepts activity IDs, not message IDs
      square.history({ at: ['msg/1'] });
      // @ts-expect-error Agora cursor accepts activity IDs, not message IDs
      participant.pending({ cursor: { direction: 'after', id: 'msg/1' } });
    }
    void query;
  `);
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--skipLibCheck', '--target', 'ESNext', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--types', 'node', '--typeRoots', path.join(root, 'node_modules/@types'),
    path.join(fixture, 'consumer.ts')], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
});
