// Isolated from the default suite. Run with: npm run test:cli-process (builds, then this file).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { formatActivityId } from '../../dist/square-core.js';
import { Square } from '../../dist/index.js';
import {
  ROOT,
  CLI,
  run,
  withPath,
  withName,
  persistSquare,
  tickingClock,
  assertDraftRecovery,
  testEnv,
} from '../square-cli-helpers.js';

test('status renders hold duration from the real actor', async () => {
  const file = await persistSquare(async ({ square }) => {
    const host = await square.join('Host');
    await host.hold('pause');
  });
  const held = run(withPath(file, ['status']), { env: { SQUARE_NOW_MS: '62000' } });
  assert.equal(held.status, 0, held.stderr);
  assert.match(held.stdout, /@Host raised a hand — pause · 1m/);
  assert.doesNotMatch(held.stdout, /12m/);
});

test('status stays compact and focuses on the current square', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    const bob = await square.join('Bob');
    for (let index = 0; index < 12; index += 1) {
      await alice.express(`activity ${index} @Bob`, { force: true, mentions: ['Bob'] });
    }
    await bob.done('leaving');
    await alice.express('last activity @Alice', { force: true, mentions: ['Alice'] });
  }, { hardCap: 100, markdown: '## Topic\n\nTesting status' });

  const status = run(withName(file, 'Alice', ['status']), { env: { SQUARE_NOW_MS: '22000' } });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /1 active · 1 done · cap 100 · throttle none/);
  assert.match(status.stdout, /@Alice · 13 activities/);
  assert.doesNotMatch(status.stdout, /Bob/);
  assert.doesNotMatch(status.stdout, /─/);
});

test('status previews ten active participants and links to the complete roster', async () => {
  const peers = Array.from({ length: 12 }, (_value, index) => `Peer${String(index + 1).padStart(2, '0')}`);
  const file = await persistSquare(async ({ square }) => {
    await square.join('Viewer');
    for (const name of peers) {
      const participant = await square.join(name);
      await participant.express(`recent activity from ${name}`, { force: true });
    }
  }, { hardCap: 100 });

  const status = run(withName(file, 'Viewer', ['status']), { env: { SQUARE_NOW_MS: '100000' } });
  assert.equal(status.status, 0, status.stderr);
  const around = status.stdout.slice(status.stdout.indexOf('around the square'), status.stdout.indexOf('\n\nlatest'));
  const participantRows = around.split('\n').filter((line) => /^  [◎●○] @/.test(line));
  assert.equal(participantRows.length, 10);
  assert.deepEqual(participantRows.map((line) => line.match(/@(\S+) ·/)?.[1]), ['Viewer', ...peers.slice(3).reverse()]);
  assert.match(status.stdout, /^  ○ … 3 more participants$/m);
  assert.ok(status.stdout.includes(`» square --location '${file}' participants --limit 13\n`));
  assert.doesNotMatch(status.stdout, /--as 'Viewer' participants/);

  const participants = run(withPath(file, ['participants']), { env: { SQUARE_NOW_MS: '100000' } });
  assert.equal(participants.status, 0, participants.stderr);
  assert.equal(participants.stdout.split('\n').filter((line) => /^  [◎●○] /.test(line)).length, 13);
  assert.match(participants.stdout, /Peer01/);
  assert.match(participants.stdout, /Peer12/);
  assert.doesNotMatch(participants.stdout, /@Peer/);
});

test('participants bound the roster without pagination', async () => {
  const names = Array.from({ length: 21 }, (_value, index) => `Peer${String(index + 1).padStart(2, '0')}`);
  const file = await persistSquare(async ({ square }) => {
    for (const name of names) await square.join(name);
  }, { hardCap: 100 });

  const defaultPage = run(withPath(file, ['participants']), { env: { SQUARE_NOW_MS: '100000' } });
  assert.equal(defaultPage.status, 0, defaultPage.stderr);
  const rows = defaultPage.stdout.split('\n').filter((line) => /^  [◎●○] \S+ ·/.test(line));
  assert.deepEqual(rows.map((line) => line.match(/^  [◎●○] (\S+) ·/)?.[1]), names.slice(0, 20));
  assert.doesNotMatch(defaultPage.stdout, /@Peer/);
  assert.match(defaultPage.stdout, /^  ○ 20 of 21 participants shown$/m);
  assert.match(defaultPage.stdout, new RegExp(`» square --location '${file}' participants --limit 21`));

  const complete = run(withPath(file, ['participants', '--limit', '21']), { env: { SQUARE_NOW_MS: '100000' } });
  assert.equal(complete.status, 0, complete.stderr);
  assert.doesNotMatch(complete.stdout, /participants shown|participants --limit/);

  const zero = run(withPath(file, ['participants', '--limit', '0']));
  assert.equal(zero.status, 2);
  assert.match(zero.stderr, /--limit needs a positive integer/);

  const overLimit = run(withPath(file, ['participants', '--limit', '101']));
  assert.equal(overLimit.status, 2);
  assert.match(overLimit.stderr, /--limit is capped at 100/);
  assert.match(overLimit.stderr, new RegExp(`» square --location '${file}' participants --limit 100`));

  const unsupported = run(withPath(file, ['participants', '--all']));
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stderr, /participants --help/);
});

