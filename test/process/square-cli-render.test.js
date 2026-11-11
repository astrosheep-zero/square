// Isolated from the default suite. Run with: npm run test:cli-process (builds, then this file).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { formatActivityId } from '../../dist/square-core.js';
import { createArtifactPort, readSquareSnapshot, writeSquareFile } from '../../dist/artifact.js';
import { Square } from '../../dist/square-api.js';
import { DeliveryLedger } from '../../dist/delivery-ledger.js';
import { discover } from '../../dist/square-api.js';
import { listCommand } from '../../dist/cli/observation-commands.js';
import {
  CLI,
  run,
  withPath,
  withName,
  persistSquare,
  tickingClock,
  assertDraftRecovery,
  testEnv,
} from '../square-cli-helpers.js';

test('status stays compact and focuses on the current square', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    const bob = (await square.join('Bob', { owner: body, wakeAddress })).participant;
    for (let index = 0; index < 12; index += 1) {
      await alice.express(`activity ${index} @Bob`, { force: true, mentions: ['Bob'] });
    }
    await bob.done();
    await alice.express('last activity @Alice', { force: true, mentions: ['Alice'] });
  }, { hardCap: 100, markdown: '## Topic\n\nTesting status' });

  const status = run(withName(file, 'Alice', ['status']), { env: { SQUARE_NOW_MS: '22000' } });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /1 here · 1 done · cap 100 each · throttle none/);
  assert.match(status.stdout, /● @Alice is nearby · just now/);
  assert.doesNotMatch(status.stdout, /13 activities/);
  assert.doesNotMatch(status.stdout, /Bob/);
  assert.doesNotMatch(status.stdout, /─/);
});

test('status previews ten active participants and counts the rest', async () => {
  const peers = Array.from({ length: 12 }, (_value, index) => `Peer${String(index + 1).padStart(2, '0')}`);
  const file = await persistSquare(async ({ square, file, body, wakeAddress, time }) => {
    // Seed the historical actor before real joins, so replacement does not discard live seat ownership.
    await square.close();
    const historical = (await readSquareSnapshot(file)).state;
    historical.acts.push({ kind: 'read', actor: 'Reserved', at: 0, through: 0, index: historical.runtime.nextActIndex++ });
    await writeSquareFile(file, historical);
    const reopened = await Square.at({ path: file, clock: time.tick });
    try {
      await reopened.join('Viewer', { owner: body, wakeAddress });
      for (const name of peers) {
        const participant = (await reopened.join(name, { owner: body, wakeAddress })).participant;
        await participant.express(`recent activity from ${name}`, { force: true });
      }
    } finally { await reopened.close(); }
  }, { hardCap: 100 });

  const status = run(withPath(file, ['status']), { env: { SQUARE_NOW_MS: '100000' } });
  assert.equal(status.status, 0, status.stderr);
  const around = status.stdout.slice(status.stdout.indexOf('around the square'), status.stdout.indexOf('\n\nlatest'));
  const participantRows = around.split('\n').filter((line) => /^  [◎●○] @/.test(line));
  assert.equal(participantRows.length, 10);
  assert.deepEqual(participantRows.map((line) => line.match(/@(\S+) is nearby ·/)?.[1]), peers.slice(2).reverse());
  assert.match(status.stdout, /^  ○ … 3 more here$/m);
  assert.doesNotMatch(status.stdout, /Reserved/);
});

test('status separates here from lingering and keeps the roster honest', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    await square.join('Ghost1', { owner: body, wakeAddress });
    await square.join('Ghost2', { owner: body, wakeAddress });
  }, { hardCap: 100 });

  const status = run(withPath(file, ['status']), { env: { SQUARE_NOW_MS: String(40 * 60 * 1000) } });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /0 here · 2 lingering · 0 done/);
  assert.match(status.stdout, /^  ○ nobody here right now$/m);
  assert.match(status.stdout, /^  ○ … 2 lingering$/m);
  assert.doesNotMatch(status.stdout, /Ghost1 ·/);
});

test('status shows who stepped in after the latest public act', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    await alice.done();
    await square.join('Alice', { owner: body, wakeAddress });
    await square.join('Bob', { owner: body, wakeAddress });
  }, { hardCap: 100 });

  const status = run(withPath(file, ['status']), { env: { SQUARE_NOW_MS: '22000' } });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /@Alice stepped out of the square — done/);
  assert.match(status.stdout, /→ @Alice stepped back in · \d+s ago/);
  assert.match(status.stdout, /→ @Bob stepped in · \d+s ago/);
});

test('history refuses an unbounded merged context and offers a bounded executable command', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    for (let index = 1; index <= 101; index += 1) {
      await alice.express(`activity ${index}`, { force: true });
    }
  }, { hardCap: 200 });

  const oversized = run(withPath(file, ['history', '--at', 'act/100', '-C', '100', '--json']));
  assert.equal(oversized.status, 2);
  assert.match(oversized.stderr, /history is capped at 100 activities/);
  assert.match(oversized.stderr, new RegExp(`square --location '${file}' history --at act/100 -C 100 --json --limit 100`));

  const bounded = run(withPath(file, ['history', '--at', 'act/100', '-C', '100', '--json', '--limit', '100']));
  assert.equal(bounded.status, 0, bounded.stderr);
  assert.equal(JSON.parse(bounded.stdout).activities.length, 100);
});

test('status has no participant preview affordance at ten active participants', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    for (let index = 1; index <= 10; index += 1) await square.join(`Peer${String(index).padStart(2, '0')}`, { owner: body, wakeAddress });
  }, { hardCap: 100 });

  const status = run(withPath(file, ['status']), { env: { SQUARE_NOW_MS: '100000' } });
  assert.equal(status.status, 0, status.stderr);
  assert.doesNotMatch(status.stdout, /^  ○ … \d+ more participants$/m);
  assert.doesNotMatch(status.stdout, /^square --location .* participants$/m);
});

