import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverPaseoAgents } from '../dist/paseo-state.js';

test('Paseo discovery parses the agent inventory returned by the CLI', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-paseo-state-'));
  const bin = path.join(root, 'paseo');
  fs.writeFileSync(bin, '#!/bin/sh\nprintf \'%s\\n\' \'{"agents":[{"id":"agent-1","name":"Alice","status":"idle","cwd":"/tmp/work"},{"id":"agent-2","name":"Bob","status":"running"}]}\'\n');
  fs.chmodSync(bin, 0o755);
  const previous = process.env.SQUARE_PASEO_BIN;
  process.env.SQUARE_PASEO_BIN = bin;
  try {
    assert.deepEqual(discoverPaseoAgents(), {
      agents: [
        { id: 'agent-1', name: 'Alice', status: 'idle', cwd: '/tmp/work' },
        { id: 'agent-2', name: 'Bob', status: 'running' },
      ],
    });
  } finally {
    if (previous === undefined) delete process.env.SQUARE_PASEO_BIN;
    else process.env.SQUARE_PASEO_BIN = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