test('participants do not offer a rejected complete-roster limit', async () => {
  const file = await persistSquare(async ({ square }) => {
    for (let index = 1; index <= 101; index += 1) await square.join(`Peer${String(index).padStart(3, '0')}`);
  }, { hardCap: 100 });

  const page = run(withPath(file, ['participants', '--limit', '100']), { env: { SQUARE_NOW_MS: '100000' } });
  assert.equal(page.status, 0, page.stderr);
  assert.match(page.stdout, /^  ○ 100 of 101 participants shown$/m);
  assert.doesNotMatch(page.stdout, /participants --limit 101/);
});

test('history refuses an unbounded merged context and offers a bounded executable command', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    for (let index = 1; index <= 101; index += 1) {
      await alice.express(`activity ${index}`, { force: true });
    }
  }, { hardCap: 200 });

  const oversized = run(withPath(file, ['history', '--at', 'act/100', '-C', '100', '--json']));
  assert.equal(oversized.status, 2);
  assert.match(oversized.stderr, /history is capped at 100 activities/);
  assert.match(oversized.stderr, new RegExp(`» square --location '${file}' history --at act/100 -C 100 --json --limit 100`));

  const bounded = run(withPath(file, ['history', '--at', 'act/100', '-C', '100', '--json', '--limit', '100']));
  assert.equal(bounded.status, 0, bounded.stderr);
  assert.equal(bounded.stdout.trim().split('\n').length, 100);
});

test('status has no participant preview affordance at ten active participants', async () => {
  const file = await persistSquare(async ({ square }) => {
    for (let index = 1; index <= 10; index += 1) await square.join(`Peer${String(index).padStart(2, '0')}`);
  }, { hardCap: 100 });

  const status = run(withPath(file, ['status']), { env: { SQUARE_NOW_MS: '100000' } });
  assert.equal(status.status, 0, status.stderr);
  assert.doesNotMatch(status.stdout, /^  ○ … \d+ more participants$/m);
  assert.doesNotMatch(status.stdout, /^» square --location .* participants$/m);
});

test('express does not surface delivery-health diagnostics during normal use', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    const bob = await square.join('Bob');
    await (await square.join('Alice')).express('hey @Bob', { force: true, mentions: ['Bob'] });
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
  assert.match(diagnosed.stdout, /awaiting: 1/);
});

test('catch --mention renders matching says and suppresses room changes', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    const bob = await square.join('Bob');
    await bob.express('hello @Alice', { force: true, mentions: ['Alice'] });
    await square.join('Cara');
    void alice;
  });

  const watched = run(withName(file, 'Alice', ['catch', '--now', '--mention']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(watched.status, 0, watched.stderr);
  assert.match(watched.stdout, /calls your name across the square — @Alice/);
  assert.match(watched.stdout, /@Bob\s+#1/);
  assert.doesNotMatch(watched.stdout, /while your back was turned/);
  assert.doesNotMatch(watched.stdout, /Cara stepped into the square/);
});

test('catch --from renders named peers and rejects the removed --by flag', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    const bob = await square.join('Bob');
    const cara = await square.join('Cara');
    await bob.express('hello from bob @Alice', { force: true, mentions: ['Alice'] });
    await cara.express('hello from cara @Alice', { force: true, mentions: ['Alice'] });
    await bob.done('bye');
  });

  const watched = run(withName(file, 'Alice', ['catch', '--now', '--from', 'Bob']), { env: { SQUARE_NOW_MS: '7000' } });
  assert.equal(watched.status, 0, watched.stderr);
  assert.match(watched.stdout, /@Bob stepped into the square/);
  assert.match(watched.stdout, /@Bob\s+#1/);
  assert.match(watched.stdout, /@Bob stepped out of the square — done/);
  assert.doesNotMatch(watched.stdout, /Cara stepped into the square/);
  assert.doesNotMatch(watched.stdout, /hello from cara/);

  const removed = run(withName(file, 'Alice', ['catch', '--now', '--by', 'Bob']));
  assert.notEqual(removed.status, 0);
  assert.match(removed.stderr, /✕ catch does not know --by/);
  assert.match(removed.stderr, /» square catch --help\n$/);
});