test('express does not surface delivery-health diagnostics during normal use', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    await square.join('Alice', { owner: body, wakeAddress });
    const bob = (await square.join('Bob', { owner: body, wakeAddress })).participant;
    await ((await square.join('Alice', { owner: body, wakeAddress })).participant).express('hey @Bob', { force: true, mentions: ['Bob'] });
    await bob.express('still working @Bob', { force: true, mentions: ['Bob'] });
  });

  const acted = run(withName(file, 'Bob', ['express', '--force', '--mention', 'Bob', 'still working later @Bob']), {
    env: { SQUARE_NOW_MS: '70000' },
  });
  assert.equal(acted.status, 0, acted.stderr);
  assert.doesNotMatch(acted.stdout + acted.stderr, /delivery|receipt|harness doctor|pending|wake|not-capable/i);

  const diagnosed = run(withPath(file, ['harness', 'doctor', 'delivery']), {
    env: { SQUARE_NOW_MS: '70000' },
  });
  assert.equal(diagnosed.status, 0, diagnosed.stderr);
  assert.match(diagnosed.stdout, /delivery health.*unknown attempts.*repeated failures.*sessions without route/);
});

test('perceive --mention renders matching says and suppresses room changes', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    const bob = (await square.join('Bob', { owner: body, wakeAddress })).participant;
    await bob.express('hello @Alice', { force: true, mentions: ['Alice'] });
    await square.join('Cara', { owner: body, wakeAddress });
    void alice;
  });

  const watched = run(withName(file, 'Alice', ['perceive', '--mention']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(watched.status, 0, watched.stderr);
  assert.match(watched.stdout, /calls your name across the square — @Alice/);
  assert.match(watched.stdout, /@Bob\s+·/);
  assert.doesNotMatch(watched.stdout, /while your back was turned/);
  assert.doesNotMatch(watched.stdout, /Cara stepped into the square/);
});

test('perceive continuation preserves filters and page size', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    const bob = (await square.join('Bob', { owner: body, wakeAddress })).participant;
    const cara = (await square.join('Cara', { owner: body, wakeAddress })).participant;
    for (let index = 0; index < 3; index += 1) await bob.express(`message ${index} @Alice`, { force: true, mentions: ['Alice'] });
    for (let index = 0; index < 3; index += 1) await cara.express(`reply ${index} @Alice`, { force: true, mentions: ['Alice'] });
    void alice;
  });
  const first = run(withName(file, 'Alice', ['perceive', '--from', 'Bob,Cara', '--mention', '--limit', '5']));
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /1 matching activity remains/);
  assert.match(first.stdout, /perceive --from Bob,Cara --mention --limit 5/);
  assert.doesNotMatch(first.stdout, /perceive --idle 30m/);
  const invalidMention = run(withName(file, 'Alice', ['perceive', '--mention', 'Bob']));
  assert.notEqual(invalidMention.status, 0);
});

test('perceive --from renders named peers and rejects the removed --by flag', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    await square.join('Alice', { owner: body, wakeAddress });
    const bob = (await square.join('Bob', { owner: body, wakeAddress })).participant;
    const cara = (await square.join('Cara', { owner: body, wakeAddress })).participant;
    await bob.express('hello from bob @Alice', { force: true, mentions: ['Alice'] });
    await cara.express('hello from cara @Alice', { force: true, mentions: ['Alice'] });
    await bob.done();
  });

  const watched = run(withName(file, 'Alice', ['perceive', '--from', 'Bob']), { env: { SQUARE_NOW_MS: '7000' } });
  assert.equal(watched.status, 0, watched.stderr);
  assert.doesNotMatch(watched.stdout, /@Bob stepped into the square/);
  assert.match(watched.stdout, /@Bob\s+·/);
  assert.doesNotMatch(watched.stdout, /@Bob stepped out of the square — done/);
  assert.doesNotMatch(watched.stdout, /Cara stepped into the square/);
  assert.doesNotMatch(watched.stdout, /hello from cara/);

  const removed = run(withName(file, 'Alice', ['perceive', '--by', 'Bob']));
  assert.notEqual(removed.status, 0);
  assert.match(removed.stderr, /✕ perceive does not know --by/);
  assert.match(removed.stderr, /square perceive --help\n$/);
});

test('perceive around the square excludes the current actor', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    await square.join('Alice', { owner: body, wakeAddress });
    await square.join('Bob', { owner: body, wakeAddress });
    await square.join('Cara', { owner: body, wakeAddress });
  });

  assert.equal(run(withName(file, 'Alice', ['perceive']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['perceive']), { env: { SQUARE_NOW_MS: '5000' } }).status, 0);

  const watched = run(withName(file, 'Alice', ['perceive']), { env: { SQUARE_NOW_MS: '6000' } });
  assert.equal(watched.status, 0, watched.stderr);
  assert.match(watched.stdout, /around the square/);
  assert.match(watched.stdout, /Bob/);
  assert.doesNotMatch(watched.stdout, /^\s*[◎●○×]\s+Alice\b/m);
});

test('history with an explicit page and no truncation renders the archive', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    await square.join('Alice', { owner: body, wakeAddress });
    const bob = (await square.join('Bob', { owner: body, wakeAddress })).participant;
    await bob.express('hello @Alice', { force: true, mentions: ['Alice'] });
    await bob.done();
  });

  const activities = run(withPath(file, ['history', '--limit', '100', '--full']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(activities.status, 0, activities.stderr);
  assert.match(activities.stdout, /@Bob\s+·/);
  assert.match(activities.stdout, /hello @Alice/);
  assert.match(activities.stdout, /@Bob stepped out of the square — done/);
  assert.doesNotMatch(activities.stdout, /\(No public activity in this view\.\)/);
});

test('history accepts --as without claiming identity or changing archive semantics', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    await alice.express('archived body', { force: true });
  });
  const before = fs.readFileSync(file);
  const plain = run(withPath(file, ['history', '--limit', '3']));
  assert.equal(plain.status, 0, plain.stderr);
  for (const name of ['Alice', 'NotJoined']) {
    const history = run(withName(file, name, ['history', '--limit', '3']), {
      env: { SQUARE_PARTICIPANT_NAME: 'AlsoNotJoined', CODEX_THREAD_ID: 'archive-reader' },
    });
    assert.equal(history.status, 0, history.stderr);
    assert.equal(history.stdout, plain.stdout);
    assert.deepEqual(fs.readFileSync(file), before);
  }
  const help = run(withName(file, 'Alice', ['history', '--help']));
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Read or search the archive/);
});

