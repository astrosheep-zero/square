import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

test('the sandbox replaces inherited Paseo endpoints, home and credentials before discovery', async (t) => {
  const inheritedHome = await mkdtemp(path.join(os.tmpdir(), 'square-inherited-paseo-'));
  t.after(() => rm(inheritedHome, { recursive: true, force: true }));
  await writeFile(path.join(inheritedHome, 'paseo.pid'), JSON.stringify({ listen: '127.0.0.1:1' }));
  await writeFile(path.join(inheritedHome, 'local-credential'), 'b'.repeat(43));
  const child = spawnSync(process.execPath, ['--import', './test/sandbox-env.js', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { daemonCredential, paseoHome, resolvePaseoDaemon } from './dist/packages/agent-delivery/src/paseo-native.js';

    const home = paseoHome();
    assert.notEqual(home, ${JSON.stringify(inheritedHome)});
    assert.ok(fs.statSync(home).isDirectory());
    assert.equal(process.env.PASEO_PASSWORD, undefined);
    const socketPath = path.join(home, 'daemon.sock');
    assert.equal(process.env.PASEO_HOST, 'unix://' + socketPath);
    const isolated = { url: 'ws+unix://' + socketPath + ':/ws', socketPath };
    assert.deepEqual(resolvePaseoDaemon(), isolated);
    assert.equal(fs.existsSync(socketPath), false);
    assert.deepEqual(daemonCredential({}), {});
    // Even without a home, the explicit sandbox endpoint prevents default TCP discovery.
    delete process.env.PASEO_HOME;
    assert.deepEqual(resolvePaseoDaemon(), isolated);
  `], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PASEO_HOME: inheritedHome,
      PASEO_HOST: 'tcp://127.0.0.1:1?password=inherited-endpoint-password',
      PASEO_PASSWORD: 'inherited-password',
    },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});