test('catch --now around the square excludes the current actor', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    await square.join('Bob');
    await square.join('Cara');
  });

  assert.equal(run(withName(file, 'Alice', ['catch', '--now']), { env: { SQUARE_NOW_MS: '4000' } }).status, 0);
  assert.equal(run(withName(file, 'Bob', ['catch', '--now']), { env: { SQUARE_NOW_MS: '5000' } }).status, 0);

  const watched = run(withName(file, 'Alice', ['catch', '--now']), { env: { SQUARE_NOW_MS: '6000' } });
  assert.equal(watched.status, 0, watched.stderr);
  assert.match(watched.stdout, /around the square/);
  assert.match(watched.stdout, /Bob/);
  assert.doesNotMatch(watched.stdout, /^\s*[◎●○×]\s+Alice\b/m);
});

test('history with an explicit page and no truncation renders the archive', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    const bob = await square.join('Bob');
    await bob.express('hello @Alice', { force: true, mentions: ['Alice'] });
    await bob.done('bye');
  });

  const activities = run(withPath(file, ['history', '--limit', '100', '--no-truncate']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(activities.status, 0, activities.stderr);
  assert.match(activities.stdout, /@Bob\s+#1/);
  assert.match(activities.stdout, /hello @Alice/);
  assert.match(activities.stdout, /@Bob stepped out of the square — done/);
  assert.doesNotMatch(activities.stdout, /\(No public activity in this view\.\)/);
});

test('history rejects an explicit participant identity with a retry that removes it', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
  });

  const history = run(withName(file, 'Alice', ['history', '--limit', '3']));
  assert.equal(history.status, 2);
  assert.match(history.stderr, /history is an archive and does not use --as/);
  assert.match(history.stderr, new RegExp(`» square --location ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} history --limit 3`));
  assert.doesNotMatch(history.stderr, /Expected one of|@Alice/);

  const help = run(withName(file, 'Alice', ['history', '--help']));
  assert.equal(help.status, 2);
  assert.match(help.stderr, /history is an archive and does not use --as/);
  assert.match(help.stderr, new RegExp(`» square --location ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} history --help`));
});

test('unknown participant errors stay bounded and point to the roster', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
  });

  const expressed = run(withName(file, 'Alice', ['express', '--mention', 'Eve', 'hello']));
  assert.equal(expressed.status, 2);
  assert.match(expressed.stderr, /Unknown mention target @Eve/);
  assert.doesNotMatch(expressed.stderr, /Expected one of|@Alice/);
  assert.match(expressed.stderr, new RegExp(`» square --location '${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' participants`));
});