test('unknown recipient warnings confirm the activity still landed', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    await square.join('Alice', { owner: body, wakeAddress });
  });

  const expressed = run(withName(file, 'Alice', ['express', '--mention', 'Eve', 'hello']));
  assert.equal(expressed.status, 0, expressed.stderr);
  assert.match(expressed.stdout, /your words land — act\/\d+/);
  assert.match(expressed.stdout, /@Eve isn't standing here — activity landed without reaching them/);
  assert.equal(expressed.stderr, '');
});

test('history pages with stable activity-id cursors and prints the next page', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    for (let index = 0; index < 12; index += 1) await alice.express(`message ${index}`, { force: true });
  }, { hardCap: 20 });
  const latest = run(withPath(file, ['history', '--limit', '3']));
  assert.equal(latest.status, 0, latest.stderr);
  assert.match(latest.stdout, /message 9/);
  assert.match(latest.stdout, /message 11/);
  assert.match(latest.stdout, /history --before act\/\d+ --limit 3/);

  const older = run(withPath(file, ['history', '--before', 'act/10', '--limit', '3']));
  assert.equal(older.status, 0, older.stderr);
  assert.match(older.stdout, /message 6/);
  assert.match(older.stdout, /message 8/);
  assert.doesNotMatch(older.stdout, /message 9/);
});

test('history --since excludes older public activity', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    await square.join('Alice', { owner: body, wakeAddress });
    const bob = (await square.join('Bob', { owner: body, wakeAddress })).participant;
    await bob.express('hello @Alice', { force: true, mentions: ['Alice'] });
    await bob.done();
  });

  const recorded = run(withPath(file, ['history', '--json']));
  assert.equal(recorded.status, 0, recorded.stderr);
  const acts = JSON.parse(recorded.stdout).activities;
  const say = acts.find((act) => act.kind === 'say');
  const done = acts.find((act) => act.kind === 'done');
  assert.ok(say !== undefined && done !== undefined, recorded.stdout);
  assert.ok(done.at > say.at, `expected the done activity after the say: ${say.at} -> ${done.at}`);

  const boundary = new Date(say.at + Math.floor((done.at - say.at) / 2)).toISOString();
  const activities = run(withPath(file, ['history', '--since', boundary]), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(activities.status, 0, activities.stderr);
  assert.doesNotMatch(activities.stdout, /Bob\s+·/);
  assert.doesNotMatch(activities.stdout, /hello @Alice/);
  assert.match(activities.stdout, /@Bob stepped out of the square — done/);
});

