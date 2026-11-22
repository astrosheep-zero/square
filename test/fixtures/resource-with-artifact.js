import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Square } from '../../dist/app/square.js';
import { dispatchPostedCard } from '../../dist/hosts/notifications.js';

/** Internal unit-test construction with an instrumented artifact owned by the resource. */
export async function resourceWithArtifact(t, artifact, clock = () => 100) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-resource-port-'));
  const location = path.join(dir, 'test.square');
  const resource = new Square(location, artifact, clock, location, path.join(dir, 'delivery.sqlite'), dispatchPostedCard);
  t.after(async () => { await resource.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return resource;
}