test('history pages with stable activity-id cursors and prints the next page', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
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
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    const bob = await square.join('Bob');
    await bob.express('hello @Alice', { force: true, mentions: ['Alice'] });
    await bob.done('bye');
  });

  const activities = run(withPath(file, ['history', '--since', '1970-01-01T00:00:03.500Z']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(activities.status, 0, activities.stderr);
  assert.doesNotMatch(activities.stdout, /Bob\s+#1/);
  assert.match(activities.stdout, /@Bob stepped out of the square — done/);
});

test('ambient catch and history render full body to a mention target and presence to others', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    await square.join('Bob');
    await square.join('Cara');
    await alice.express('secret reach phrase @Bob', { force: true, mentions: ['Bob'] });
  });

  const bobWatch = run(withName(file, 'Bob', ['catch', '--now']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(bobWatch.status, 0, bobWatch.stderr);
  assert.match(bobWatch.stdout, /secret reach phrase/);
  assert.match(bobWatch.stdout, /@Alice\s+#1/);

  const caraWatch = run(withName(file, 'Cara', ['catch', '--now']), { env: { SQUARE_NOW_MS: '6000' } });
  assert.equal(caraWatch.status, 0, caraWatch.stderr);
  assert.match(caraWatch.stdout, /● @Alice #1 · act\/3 · .*\n  talked to @Bob/);
  assert.doesNotMatch(caraWatch.stdout, /secret reach phrase/);

  const ambient = run(withPath(file, ['history', '--limit', '100']), { env: { SQUARE_NOW_MS: '7000' } });
  assert.equal(ambient.status, 0, ambient.stderr);
  assert.match(ambient.stdout, /● @Alice #1 · act\/3 · .*\n  secret reach phrase @Bob/);
  assert.match(ambient.stdout, /→ @Alice, @Bob, @Cara were here/);
  assert.doesNotMatch(ambient.stdout, /→ @(?:Alice|Bob|Cara) was here/);

  const archive = run(withPath(file, ['history', '--limit', '100', '--no-truncate']), { env: { SQUARE_NOW_MS: '8000' } });
  assert.equal(archive.status, 0, archive.stderr);
  assert.match(archive.stdout, /secret reach phrase @Bob/);

  const exact = run(withPath(file, ['history', '--at', formatActivityId(3), '-C', '0']), { env: { SQUARE_NOW_MS: '9000' } });
  assert.equal(exact.status, 0, exact.stderr);
  assert.match(exact.stdout, /secret reach phrase @Bob/);

  const json = run(withPath(file, ['history', '--at', formatActivityId(3), '-C', '0', '--json']), { env: { SQUARE_NOW_MS: '10000' } });
  assert.equal(json.status, 0, json.stderr);
  assert.match(JSON.parse(json.stdout).body, /secret reach phrase/);

  assert.equal(run(withName(file, 'Alice', ['express', '--force', '--mention', 'Cara', '--mention', 'bob', 'two targets @Cara then @bob']), { env: { SQUARE_NOW_MS: '10500' } }).status, 0);
  const laterJoin = run(withName(file, 'Dan', ['join', '--last', '100']), { env: { SQUARE_NOW_MS: '11000' } });
  assert.equal(laterJoin.status, 0, laterJoin.stderr);
  assert.match(laterJoin.stdout, /● @Alice #1 · act\/3 · .*\n  talked to @Bob/);
  assert.match(laterJoin.stdout, /● @Alice #2 · act\/4 · .*\n  talked to @Cara and @bob/);
  assert.doesNotMatch(laterJoin.stdout, /secret reach phrase/);
  assert.doesNotMatch(laterJoin.stdout, /two targets/);
});

test('history groups every participant footprint at a shared projection anchor', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    await square.join('Bob');
    await square.join('Cara');
    await alice.express('shared coordinate @Bob', { force: true, mentions: ['Bob'] });
  });

  const bobCatch = run(withName(file, 'Bob', ['catch', '--now']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(bobCatch.status, 0, bobCatch.stderr);

  const history = run(withPath(file, ['history', '--limit', '100']), { env: { SQUARE_NOW_MS: '6000' } });
  assert.equal(history.status, 0, history.stderr);
  assert.match(history.stdout, /→ @Alice, @Bob, @Cara were here/);
  assert.doesNotMatch(history.stdout, /→ @(?:Alice|Bob|Cara) was here/);
});

test('presence rendering omits a body when a bare say has no visible mention target', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    const bob = await square.join('Bob');
    await square.join('Cara');
    await bob.listen('Alice');
    await alice.express('listener-only answer', { force: true });
  });

  const caraWatch = run(withName(file, 'Cara', ['catch', '--now']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(caraWatch.status, 0, caraWatch.stderr);
  assert.match(caraWatch.stdout, /● @Alice #1 · act\/4 · .*\n\n»/);
  assert.doesNotMatch(caraWatch.stdout, /\n  spoke/);
  assert.doesNotMatch(caraWatch.stdout, /talked to(?:\s|$)/m);
  assert.doesNotMatch(caraWatch.stdout, /listener-only answer/);
});

test('history expands the newest ten activities in chronological order', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
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

test('history expands one result, previews multiple results, and --no-truncate expands all', async () => {
  const firstTail = 'FIRST-TAIL';
  const secondTail = 'SECOND-TAIL';
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
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
  assert.match(multiple.stdout, /history --no-truncate/);

  const expanded = run(withPath(file, ['history', '--limit', '2', '--no-truncate']));
  assert.equal(expanded.status, 0, expanded.stderr);
  assert.match(expanded.stdout, new RegExp(firstTail));
  assert.match(expanded.stdout, new RegExp(secondTail));
});

test('bell quota refusal prints the next timestamp and express help keeps --bell', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    await square.join('Bob');
    await square.join('Cara');
    await alice.express('bell one', { force: true, reach: 'bell' });
  });

  const secondBell = run(withName(file, 'Alice', ['express', '--bell', 'bell two']), { env: { SQUARE_NOW_MS: '7000' } });
  assert.equal(secondBell.status, 1, secondBell.stderr);
  assert.match(secondBell.stdout, /the bell stays quiet for now/);
  assert.match(secondBell.stdout, /you can ring it again at 1970-01-01 09:00:04 \+08:00/);

  const removed = run(withName(file, 'Alice', ['express', '--force', '--beside', 'Bob', 'gone @Bob']));
  assert.notEqual(removed.status, 0);
  assert.match(removed.stderr, /express does not know --beside/);
  assert.match(removed.stderr, /» square express --help\n$/);

  const help = run(['express', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /beside/);
  assert.match(help.stdout, /--bell/);
  assert.match(help.stdout, /--reply <activity-id>/);
  assert.match(help.stdout, /act\/12/);
  assert.doesNotMatch(help.stdout, /act\/N/);
});

test('express --reply renders the causal activity reference', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    const bob = await square.join('Bob');
    await alice.express('question @Bob', { force: true, mentions: ['Bob'] });
    await bob.express('answer @Alice', { force: true, mentions: ['Alice'], reply: 'act/2' });
  });

  const history = run(withPath(file, ['history', '--at', formatActivityId(3), '-C', '0', '--no-truncate']));
  assert.equal(history.status, 0, history.stderr);
  assert.match(history.stdout, /act\/3.*replies to act\/2/);

  const json = run(withPath(file, ['history', '--at', formatActivityId(3), '-C', '0', '--json']));
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).reply, formatActivityId(2));
});