test('history hides read bookkeeping acts except in time and context windows', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    await alice.express('first public activity', { force: true });
    await alice.express('second public activity', { force: true });
  }, { hardCap: 100 });

  // Production never appends `read`; the artifact carries it only when an older
  // or foreign writer recorded that an activity was consumed. Pin that shape
  // directly so the archive's read filtering stays observable.
  const state = (await readSquareSnapshot(file)).state;
  const readIndex = (state.acts.at(-1)?.index ?? -1) + 1;
  const readAt = (state.acts.at(-1)?.at ?? 0) + 1000;
  await writeSquareFile(file, {
    ...state,
    acts: [...state.acts, { kind: 'read', actor: 'Alice', at: readAt, through: readIndex, index: readIndex }],
    runtime: { ...state.runtime, nextActIndex: readIndex + 1 },
  });

  const kinds = (result) => {
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).activities.map((activity) => activity.kind);
  };

  const archive = run(withPath(file, ['history', '--limit', '100', '--json']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.deepEqual(kinds(archive), ['join', 'say', 'say']);
  const cursor = run(withPath(file, ['history', '--after', 'act/0', '--limit', '100', '--json']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.deepEqual(kinds(cursor), ['say', 'say']);
  const second = state.acts.find((activity) => activity.kind === 'say' && activity.body === 'second public activity');
  const number = run(withPath(file, ['history', '--at', formatActivityId(second.index), '-C', '0', '--format', 'number']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(number.status, 0, number.stderr);
  assert.equal(number.stdout, '2\n', 'history numbers retain the lifetime ordinal outside the selected page');

  const contextArgs = ['history', '--at', formatActivityId(readIndex), '-C', '0'];
  const sinceArgs = ['history', '--since', new Date(readAt - 500).toISOString()];
  for (const args of [contextArgs, sinceArgs]) {
    const json = run(withPath(file, [...args, '--json']), { env: { SQUARE_NOW_MS: '5000' } });
    assert.deepEqual(kinds(json), [], 'SDK activities omit bookkeeping');
    const fields = run(withPath(file, [...args, '--format', 'kind']), { env: { SQUARE_NOW_MS: '5000' } });
    assert.equal(fields.status, 0, fields.stderr);
    assert.equal(fields.stdout, 'read\n', 'human field output retains the selected raw record');
  }
});

test('ambient perceive and history render full body to a mention target and presence to others', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    await square.join('Bob', { owner: body, wakeAddress });
    await square.join('Cara', { owner: body, wakeAddress });
    await alice.express('secret reach phrase @Bob', { force: true, mentions: ['Bob'] });
  });

  const bobWatch = run(withName(file, 'Bob', ['perceive']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(bobWatch.status, 0, bobWatch.stderr);
  assert.match(bobWatch.stdout, /secret reach phrase/);
  assert.match(bobWatch.stdout, /@Alice\s+·/);

  const caraWatch = run(withName(file, 'Cara', ['perceive']), { env: { SQUARE_NOW_MS: '6000' } });
  assert.equal(caraWatch.status, 0, caraWatch.stderr);
  assert.doesNotMatch(caraWatch.stdout, /talked to @Bob/);
  assert.doesNotMatch(caraWatch.stdout, /secret reach phrase/);

  const ambient = run(withPath(file, ['history', '--limit', '100']), { env: { SQUARE_NOW_MS: '7000' } });
  assert.equal(ambient.status, 0, ambient.stderr);
  assert.match(ambient.stdout, /● @Alice · act\/3 · .*\n  secret reach phrase @Bob/);
  assert.match(ambient.stdout, /→ @Alice, @Bob were here/);
  assert.doesNotMatch(ambient.stdout, /→ @(?:Alice|Bob|Cara) was here/);
  assert.doesNotMatch(ambient.stdout, /Cara were here/);

  const archive = run(withPath(file, ['history', '--limit', '100', '--full']), { env: { SQUARE_NOW_MS: '8000' } });
  assert.equal(archive.status, 0, archive.stderr);
  assert.match(archive.stdout, /secret reach phrase @Bob/);

  const exact = run(withPath(file, ['history', '--at', formatActivityId(3), '-C', '0']), { env: { SQUARE_NOW_MS: '9000' } });
  assert.equal(exact.status, 0, exact.stderr);
  assert.match(exact.stdout, /secret reach phrase @Bob/);

  const json = run(withPath(file, ['history', '--at', formatActivityId(3), '-C', '0', '--json']), { env: { SQUARE_NOW_MS: '10000' } });
  assert.equal(json.status, 0, json.stderr);
  assert.match(JSON.parse(json.stdout).activities[0].body, /secret reach phrase/);

  assert.equal(run(withName(file, 'Alice', ['express', '--force', '--mention', 'Cara', '--mention', 'bob', 'two targets @Cara then @bob']), { env: { SQUARE_NOW_MS: '10500' } }).status, 0);
  const laterJoin = run(withName(file, 'Dan', ['join', '--last', '100']), { env: { SQUARE_NOW_MS: '11000' } });
  assert.equal(laterJoin.status, 0, laterJoin.stderr);
  assert.match(laterJoin.stdout, /● @Alice · act\/3 · .*\n  talked to @Bob/);
  assert.match(laterJoin.stdout, /● @Alice · act\/4 · .*\n  talked to @Cara and @Bob/);
  assert.doesNotMatch(laterJoin.stdout, /secret reach phrase/);
  assert.doesNotMatch(laterJoin.stdout, /two targets/);
});

test('history anchors footprints at the last evidence of presence', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    await square.join('Bob', { owner: body, wakeAddress });
    await square.join('Cara', { owner: body, wakeAddress });
    await alice.express('shared coordinate @Bob', { force: true, mentions: ['Bob'] });
  });

  const bobPerceive = run(withName(file, 'Bob', ['perceive']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(bobPerceive.status, 0, bobPerceive.stderr);

  const history = run(withPath(file, ['history', '--limit', '100']), { env: { SQUARE_NOW_MS: '6000' } });
  assert.equal(history.status, 0, history.stderr);
  assert.match(history.stdout, /→ @Alice, @Bob were here/);
  assert.doesNotMatch(history.stdout, /→ @(?:Alice|Bob|Cara) was here/);
  assert.doesNotMatch(history.stdout, /Cara were here/);
});

test('presence rendering omits a body when a bare say has no visible mention target', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    const bob = (await square.join('Bob', { owner: body, wakeAddress })).participant;
    await square.join('Cara', { owner: body, wakeAddress });
    await bob.listen('Alice');
    await alice.express('listener-only answer', { force: true });
  });

  const caraWatch = run(withName(file, 'Cara', ['perceive']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(caraWatch.status, 0, caraWatch.stderr);
  assert.match(caraWatch.stdout, /● @Alice is nearby · just now/);
  assert.doesNotMatch(caraWatch.stdout, /\n  spoke/);
  assert.doesNotMatch(caraWatch.stdout, /talked to(?:\s|$)/m);
  assert.doesNotMatch(caraWatch.stdout, /listener-only answer/);
});

test('history expands the newest ten activities in chronological order', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    for (let index = 1; index <= 11; index += 1) {
      const body = `history body ${index} ${'x'.repeat(index === 11 ? 230 : 4)} @Alice`;
      await alice.express(body, { force: true, mentions: ['Alice'] });
    }
  }, { hardCap: null });

  const history = run(withPath(file, ['history']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(history.status, 0, history.stderr);
  assert.doesNotMatch(history.stdout, /history body 1 /);
  assert.match(history.stdout, /history body 2 /);
  assert.match(history.stdout, /history body 11 /);
  assert.match(history.stdout, /history body 11 [^\n]*x{20}/);
  assert.ok(history.stdout.indexOf('history body 2 ') < history.stdout.indexOf('history body 11 '));
});

test('history expands one result, previews multiple results, and --full expands all', async () => {
  const firstTail = 'FIRST-TAIL';
  const secondTail = 'SECOND-TAIL';
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    await alice.express(`${'a'.repeat(220)}${firstTail}`, { force: true });
    await alice.express(`${'b'.repeat(220)}${secondTail}`, { force: true });
  });

  const single = run(withPath(file, ['history', '--limit', '1']));
  assert.equal(single.status, 0, single.stderr);
  assert.match(single.stdout, new RegExp(secondTail));

  const multiple = run(withPath(file, ['history', '--limit', '2']));
  assert.equal(multiple.status, 0, multiple.stderr);
  assert.doesNotMatch(multiple.stdout, new RegExp(firstTail));
  assert.doesNotMatch(multiple.stdout, new RegExp(secondTail));
  assert.match(multiple.stdout, /history --at act\/1,act\/2 --full/);

  const expanded = run(withPath(file, ['history', '--limit', '2', '--full']));
  assert.equal(expanded.status, 0, expanded.stderr);
  assert.match(expanded.stdout, new RegExp(firstTail));
  assert.match(expanded.stdout, new RegExp(secondTail));
});

test('bell quota refusal prints the next timestamp and express help keeps --bell', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    await square.join('Bob', { owner: body, wakeAddress });
    await square.join('Cara', { owner: body, wakeAddress });
    await alice.express('bell one', { force: true, reach: 'bell' });
  }, { manualClock: true });

  const secondBell = run(withName(file, 'Alice', ['express', '--bell', 'bell two']), { env: { SQUARE_NOW_MS: '7000' } });
  assert.equal(secondBell.status, 1, secondBell.stderr);
  assert.match(secondBell.stdout, /the bell stays quiet for now/);
  assert.match(secondBell.stdout, /you can ring it again in 59m 53s/);

  const removed = run(withName(file, 'Alice', ['express', '--force', '--beside', 'Bob', 'gone @Bob']));
  assert.notEqual(removed.status, 0);
  assert.match(removed.stderr, /express does not know --beside/);
  assert.match(removed.stderr, /square express --help\n$/);

  const help = run(['express', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /beside/);
  assert.match(help.stdout, /--bell/);
  assert.match(help.stdout, /--reply <activity-id>/);
  assert.match(help.stdout, /act\/12/);
  assert.doesNotMatch(help.stdout, /act\/N/);
});

