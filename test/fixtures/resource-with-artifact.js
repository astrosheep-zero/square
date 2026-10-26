import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteSquare } from '../../dist/sqlite-square.js';

/** Exercise the real local resource using the public borrowed-artifact injection.
 * The disposable index keeps even postcommit discovery out of the real HOME. */
export async function resourceWithArtifact(t, artifact, body, clock = () => 100) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-resource-port-'));
  const resource = await SqliteSquare.at({ path: path.join(dir, 'test.square'),
    env: { SQUARE_INDEX: path.join(dir, 'index.ndjsonl') }, body, clock,
    resources: { artifact: () => artifact, close: async () => {} },
  }, undefined, false);
  t.after(async () => { await resource.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return resource;
}