test('history --at accepts multiple coordinates and unions their context windows', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    const bob = await square.join('Bob');
    await alice.express('first @Bob', { force: true, mentions: ['Bob'] });
    await bob.express('second @Alice', { force: true, mentions: ['Alice'] });
  });

  const comma = run(withPath(file, ['history', '--at', 'act/2,act/3', '-C', '0', '--json']));
  assert.equal(comma.status, 0, comma.stderr);
  assert.deepEqual(comma.stdout.trim().split('\n').map((line) => JSON.parse(line).id), ['act/2', 'act/3']);

  const repeated = run(withPath(file, ['history', '--at', 'act/2', '--at', 'act/3', '-C', '0', '--json']));
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(repeated.stdout.trim().split('\n').map((line) => JSON.parse(line).id), ['act/2', 'act/3']);
});

test('inbox stays read-only while codex admits pending attention once at a boundary', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    await square.join('Bob');
    await alice.express('hey @Bob', { force: true, mentions: ['Bob'] });
  });
  const root = path.dirname(file);
  const registry = path.join(root, 'sessions.ndjsonl');
  const presented = path.join(root, 'presented.ndjsonl');
  const env = { SQUARE_REGISTRY: registry, SQUARE_PRESENTED: presented };

  const register = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { recordJoin } from ${JSON.stringify(path.join(ROOT, 'dist/registry.js'))};
    recordJoin('sid-cli', 'Bob', ${JSON.stringify(file)}, { channel: 'codex' });
  `], { encoding: 'utf8', env: testEnv(env) });
  assert.equal(register.status, 0, register.stderr);

  const inspected1 = run(['inbox', '--for-session', 'sid-cli', '--json'], { env });
  assert.equal(inspected1.status, 0, inspected1.stderr);
  const pendingInbox = JSON.parse(inspected1.stdout);
  assert.equal(pendingInbox.length, 1);
  assert.equal(pendingInbox[0].notifications.length, 1);

  const inspected2 = run(['inbox', '--for-session', 'sid-cli', '--json'], { env });
  assert.equal(inspected2.status, 0, inspected2.stderr);
  assert.deepEqual(JSON.parse(inspected2.stdout), pendingInbox);

  const inject = spawnSync(process.execPath, [CLI, 'codex-hook'], {
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'sid-cli', hook_event_name: 'PostToolUse' }),
    env: testEnv(env),
  });
  assert.equal(inject.status, 0, inject.stderr);
  assert.match(inject.stdout, /"hookEventName":"PostToolUse"/);

  const duplicate = spawnSync(process.execPath, [CLI, 'codex-hook'], {
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'sid-cli', hook_event_name: 'PostToolUse' }),
    env: testEnv(env),
  });
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.equal(duplicate.stdout, '');

  const fresh = run(withName(file, 'Alice', ['express', '--force', '--mention', 'Bob', 'stop answer @Bob']), { env });
  assert.equal(fresh.status, 0, fresh.stderr);

  const registerStop = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { recordJoin } from ${JSON.stringify(path.join(ROOT, 'dist/registry.js'))};
    recordJoin('sid-cli-stop', 'Bob', ${JSON.stringify(file)}, { channel: 'codex' });
  `], { encoding: 'utf8', env: testEnv(env) });
  assert.equal(registerStop.status, 0, registerStop.stderr);

  const stop = spawnSync(process.execPath, [CLI, 'codex-hook'], {
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'sid-cli-stop', hook_event_name: 'Stop' }),
    env: testEnv(env),
  });
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /"systemMessage":/);
  assert.match(stop.stdout, /stop answer @Bob/);
});