test('express --reply renders the causal activity reference', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    const bob = (await square.join('Bob', { owner: body, wakeAddress })).participant;
    await alice.express('question @Bob', { force: true, mentions: ['Bob'] });
    await bob.express('answer @Alice', { force: true, mentions: ['Alice'], reply: 'act/2' });
  });

  const history = run(withPath(file, ['history', '--at', formatActivityId(3), '-C', '0', '--full']));
  assert.equal(history.status, 0, history.stderr);
  assert.match(history.stdout, /act\/3.*replies to act\/2/);

  const json = run(withPath(file, ['history', '--at', formatActivityId(3), '-C', '0', '--json']));
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).activities[0].reply, formatActivityId(2));
});

test('history --at accepts multiple coordinates and unions their context windows', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    const bob = (await square.join('Bob', { owner: body, wakeAddress })).participant;
    await alice.express('first @Bob', { force: true, mentions: ['Bob'] });
    await bob.express('second @Alice', { force: true, mentions: ['Alice'] });
  });

  const comma = run(withPath(file, ['history', '--at', 'act/2,act/3', '-C', '0', '--json']));
  assert.equal(comma.status, 0, comma.stderr);
  assert.deepEqual(JSON.parse(comma.stdout).activities.map((activity) => activity.id), ['act/2', 'act/3']);

  const repeated = run(withPath(file, ['history', '--at', 'act/2', '--at', 'act/3', '-C', '0', '--json']));
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout).activities.map((activity) => activity.id), ['act/2', 'act/3']);
});

test('inbox stays read-only while codex admits pending attention once at a boundary', async () => {
  const bobBody = "codex" + ":" + ('sid-cli');
  const file = await persistSquare(async ({ square, file, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    const bob = await Square.at({ path: file });
    try { await bob.join('Bob', { owner: bobBody }); } finally { await bob.close(); }
    await alice.express('hey @Bob', { force: true, mentions: ['Bob'] });
  });
  const root = path.dirname(file);
  const env = {};
  const inspected1 = run(['inbox', '--for-owner', 'codex:sid-cli', '--json'], { cwd: root, env });
  assert.equal(inspected1.status, 0, inspected1.stderr);
  const pendingInbox = JSON.parse(inspected1.stdout);
  assert.deepEqual(pendingInbox, {
    rows: [{ name: 'Bob', squarePath: fs.realpathSync(file), pending: 1 }],
    total: 1,
  });
  assert.doesNotMatch(inspected1.stdout, /hey @Bob|notifications|perceiveLease/);

  const textSnapshot = run(['inbox', '--for-owner', 'codex:sid-cli'], { cwd: root, env });
  assert.equal(textSnapshot.status, 0, textSnapshot.stderr);
  assert.equal(textSnapshot.stdout, `Bob\t${fs.realpathSync(file)}\t1\n`);

  const inspected2 = run(['inbox', '--for-owner', 'codex:sid-cli', '--json'], { cwd: root, env });
  assert.equal(inspected2.status, 0, inspected2.stderr);
  assert.deepEqual(JSON.parse(inspected2.stdout), pendingInbox);

  const ledger = await DeliveryLedger.open({ location: process.env.SQUARE_DELIVERY });
  try {
    const session = await ledger.session(bobBody);
    assert.ok(session, 'Codex owner is attached');
    assert.ok((await ledger.pending(bobBody, { generation: session.generation })).some(card => card.text.includes('hey @Bob')), 'the directed card reached the host ledger');
  } finally { await ledger.close(); }

  const inject = spawnSync(process.execPath, [CLI, 'codex-hook'], {
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'sid-cli', hook_event_name: 'PostToolUse' }),
    env: testEnv(env),
  });
  assert.equal(inject.status, 0, inject.stderr);
  assert.match(inject.stdout, /"hookEventName":"PostToolUse"/, inject.stderr);
  assert.match(inject.stdout, /hey @Bob/);

  const duplicate = spawnSync(process.execPath, [CLI, 'codex-hook'], {
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'sid-cli', hook_event_name: 'PostToolUse' }),
    env: testEnv(env),
  });
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.equal(duplicate.stdout, '');

  const fresh = run(withName(file, 'Alice', ['express', '--force', '--mention', 'Bob', 'stop answer @Bob']), { env });
  assert.equal(fresh.status, 0, fresh.stderr);

  const stop = spawnSync(process.execPath, [CLI, 'codex-hook'], {
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'sid-cli', hook_event_name: 'Stop' }),
    env: testEnv(env),
  });
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(stop.stdout, '');

  const afterStop = run(['inbox', '--for-owner', 'codex:sid-cli', '--json'], { cwd: root, env });
  assert.equal(afterStop.status, 0, afterStop.stderr);
  assert.equal(JSON.parse(afterStop.stdout).total, 1);
});

test('history power filters and JSON stay read-only', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    const bob = (await square.join('Bob', { owner: body, wakeAddress })).participant;
    await bob.express('deploy failed on schema v3 @Alice', { force: true, mentions: ['Alice'] });
    await alice.express('hello @Bob please check', { force: true, mentions: ['Bob'] });
  });

  const grepped = run(withPath(file, ['history', '--regex', '--search', 'schema v3', '--json']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(grepped.status, 0, grepped.stderr);
  const [row] = JSON.parse(grepped.stdout).activities;
  assert.match(row.id, /^act\//);
  assert.match(row.body, /schema v3/);

});

test('history search defaults to a compact character-bounded search view', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    await alice.express(`needle ${'🙂'.repeat(250)}TAIL @Alice`, { force: true, mentions: ['Alice'] });
  });

  const compact = run(withPath(file, ['history', '--regex', '--search', 'needle']), { env: { SQUARE_NOW_MS: '3000' } });
  assert.equal(compact.status, 0, compact.stderr);
  assert.match(compact.stdout, /\b1 match\b/);
  assert.match(compact.stdout, /act\/\d+ · @Alice ·/);
  assert.match(compact.stdout, /needle/);
  assert.match(compact.stdout, /· 0 chars before · \d+ chars after/);
  assert.doesNotMatch(compact.stdout, /TAIL/);
  assert.doesNotMatch(compact.stdout, /�/);
  assert.doesNotMatch(compact.stdout, /footprints/);
  assert.match(compact.stdout, /history --at act\/\d+ -C 2 --full/);

  const full = run(withPath(file, ['history', '--regex', '--search', 'needle', '--full']), { env: { SQUARE_NOW_MS: '3000' } });
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /TAIL/);
  assert.doesNotMatch(full.stdout, /chars after/);
});

