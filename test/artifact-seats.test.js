import assert from 'node:assert/strict';
import test from 'node:test';
import { createArtifactPort } from '../dist/artifact.js';

const state = { hardCap: null, preamble: [], warmup: [], acts: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } };

test('captured participant authority cannot write after membership ends or is replaced', async t => {
  const artifact = createArtifactPort(':memory:', state);
  t.after(() => artifact.close());
  await artifact.transactAs({ kind: 'join', participant: 'Bob', owner: 'test:bob' }, w => w.land({ kind: 'join', actor: 'Bob', at: 1 }));
  const seat = (await artifact.read(r => r.seat('Bob'))).value;
  await artifact.transactAs({ kind: 'participant', seat }, w => w.land({ kind: 'done', actor: 'Bob', at: 2 }));
  await assert.rejects(artifact.transactAs({ kind: 'participant', seat }, w => w.land({ kind: 'say', actor: 'Bob', at: 3, body: 'stale' })));
  await artifact.transactAs({ kind: 'join', participant: 'Bob', owner: 'test:other' }, w => w.land({ kind: 'join', actor: 'Bob', at: 4 }));
  await assert.rejects(artifact.transactAs({ kind: 'participant', seat }, w => w.land({ kind: 'say', actor: 'Bob', at: 5, body: 'stale' })));
  const current = (await artifact.read(r => r.seat('Bob'))).value;
  assert.notEqual(current.generation, seat.generation);
  assert.equal(current.owner, 'test:other');
});
