import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { discoverPaseoAgents } from '../dist/paseo-state.js';
import { nodeCommandFixture } from './node-command-fixture.js';

test('Paseo discovery parses inventory without blocking the event loop', async () => {
  const fake = nodeCommandFixture('square-paseo-state', `
    process.stdout.write('{"agents":[{"id":"agent-1","name":"Alice","status":"idle","cwd":"/tmp/work"},{"id":"agent-2","name":"Bob","status":"running"}]}');
  `);
  try {
    let yielded = false;
    const timer = setTimeout(() => { yielded = true; }, 0);
    const result = await discoverPaseoAgents(5000, { args: fake.args, bin: fake.bin });
    clearTimeout(timer);
    assert.equal(yielded, true, 'discovery must not block on a synchronous subprocess');
    assert.deepEqual(result, {
      agents: [
        { id: 'agent-1', name: 'Alice', status: 'idle', cwd: '/tmp/work' },
        { id: 'agent-2', name: 'Bob', status: 'running' },
      ],
    });
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true });
  }
});