test('history search centers snippets on late, multiline, and literal matches', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    await alice.express(`START-${'x'.repeat(260)}-schema\nv3-${'y'.repeat(260)}-END @Alice`, { force: true, mentions: ['Alice'] });
    await alice.express('literal [ bracket @Alice', { force: true, mentions: ['Alice'] });
  });

  const centered = run(withPath(file, ['history', '--regex', '--search', 'schema\\s+v3']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.equal(centered.status, 0, centered.stderr);
  assert.match(centered.stdout, /schema v3/);
  assert.match(centered.stdout, /· \d+ chars before · \d+ chars after/);
  assert.doesNotMatch(centered.stdout, /START-/);
  assert.doesNotMatch(centered.stdout, /-END/);

  const invalid = run(withPath(file, ['history', '--regex', '--search', '[']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid search regex/);

  const literal = run(withPath(file, ['history', '--search', '[']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.equal(literal.status, 0, literal.stderr);
  assert.match(literal.stdout, /literal \[ bracket/);
});

test('history search reports shown and total matches consistently', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    for (let index = 0; index < 12; index += 1) {
      await alice.express(`needle ${index} @Alice`, { force: true, mentions: ['Alice'] });
    }
  }, { hardCap: null });

  const human = run(withPath(file, ['history', '--regex', '--search', 'needle']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /10 of 12 matches/);
  assert.equal(JSON.parse(run(withPath(file, ['history', '--regex', '--search', 'needle', '--json'])).stdout).activities.length, 10);

  const limited = run(withPath(file, ['history', '--regex', '--search', 'needle', '--limit', '3', '--json']));
  assert.equal(limited.status, 0, limited.stderr);
  const limitedRows = JSON.parse(limited.stdout).activities;
  assert.deepEqual(limitedRows.map((row) => row.body), ['needle 9 @Alice', 'needle 10 @Alice', 'needle 11 @Alice']);

  const descending = run(withPath(file, ['history', '--regex', '--search', 'needle', '--limit', '3', '--order', 'desc', '--json']));
  assert.equal(descending.status, 0, descending.stderr);
  assert.deepEqual(JSON.parse(descending.stdout).activities.map((activity) => activity.body), ['needle 11 @Alice', 'needle 10 @Alice', 'needle 9 @Alice']);
});

test('manual participant writes require an explicit location', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-ambiguous-'));
  const first = path.join(cwd, '.square', 'first.square');
  const second = path.join(cwd, '.square', 'second.square');
  fs.mkdirSync(path.dirname(first), { recursive: true });
  assert.equal(run(['--location', first, 'build', '--cap', 'unlimited', '--force'], { cwd, input: 'first' }).status, 0);
  assert.equal(run(['--location', second, 'build', '--cap', 'unlimited', '--force'], { cwd, input: 'second' }).status, 0);
  const refused = run(['--as', 'Alice', 'express', '--force', 'ambiguous'], { cwd });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /needs a square location/);
  assert.match(refused.stderr, /square ls\n$/);
  const readOnly = run(['status'], { cwd });
  assert.notEqual(readOnly.status, 0);
  const doctor = run(['doctor'], { cwd });
  assert.notEqual(doctor.status, 0);
  const doctorFix = run(['doctor', '--fix'], { cwd });
  assert.notEqual(doctorFix.status, 0);
  assert.match(doctorFix.stderr, /doctor needs a square location/);
});

test('history search describes an empty result precisely', async () => {
  const file = await persistSquare(async () => {});
  const result = run(withPath(file, ['history', '--regex', '--search', 'missing.*term']));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /○ no activity matched 'missing\.\*term'/);
  assert.doesNotMatch(result.stdout, /no public activity in this view/);
});

test('status shows attention state and stable activity ids', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    await square.join('Bob', { owner: body, wakeAddress });
    await alice.express('please check @Bob', { force: true, mentions: ['Bob'] });
  });

  const waiting = run(withPath(file, ['status']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.match(waiting.stdout, /@Alice.*up to date/);
  assert.match(waiting.stdout, /@Bob.*1 mention waiting/);
  assert.match(waiting.stdout, /● @Alice · act\/2 · .*\n    talked to @Bob/);
  assert.doesNotMatch(waiting.stdout, /please check @Bob/);

  const personal = run(withName(file, 'Bob', ['status']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.match(personal.stdout, /@Bob.*1 mention waiting/);
  assert.match(personal.stdout, /please check @Bob/);
  assert.match(personal.stdout, /act\/\d+/);
  assert.doesNotMatch(personal.stdout, /@Alice.*up to date/);

  assert.equal(run(withName(file, 'Bob', ['perceive']), { env: { SQUARE_NOW_MS: '5000' } }).status, 0);
  const perceivedUp = run(withPath(file, ['status']), { env: { SQUARE_NOW_MS: '6000' } });
  assert.match(perceivedUp.stdout, /@Bob.*up to date/);
});

test('status header counts only participants still in the square', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    await square.join('Alice', { owner: body, wakeAddress });
    const bob = (await square.join('Bob', { owner: body, wakeAddress })).participant;
    await bob.done();
  });
  const status = run(withPath(file, ['status']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /— 1 in the square/);
});

