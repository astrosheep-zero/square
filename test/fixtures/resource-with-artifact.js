import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteSquare } from '../../dist/sqlite-square.js';

/** Internal unit-test construction with an instrumented artifact owned by the resource. */
export async function resourceWithArtifact(t, artifact, clock = () => 100) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-resource-port-'));
  const resource = new SqliteSquare(path.join(dir, 'test.square'), artifact, clock);
  t.after(async () => { await resource.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return resource;
}
