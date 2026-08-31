import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { discoverPaseoAgents } from '../dist/paseo-state.js';
import { nodeCommandFixture } from './node-command-fixture.js';

test('Paseo discovery parses the agent inventory returned by the CLI', () => {
  const fake = nodeCommandFixture('square-paseo-state', `
    process.stdout.write('{"agents":[{"id":"agent-1","name":"Alice","status":"idle","cwd":"/tmp/work"},{"id":"agent-2","name":"Bob","status":"running"}]}');
  `);
  try {
    assert.deepEqual(discoverPaseoAgents(5000, { args: fake.args, bin: fake.bin }), {
      agents: [
        { id: 'agent-1', name: 'Alice', status: 'idle', cwd: '/tmp/work' },
        { id: 'agent-2', name: 'Bob', status: 'running' },
      ],
    });
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true });
  }
});