test('historical body-bearing done events remain readable without becoming perceive messages', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    await square.join('Alice', { owner: body, wakeAddress });
    await square.join('Bob', { owner: body, wakeAddress });
  });
  const perceived = run(withName(file, 'Alice', ['perceive']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(perceived.status, 0, perceived.stderr);
  assert.doesNotMatch(perceived.stdout, /@Bob stepped into the square/);

  // Old artifacts can contain a done body even though new departures are bodyless.
  const artifact = createArtifactPort(file);
  try {
    const seat = (await artifact.read((facts) => facts.seat('Bob'))).value;
    await artifact.transactAs({ kind: 'participant', seat: { participant: seat.participant, owner: seat.owner, generation: seat.generation } }, (facts) =>
      facts.land({ kind: 'done', actor: 'Bob', at: 6000, body: 'final note' }));
  } finally { await artifact.close(); }
  const afterDone = run(withName(file, 'Alice', ['perceive']), { env: { SQUARE_NOW_MS: '7000' } });
  assert.equal(afterDone.status, 0, afterDone.stderr);
  assert.match(afterDone.stdout, /✓ everyone else has left — the square is yours alone/);
  assert.equal((afterDone.stdout.match(/final note/g) ?? []).length, 0);
  const history = run(withPath(file, ['history', '--full']));
  assert.match(history.stdout, /final note/);
  assert.match(run(withName(file, 'Alice', ['status'])).stdout, /final note/);
});

test('an unread join alone does not block express', async () => {
  const file = await persistSquare(async ({ square, body, wakeAddress }) => {
    await square.join('Alice', { owner: body, wakeAddress });
    await square.join('Bob', { owner: body, wakeAddress });
  });

  const expressed = run(withName(file, 'Alice', ['express', '--mention', 'Bob', 'welcome @Bob']), {
    env: { SQUARE_NOW_MS: '200000' },
  });
  assert.equal(expressed.status, 0, expressed.stderr);
  assert.match(expressed.stdout, /you walk over to @Bob — act\/\d+/);
  assert.doesNotMatch(expressed.stdout, /@Bob stepped into the square/);
});

test('throttled, blocked, and capped activities preserve executable drafts', async () => {
  const throttleFile = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    await alice.express('first @Alice', { force: true, mentions: ['Alice'] });
  }, { hardCap: 10, throttlePerMinute: 1 });
  const throttled = run(withName(throttleFile, 'Alice', ['express', '--no-wait', '--mention', 'Alice', '-']), {
    input: 'throttled body @Alice\n',
    env: { SQUARE_NOW_MS: '3000' },
  });
  assertDraftRecovery(throttled, throttleFile, 'Alice', 'throttled body @Alice\n', "express --no-wait --mention 'Alice' -");
  assert.match(throttled.stdout, /a lull opens in (?:\d+s|1m)/);
  assert.doesNotMatch(throttled.stdout, /\d{4,}ms/);

  const capFile = await persistSquare(async ({ square, body, wakeAddress }) => {
    const alice = (await square.join('Alice', { owner: body, wakeAddress })).participant;
    await alice.express('first @Alice', { force: true, mentions: ['Alice'] });
  }, { hardCap: 1 });
  const capped = run(withName(capFile, 'Alice', ['express', '--mention', 'Alice', '-']), { input: 'final body @Alice\n' });
  assert.equal(capped.status, 1, capped.stderr);
  const capDraft = capped.stdout.match(/draft kept: (.+)/)?.[1];
  assert.equal(fs.readFileSync(capDraft, 'utf8'), 'final body @Alice\n');
  assert.match(capped.stdout, /your words stay unsent/);
  assert.match(capped.stdout, /done\n$/);
  assert.doesNotMatch(capped.stdout, /done -|< /);

  const blockedFile = await persistSquare(async ({ square, body, wakeAddress }) => {
    await square.join('Alice', { owner: body, wakeAddress });
    const bob = (await square.join('Bob', { owner: body, wakeAddress })).participant;
    await bob.express('peer @Alice', { force: true, mentions: ['Alice'] });
  }, { hardCap: 10 });
  const blocked = run(withName(blockedFile, 'Alice', ['express', '--mention', 'Bob', '-']), { input: 'blocked body @Bob\n' });
  assertDraftRecovery(blocked, blockedFile, 'Alice', 'blocked body @Bob\n', "express --mention 'Bob' -");
  assert.match(blocked.stdout, /@Bob spoke — .*ago · "peer @Alice"/);
});

test('list bounds recursive discovery by default and accepts an explicit depth', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-list-depth-'));
  const visible = path.join(cwd, 'one', 'two', 'three', 'four', 'visible-square.square');
  const deeper = path.join(cwd, 'one', 'two', 'three', 'four', 'five', 'deeper.square');
  fs.mkdirSync(path.dirname(visible), { recursive: true });
  fs.mkdirSync(path.dirname(deeper), { recursive: true });
  const visibleSquare = await Square.build({ path: visible, markdown: 'visible\n', hardCap: 3 });
  await visibleSquare.close();
  const deeperSquare = await Square.build({ path: deeper, markdown: 'deeper\n', hardCap: 3 });
  await deeperSquare.close();

  const bounded = run(['list'], { cwd });
  assert.equal(bounded.status, 0, bounded.stderr);
  assert.match(bounded.stdout, /visible-square/);
  assert.doesNotMatch(bounded.stdout, /deeper\.square/);

  const expanded = run(['list', '--depth', '5'], { cwd });
  assert.equal(expanded.status, 0, expanded.stderr);
  assert.match(expanded.stdout, /visible-square/);
  assert.match(expanded.stdout, /deeper\.square/);

  const invalid = run(['list', '--depth', '-1'], { cwd });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /square list --help/);

  const depth16 = run(['list', '--depth', '16'], { cwd });
  assert.equal(depth16.status, 0, depth16.stderr);
  const depth17 = run(['list', '--depth', '17'], { cwd });
  assert.equal(depth17.status, 2);
  assert.match(depth17.stderr, /square list --help/);

  const limit100 = run(['list', '--limit', '100'], { cwd });
  assert.equal(limit100.status, 0, limit100.stderr);
  const limit101 = run(['list', '--limit', '101'], { cwd });
  assert.equal(limit101.status, 2);
  assert.match(limit101.stderr, /square list --help/);
});

