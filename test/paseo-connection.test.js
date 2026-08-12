import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { paseoDaemonHosts, resolvePaseoDaemonTarget } from '../dist/paseo-connection.js';

test('explicit Paseo host and URI password use the CLI connection contract', () => {
  assert.deepEqual(paseoDaemonHosts({ PASEO_HOST: 'tcp://example.test:7443?ssl=true&password=uri-secret' }), [
    'tcp://example.test:7443?ssl=true&password=uri-secret',
  ]);
  assert.deepEqual(
    resolvePaseoDaemonTarget('tcp://example.test:7443?ssl=true&password=uri-secret', { PASEO_PASSWORD: 'env-secret' }),
    { type: 'tcp', url: 'wss://example.test:7443/ws', password: 'uri-secret' }
  );
  assert.deepEqual(resolvePaseoDaemonTarget('tcp://[::1]:6767?ssl=true', {}), {
    type: 'tcp',
    url: 'wss://[::1]:6767/ws',
  });
});

test('Paseo IPC targets retain socket paths and environment authentication', () => {
  assert.deepEqual(resolvePaseoDaemonTarget('unix:///tmp/paseo.sock', { PASEO_PASSWORD: 'secret' }), {
    type: 'ipc',
    url: 'ws+unix:///tmp/paseo.sock:/ws',
    socketPath: '/tmp/paseo.sock',
    password: 'secret',
  });
});

test('Paseo default hosts prefer the daemon pid target and configured TCP fallback', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-paseo-home-'));
  fs.writeFileSync(path.join(home, 'paseo.pid'), JSON.stringify({ sockPath: '/tmp/paseo-test.sock' }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemon: { listen: '10.0.0.5:6767' } }));
  try {
    assert.deepEqual(paseoDaemonHosts({ PASEO_HOME: home }), [
      'unix:///tmp/paseo-test.sock',
      '10.0.0.5:6767',
      'localhost:6767',
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
