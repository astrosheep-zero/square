import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Square } from '../../dist/square-api.js';

/** Exercise the real local resource using the public borrowed-artifact injection. */
export async function resourceWithArtifact(t, artifact, clock = () => 100) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-resource-port-'));
  const resource = await Square.at({ path: path.join(dir, 'test.square'),
    env: { ...process.env, SQUARE_DELIVERY: path.join(dir, 'delivery.sqlite') }, clock,
    resources: { artifact: () => artifact, close: async () => {} },
  });
  t.after(async () => { await resource.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return resource;
}