test('list pages a deterministic relative-path order without overlap', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-list-pages-'));
  const cursor = `pages/m${'x'.repeat(170)}.square`;
  const paths = [
    ...Array.from({ length: 19 }, (_value, index) => `pages/${String(index).padStart(2, '0')}.square`),
    cursor,
    'pages/z.square',
  ];
  for (const relativePath of paths) {
    const file = path.join(cwd, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const square = await Square.build({ path: file, markdown: `${relativePath}\n`, hardCap: 3 });
    await square.close();
  }

  const first = run(['list'], { cwd });
  assert.equal(first.status, 0, first.stderr);
  const firstPaths = first.stdout.split('\n').flatMap((line) => line.match(/^[●○] (.*?) · /)?.[1] ?? []);
  assert.equal(firstPaths.length, 20);
  assert.match(first.stdout, /… 1 more square/);
  assert.ok(first.stdout.includes(`square list --depth 4 --limit 20 --after '${cursor}'`));

  const second = run(['list', '--depth', '4', '--limit', '20', '--after', cursor], { cwd });
  assert.equal(second.status, 0, second.stderr);
  const secondPaths = second.stdout.split('\n').flatMap((line) => line.match(/^[●○] (.*?) · /)?.[1] ?? []);
  assert.deepEqual(secondPaths, ['pages/z.square']);
  assert.equal(secondPaths.some((item) => firstPaths.includes(item)), false);
});

test('list keeps page-more boolean when deterministic discovery stops', async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'square-list-budget-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = Array.from({ length: 21 }, (_value, index) => `a${String(index).padStart(2, '0')}.square`);
  for (const relativePath of paths) {
    const square = await Square.build({ path: path.join(root, relativePath), markdown: `${relativePath}\n`, hardCap: 3 });
    await square.close();
  }
  const entries = [
    ...paths.map((name) => ({ name, isDirectory: () => false, isFile: () => true })),
    ...Array.from({ length: 9_979 }, (_value, index) => ({
      name: `b${String(index).padStart(5, '0')}`,
      isDirectory: () => false,
      isFile: () => false,
    })),
  ].reverse();
  const originalReaddir = fs.promises.readdir;
  // Force the discovery budget through real directory input, not a canned
  // application result. Execute the live CLI command with explicit coordinates.
  t.mock.method(fs.promises, 'readdir', async (directory, ...args) => {
    return directory === root ? entries : originalReaddir(directory, ...args);
  });
  const context = { cwd: root, env: testEnv(), homeDir: os.homedir(), command: 'list' };
  const listed = await listCommand.execute(listCommand.parse([], context), context);
  assert.match(listed, /^  … more squares$/m);
  assert.match(listed, /square list --depth 4 --limit 20 --after 'a19\.square'/);
  assert.match(listed, /the walk stopped early — deeper squares may still be hiding/);
  assert.doesNotMatch(listed, /… \d+ more squares?/);
});

test('list previews bounded context and the three most recently active participants', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-list-preview-'));
  const file = path.join(cwd, '.square', 'preview.square');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const time = tickingClock();
  const body = `codex:${encodeURIComponent(path.resolve(file))}`;
  const square = await Square.build({
    path: file,
    markdown: '## Topic\n\nFirst context line\nSecond context line\n',
    hardCap: 10,
    clock: time.tick,
  });
  await square.join('alice', { owner: body });
  await square.join('bob', { owner: body });
  await square.join('carol', { owner: body });
  await square.join('dave', { owner: body });
  await ((await square.join('alice', { owner: body })).participant).express('@bob latest', { force: true, mentions: ['bob'] });
  await square.close();

  const listed = run(['list'], { cwd });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /context · ## Topic\n\s+· First context line\n\s+· … 1 more line/);
  assert.match(listed.stdout, /participants · @alice · @dave · @carol · … 1 more/);
  assert.doesNotMatch(listed.stdout, /participants[^\n]*bob/);
});

test('list clips displayed path, context, and names without truncating its projection', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-list-character-preview-'));
  const longPath = path.join('p'.repeat(100), 'q'.repeat(100), 'preview.square');
  const file = path.join(cwd, longPath);
  const longContext = `context-${'🐈'.repeat(180)}-tail`;
  const longName = `name-${'名'.repeat(180)}-tail`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `codex:${encodeURIComponent(path.resolve(file))}`;
  const square = await Square.build({ path: file, markdown: `${longContext}\n`, hardCap: 3 });
  await square.join(longName, { owner: body });
  await square.close();

  const discovered = await discover({ cwd });
  const item = discovered.items.find((candidate) => candidate.path === longPath);
  assert.ok(item, 'discovery retains the complete relative path');
  assert.ok(item.context.includes(longContext));
  assert.ok(item.participants.includes(longName));

  const listed = run(['list'], { cwd });
  assert.equal(listed.status, 0, listed.stderr);
  assert.doesNotMatch(listed.stdout, new RegExp(longPath));
  assert.doesNotMatch(listed.stdout, new RegExp(longContext));
  assert.doesNotMatch(listed.stdout, new RegExp(longName));
  assert.match(listed.stdout, /…/);
});

test('list and clipped status use current state and executable hints', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-current-state-'));
  const file = path.join(cwd, '.square', 'state.square');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `codex:${encodeURIComponent(path.resolve(file))}`;
  const square = await Square.build({
    path: file,
    markdown: '## Topic\n\nCurrent state\n',
    hardCap: 10,
    throttlePerMinute: 2,
  });
  const alice = (await square.join('Alice', { owner: body })).participant;
  const bob = (await square.join('Bob', { owner: body })).participant;
  await bob.done();
  await alice.express(`${'x'.repeat(260)} @Alice`, { force: true, mentions: ['Alice'] });
  await square.close();

  const listed = run(['list'], { cwd });
  assert.match(listed.stdout, /1 in the square/);
  assert.doesNotMatch(listed.stdout, /2 in the square/);
  assert.match(listed.stdout, /context · ## Topic\n\s+· Current state/);
  assert.match(listed.stdout, /participants · @Alice/);
  assert.doesNotMatch(listed.stdout, /participants[^\n]*Bob/);

  const status = run(withName(file, 'Alice', ['status']), { cwd });
  assert.match(status.stdout, /more chars/);
  assert.match(status.stdout, /square --location '.*' history --at act\/\d+ -C 2 --full/);
  assert.match(status.stdout, /throttle 2\/min/);
});
