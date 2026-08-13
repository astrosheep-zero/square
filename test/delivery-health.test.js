import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('delivery evidence writers and health labels stay inside their owning modules', () => {
  const sources = fs.readdirSync(ROOT)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => [name, fs.readFileSync(path.join(ROOT, name), 'utf8')]);
  const externalUsers = (symbol, owner) => sources
    .filter(([name, source]) => name !== owner && source.includes(`${symbol}(`))
    .map(([name]) => name)
    .sort();

  assert.deepEqual(externalUsers('presentOnce', 'presented.ts'), ['boundary-presentation.ts']);
  assert.deepEqual(externalUsers('markDeliveredNotifications', 'delivery.ts'), ['watch.ts']);
  assert.deepEqual(externalUsers('recordWakeAttempt', 'wake-attempts.ts'), ['notifications.ts']);
  assert.deepEqual(externalUsers('recordRecoveredUnknown', 'wake-attempts.ts'), ['notifications.ts']);

  const labels = ['wake-accepted', 'wake-unknown', 'presented-not-delivered', 'unreachable'];
  for (const [name, source] of sources) {
    if (name === 'delivery-health.ts') continue;
    for (const label of labels) assert.equal(source.includes(label), false, `${label} leaked into ${name}`);
  }
  for (const name of ['notifications.ts', 'routes.ts', 'wake-attempts.ts', 'wake-port.ts']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, name), 'utf8'), /delivery-health/);
  }

  const sourceByName = new Map(sources);
  const closure = new Set();
  const visit = (name) => {
    if (closure.has(name)) return;
    closure.add(name);
    const source = sourceByName.get(name);
    if (source === undefined) return;
    for (const match of source.matchAll(/from ['"]\.\/(.+)\.js['"]/g)) visit(`${match[1]}.ts`);
  };
  visit('delivery-health.ts');
  assert.equal(closure.has('notifications.ts'), false);
  for (const name of closure) {
    assert.doesNotMatch(sourceByName.get(name) ?? '', /node:child_process/, `${name} gives delivery health process effects`);
  }
});