test('history power filters and jsonl stay read-only', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    const bob = await square.join('Bob');
    await bob.express('deploy failed on schema v3 @Alice', { force: true, mentions: ['Alice'] });
    await alice.express('hello @Bob please check', { force: true, mentions: ['Bob'] });
  });

  const grepped = run(withPath(file, ['history', '--grep', 'schema v3', '--json']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(grepped.status, 0, grepped.stderr);
  const row = JSON.parse(grepped.stdout.trim().split('\n').at(-1));
  assert.match(row.id, /^act\//);
  assert.match(row.body, /schema v3/);

});

test('history grep defaults to a compact character-bounded search view', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    await alice.express(`needle ${'🙂'.repeat(250)}TAIL @Alice`, { force: true, mentions: ['Alice'] });
  });

  const compact = run(withPath(file, ['history', '--grep', 'needle']), { env: { SQUARE_NOW_MS: '3000' } });
  assert.equal(compact.status, 0, compact.stderr);
  assert.match(compact.stdout, /\b1 match\b/);
  assert.match(compact.stdout, /act\/\d+ · @Alice ·/);
  assert.match(compact.stdout, /needle/);
  assert.match(compact.stdout, /· 0 chars before · \d+ chars after/);
  assert.doesNotMatch(compact.stdout, /TAIL/);
  assert.doesNotMatch(compact.stdout, /�/);
  assert.doesNotMatch(compact.stdout, /footprints/);
  assert.match(compact.stdout, /history --at act\/\d+ -C 2 --no-truncate/);

  const full = run(withPath(file, ['history', '--grep', 'needle', '--no-truncate']), { env: { SQUARE_NOW_MS: '3000' } });
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /TAIL/);
  assert.doesNotMatch(full.stdout, /chars after/);
});

test('history grep centers snippets on late, multiline, and fixed matches', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    await alice.express(`START-${'x'.repeat(260)}-schema\nv3-${'y'.repeat(260)}-END @Alice`, { force: true, mentions: ['Alice'] });
    await alice.express('literal [ bracket @Alice', { force: true, mentions: ['Alice'] });
  });

  const centered = run(withPath(file, ['history', '--grep', 'schema\\s+v3']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.equal(centered.status, 0, centered.stderr);
  assert.match(centered.stdout, /schema v3/);
  assert.match(centered.stdout, /· \d+ chars before · \d+ chars after/);
  assert.doesNotMatch(centered.stdout, /START-/);
  assert.doesNotMatch(centered.stdout, /-END/);

  const invalid = run(withPath(file, ['history', '--grep', '[']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid --grep regex/);

  const literal = run(withPath(file, ['history', '--fixed', '[']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.equal(literal.status, 0, literal.stderr);
  assert.match(literal.stdout, /literal \[ bracket/);
});

test('history search reports shown and total matches consistently', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    for (let index = 0; index < 12; index += 1) {
      await alice.express(`needle ${index} @Alice`, { force: true, mentions: ['Alice'] });
    }
  }, { hardCap: null });

  const human = run(withPath(file, ['history', '--grep', 'needle']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /10 of 12 matches/);
  assert.equal(run(withPath(file, ['history', '--grep', 'needle', '--json'])).stdout.trim().split('\n').length, 10);

  const limited = run(withPath(file, ['history', '--grep', 'needle', '--limit', '3', '--json']));
  assert.equal(limited.status, 0, limited.stderr);
  const limitedRows = limited.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(limitedRows.map((row) => row.body), ['needle 9 @Alice', 'needle 10 @Alice', 'needle 11 @Alice']);

  const descending = run(withPath(file, ['history', '--grep', 'needle', '--limit', '3', '--order', 'desc', '--json']));
  assert.equal(descending.status, 0, descending.stderr);
  assert.deepEqual(descending.stdout.trim().split('\n').map((line) => JSON.parse(line).body), ['needle 11 @Alice', 'needle 10 @Alice', 'needle 9 @Alice']);
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
  assert.match(refused.stderr, /» square ls\n$/);
  const readOnly = run(['status'], { cwd });
  assert.notEqual(readOnly.status, 0);
  const doctor = run(['doctor'], { cwd });
  assert.notEqual(doctor.status, 0);
  const doctorFix = run(['doctor', '--fix'], { cwd });
  assert.notEqual(doctorFix.status, 0);
  assert.match(doctorFix.stderr, /doctor needs a square location/);
});

test('history grep describes an empty result precisely', async () => {
  const file = await persistSquare(async () => {});
  const result = run(withPath(file, ['history', '--grep', 'missing.*term']));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /○ no activity matched 'missing\.\*term'/);
  assert.doesNotMatch(result.stdout, /no public activity in this view/);
});

test('status shows attention state and stable activity ids', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    await square.join('Bob');
    await alice.express('please check @Bob', { force: true, mentions: ['Bob'] });
  });

  const waiting = run(withPath(file, ['status']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.match(waiting.stdout, /@Alice.*1 change waiting/);
  assert.match(waiting.stdout, /@Bob.*1 attention waiting/);
  assert.match(waiting.stdout, /● @Alice #1 · act\/2 · .*\n    talked to @Bob/);
  assert.doesNotMatch(waiting.stdout, /please check @Bob/);

  const personal = run(withName(file, 'Bob', ['status']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.match(personal.stdout, /@Bob.*1 attention waiting/);
  assert.match(personal.stdout, /please check @Bob/);
  assert.match(personal.stdout, /act\/\d+/);
  assert.doesNotMatch(personal.stdout, /@Alice.*caught up/);

  assert.equal(run(withName(file, 'Bob', ['catch', '--now']), { env: { SQUARE_NOW_MS: '5000' } }).status, 0);
  const caughtUp = run(withPath(file, ['status']), { env: { SQUARE_NOW_MS: '6000' } });
  assert.match(caughtUp.stdout, /@Bob.*caught up/);
});

test('status header counts only participants still in the square', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    const bob = await square.join('Bob');
    await bob.done('finished');
  });
  const status = run(withPath(file, ['status']), { env: { SQUARE_NOW_MS: '4000' } });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /— 1 in the square/);
});

