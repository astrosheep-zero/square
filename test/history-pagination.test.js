import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Square } from '../dist/index.js';
import { run, testEnv, withPath } from './square-cli-helpers.js';

async function fixture(t, fill) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-history-pages-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
  const file = path.join(root, 'history fixture.square');
  const env = testEnv({ HOME: root, USERPROFILE: root, SQUARE_HOST_LEDGER_ROOT: path.join(root, 'ledger') });
  let now = 0;
  const square = await Square.build({ path: file, markdown: 'History pagination', hardCap: null, env, clock: () => now += 1000 });
  let activities;
  try {
    await fill(square);
    activities = await square.history();
  } finally {
    await square.close();
  }
  return {
    file,
    activities,
    history(args = []) {
      const result = run(withPath(file, ['history', ...args]), { env });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    },
  };
}

function continuation(output) {
  return output.split('\n').find((line) => /^square .* history .*--(?:before|after) act\/\d+ --limit \d+$/.test(line));
}

function bodyNumbers(output) {
  return [...output.matchAll(/^  decision (\d+)$/gm)].map((match) => Number(match[1]));
}

test('human history counts visible activity before limiting and machine pages retain hidden events', async (t) => {
  const item = await fixture(t, async (square) => {
    const speaker = await square.join('Speaker');
    await speaker.express('the earlier decision remains visible', { force: true });
    for (let index = 0; index < 12; index += 1) await square.join(`Guest${index}`);
  });
  const before = fs.readFileSync(item.file);
  const human = item.history();
  assert.match(human, /the earlier decision remains visible/);
  assert.doesNotMatch(human, /no public activity/);
  assert.equal(continuation(human), undefined);

  const json = item.history(['--json']).trim().split('\n').map(JSON.parse);
  assert.deepEqual(json.map(({ id, kind }) => ({ id, kind })), item.activities.slice(-10).map(({ id, kind }) => ({ id, kind })));
  assert.ok(json.every((activity) => activity.kind === 'join'));
  assert.deepEqual(item.history(['--format', 'id,kind']).trim().split('\n'), json.map(({ id, kind }) => `${id}\t${kind}`));
  assert.equal(continuation(item.history(['--before', item.activities.find((activity) => activity.kind === 'say').id])), undefined);
  assert.deepEqual(fs.readFileSync(item.file), before, 'history remains read-only');
});

test('human pages traverse hidden gaps in both directions without dropping or repeating visible activity', async (t) => {
  const item = await fixture(t, async (square) => {
    const speaker = await square.join('Speaker');
    for (let index = 0; index < 12; index += 1) {
      await speaker.express(`decision ${index}`, { force: true });
      const guest = await square.join(`Guest${index}`);
      await guest.listen('Speaker');
      await guest.ignore('Speaker');
    }
    for (let index = 0; index < 11; index += 1) await square.join(`Late${index}`);
  });
  const visible = item.activities.filter((activity) => activity.kind === 'say');
  const latest = item.history();
  assert.deepEqual(bodyNumbers(latest), Array.from({ length: 10 }, (_, index) => index + 2));
  assert.equal(continuation(latest), `square --location '${item.file}' history --before ${visible[2].id} --limit 10`);

  for (const direction of ['--before', '--after']) {
    let cursor = direction === '--after' ? item.activities[0].id : undefined;
    const seen = [];
    for (let page = 0; page < 4; page += 1) {
      const output = item.history(['--limit', '3', ...(cursor === undefined ? [] : [direction, cursor]), '--order', 'desc']);
      const start = direction === '--after' ? page * 3 : 9 - page * 3;
      assert.deepEqual(bodyNumbers(output), [start + 2, start + 1, start]);
      seen.push(...bodyNumbers(output));
      const next = continuation(output);
      if (page === 3) {
        assert.equal(next, undefined, 'no empty continuation after the last visible event');
      } else {
        const edge = visible[direction === '--after' ? start + 2 : start].id;
        assert.equal(next, `square --location '${item.file}' history --order 'desc' ${direction} ${edge} --limit 3`);
        cursor = edge;
      }
    }
    assert.deepEqual(seen.sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index));
  }
});

test('hold and done count toward rendered pages while resume does not consume a slot', async (t) => {
  const item = await fixture(t, async (square) => {
    const speaker = await square.join('Speaker');
    await speaker.express('before the pause', { force: true });
    await speaker.hold('a short pause');
    await speaker.resume();
    await speaker.done();
    for (let index = 0; index < 4; index += 1) await square.join(`Late${index}`);
  });
  const hold = item.activities.find((activity) => activity.kind === 'hold');
  const latest = item.history(['--limit', '2']);
  assert.match(latest, /raised a hand — a short pause/);
  assert.match(latest, /stepped out of the square — done/);
  assert.doesNotMatch(latest, /before the pause|lowered the hand/);
  assert.equal(continuation(latest), `square --location '${item.file}' history --before ${hold.id} --limit 2`);
  const earlier = item.history(['--before', hold.id, '--limit', '2']);
  assert.match(earlier, /before the pause/);
  assert.equal(continuation(earlier), undefined);
});

test('filtered continuations preserve their query and count only matching visible activity', async (t) => {
  const item = await fixture(t, async (square) => {
    const speaker = await square.join('Speaker');
    await square.join('Listener');
    const other = await square.join('Other');
    for (let index = 0; index < 6; index += 1) {
      await speaker.express(`needle decision ${index}`, { force: true, mentions: ['Listener'] });
      await other.listen('Speaker');
      await other.ignore('Speaker');
      await other.express(`unrelated ${index}`, { force: true });
    }
  });
  const selected = item.activities.filter((activity) => activity.kind === 'say' && activity.actor === 'Speaker');
  const since = new Date(selected[0].at).toISOString();
  const args = ['--from', 'Speaker', '--since', since, '--mention', 'Listener', '--at', selected[3].id, '-C', '100', '--no-truncate', '--order', 'desc'];
  for (const search of [[], ['--grep', 'needle.*decision'], ['--fixed', 'needle decision']]) {
    const filters = [...args, ...search];
    const filterText = `--from 'Speaker' --since '${since}' --mention 'Listener' --at ${selected[3].id} -C 100 --no-truncate --order 'desc'${search.length ? ` ${search[0]} '${search[1]}'` : ''}`;
    const latest = item.history([...filters, '--limit', '2']);
    assert.match(latest, /needle decision 5/);
    assert.match(latest, /needle decision 4/);
    assert.doesNotMatch(latest, /needle decision [0-3]|unrelated/);
    assert.equal(continuation(latest), `square --location '${item.file}' history ${filterText} --before ${selected[4].id} --limit 2`);
    const earlier = item.history([...filters, '--before', selected[4].id, '--limit', '2']);
    assert.match(earlier, /needle decision 3/);
    assert.match(earlier, /needle decision 2/);
    assert.equal(continuation(earlier), `square --location '${item.file}' history ${filterText} --before ${selected[2].id} --limit 2`);
    const last = item.history([...filters, '--before', selected[2].id, '--limit', '2']);
    assert.match(last, /needle decision 1/);
    assert.doesNotMatch(last, /needle decision 0/);
    assert.equal(continuation(last), undefined);
  }
});