test('room changes and final notes remain visible without duplicate done events', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    const bob = await square.join('Bob');
    await bob.hold('pause');
    await bob.resume();
  });
  const caught = run(withName(file, 'Alice', ['catch', '--now']), { env: { SQUARE_NOW_MS: '5000' } });
  assert.equal(caught.status, 0, caught.stderr);
  assert.match(caught.stdout, /@Bob stepped into the square/);
  assert.match(caught.stdout, /@Bob raised a hand — pause/);
  assert.match(caught.stdout, /@Bob lowered the hand/);

  assert.equal(run(withName(file, 'Bob', ['done', '-']), { env: { SQUARE_NOW_MS: '6000' }, input: 'final note\n' }).status, 0);
  const afterDone = run(withName(file, 'Alice', ['catch', '--now']), { env: { SQUARE_NOW_MS: '7000' } });
  assert.equal(afterDone.status, 0, afterDone.stderr);
  assert.match(afterDone.stdout, /final note/);
  assert.equal((afterDone.stdout.match(/final note/g) ?? []).length, 1);
  assert.match(run(withPath(file, ['history', '--no-truncate'])).stdout, /final note/);
  assert.match(run(withName(file, 'Alice', ['status'])).stdout, /final note/);
});

test('status attention and express blocker agree on unread square changes', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    const bob = await square.join('Bob');
    await bob.hold('pause');
  });
  const status = run(withName(file, 'Alice', ['status']), { env: { SQUARE_NOW_MS: '200000' } });
  assert.match(status.stdout, /@Alice.*changes waiting/);
  const noWaitAct = run(withName(file, 'Alice', ['express', '--no-wait', '--mention', 'Bob', 'late body @Bob']), { env: { SQUARE_NOW_MS: '200000' } });
  assert.match(noWaitAct.stdout, /a hand is raised/);
  assert.match(noWaitAct.stdout, /draft kept/);
  assert.equal(run(withName(file, 'Bob', ['resume']), { env: { SQUARE_NOW_MS: '210000' } }).status, 0);
  const unheld = run(withName(file, 'Alice', ['express', '--no-wait', '--mention', 'Bob', 'after resume @Bob']), { env: { SQUARE_NOW_MS: '220000' } });
  assert.match(unheld.stdout, /square moved behind your back/);
  assert.match(unheld.stdout, /catch --now/);
});

test('an unread join alone does not block express', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    await square.join('Bob');
  });

  const expressed = run(withName(file, 'Alice', ['express', '--mention', 'Bob', 'welcome @Bob']), {
    env: { SQUARE_NOW_MS: '200000' },
  });
  assert.equal(expressed.status, 0, expressed.stderr);
  assert.match(expressed.stdout, /heads turn your way/);
  assert.match(expressed.stdout, /@Bob stepped into the square/);
  assert.doesNotMatch(expressed.stdout, /catch --now/);
});

test('held, throttled, blocked, and capped activities preserve executable drafts', async () => {
  const heldFile = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    const host = await square.join('Host');
    await host.hold('pause');
  }, { hardCap: 10 });
  assertDraftRecovery(run(withName(heldFile, 'Alice', ['express', '--no-wait', '--mention', 'Host', '-']), { input: 'held body @Host\n' }), heldFile, 'Alice', 'held body @Host\n', 'express --mention Host -');

  const throttleFile = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    await alice.express('first @Alice', { force: true, mentions: ['Alice'] });
  }, { hardCap: 10, throttlePerMinute: 1 });
  const throttled = run(withName(throttleFile, 'Alice', ['express', '--no-wait', '--mention', 'Alice', '-']), {
    input: 'throttled body @Alice\n',
    env: { SQUARE_NOW_MS: '3000' },
  });
  assertDraftRecovery(throttled, throttleFile, 'Alice', 'throttled body @Alice\n', 'express --mention Alice -');
  assert.match(throttled.stdout, /next opening in (?:\d+s|1m)/);
  assert.doesNotMatch(throttled.stdout, /\d{4,}ms/);

  const capFile = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    await alice.express('first @Alice', { force: true, mentions: ['Alice'] });
  }, { hardCap: 1 });
  assertDraftRecovery(run(withName(capFile, 'Alice', ['express', '--mention', 'Alice', '-']), { input: 'final body @Alice\n' }), capFile, 'Alice', 'final body @Alice\n', 'done -');

  const blockedFile = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    const bob = await square.join('Bob');
    await bob.express('peer @Alice', { force: true, mentions: ['Alice'] });
  }, { hardCap: 10 });
  assertDraftRecovery(run(withName(blockedFile, 'Alice', ['express', '--mention', 'Bob', '-']), { input: 'blocked body @Bob\n' }), blockedFile, 'Alice', 'blocked body @Bob\n', 'express --mention Bob -');
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
});

test('list previews bounded context and the three most recently active participants', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-list-preview-'));
  const file = path.join(cwd, '.square', 'preview.square');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const time = tickingClock();
  const square = await Square.build({
    path: file,
    markdown: '## Topic\n\nFirst context line\nSecond context line\n',
    hardCap: 10,
    clock: time.tick,
  });
  await square.join('alice');
  await square.join('bob');
  await square.join('carol');
  await square.join('dave');
  await (await square.join('alice')).express('@bob latest', { force: true, mentions: ['bob'] });
  await square.close();

  const listed = run(['list'], { cwd });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /context · ## Topic\n\s+· First context line\n\s+· … 1 more line/);
  assert.match(listed.stdout, /participants · @alice · @dave · @carol · … 1 more/);
  assert.doesNotMatch(listed.stdout, /participants[^\n]*bob/);
});

test('list, participants, and clipped status use current state and executable hints', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-current-state-'));
  const file = path.join(cwd, '.square', 'state.square');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const square = await Square.build({
    path: file,
    markdown: '## Topic\n\nCurrent state\n',
    hardCap: 10,
    throttlePerMinute: 2,
  });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  await bob.done('finished');
  await alice.express(`${'x'.repeat(260)} @Alice`, { force: true, mentions: ['Alice'] });
  await square.close();

  const listed = run(['list'], { cwd });
  assert.match(listed.stdout, /1 in square/);
  assert.doesNotMatch(listed.stdout, /2 in square/);
  assert.match(listed.stdout, /context · ## Topic\n\s+· Current state/);
  assert.match(listed.stdout, /participants · @Alice/);
  assert.doesNotMatch(listed.stdout, /participants[^\n]*Bob/);

  const participants = run(withPath(file, ['participants']), { cwd });
  assert.match(participants.stdout, /Alice · active/);
  assert.match(participants.stdout, /Bob · done/);
  assert.doesNotMatch(participants.stdout, /@Alice|@Bob/);
  assert.doesNotMatch(participants.stdout, /^presence$/m);

  const status = run(withName(file, 'Alice', ['status']), { cwd });
  assert.match(status.stdout, /more chars/);
  assert.match(status.stdout, /» square --location '.*' history --at act\/\d+ -C 2 --no-truncate/);
  assert.match(status.stdout, /throttle 2\/min/);
});
