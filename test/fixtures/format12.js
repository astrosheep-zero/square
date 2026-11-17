import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Independent historical framing plus explicit persisted facts. No current initializer.
export function seedFormat12(location, now = Date.now()) {
  const db = new DatabaseSync(location);
  try {
    db.exec(fs.readFileSync(new URL('./format12.sql', import.meta.url), 'utf8'));
    db.exec('BEGIN');
    db.prepare('INSERT INTO storage_meta VALUES(1,77,22)').run();
    db.prepare('INSERT INTO square_meta VALUES(1,15,100,200,?,?)').run('["historical preamble"]', '["warmup\\r\\nkept"]');
    const people = ['Alice', 'Bob', 'Gone', 'Away'];
    const enc = JSON.stringify, key = name => enc(name.toLowerCase());
    const activities = [
      ...people.map(actor => ({ kind: 'join', actor })),
      { kind: 'say', actor: 'Alice', body: 'old captured audience\r\nbytes', mentions: ['Bob', 'Gone', 'Away'], metadata: { kind: 'old' } },
      { kind: 'done', actor: 'Bob', body: 'old owner left' },
      { kind: 'join', actor: 'Bob' },
      { kind: 'say', actor: 'Alice', body: 'current posted full', mentions: ['Bob'] },
      { kind: 'say', actor: 'Alice', body: 'previous generation, same owner', mentions: ['Bob'] },
      { kind: 'read', actor: 'Gone', through: 8 },
      { kind: 'say', actor: 'Alice', body: 'already consumed old tuple', mentions: ['Bob'] },
      { kind: 'say', actor: 'Alice', body: 'current recoverable claim', mentions: ['Bob'] },
      { kind: 'say', actor: 'Alice', body: 'old owner, same generation', mentions: ['Bob'] },
      { kind: 'say', actor: 'Alice', body: 'partial addresses', mentions: ['Bob', 'Away'] },
      { kind: 'say', actor: 'Alice', body: 'posted and consumed old work', mentions: ['Gone'] },
    ];
    const act = db.prepare('INSERT INTO activities VALUES(?,?,?,?,?,?,?,?)');
    activities.forEach(({ kind, actor, ...payload }, index) => act.run(index, 1000 + index, kind, enc(actor), key(actor), null, null, enc(payload)));
    const participant = db.prepare('INSERT INTO participants VALUES(?,?,?,?,?,?,?,?)');
    people.forEach((name, index) => participant.run(key(name), enc(name), index, name === 'Gone' ? 0 : 1, name === 'Gone' ? 1 : 0,
      activities.filter(a => a.kind === 'say' && a.actor === name).length, 1014, name === 'Bob' ? 6 : index));
    const seat = db.prepare('INSERT INTO participant_seats VALUES(?,?,?,?,?,?)');
    for (const [name, owner, generation, attachment] of [
      ['Alice', 'owner-a', 'a', 'attached'], ['Bob', 'owner-b', 'b-new', 'attached'],
      ['Away', 'owner-away', 'away', 'detached'], ['Gone', 'owner-gone', 'g-survivor', 'attached'],
    ]) seat.run(key(name), enc(name), enc(owner), enc(generation), null, attachment);
    db.prepare('INSERT INTO attention VALUES(?,?,?,?,?)').run(key('Bob'), key('Alice'), enc('Alice'), 'listen', 6);
    const audience = db.prepare('INSERT INTO landed_audience VALUES(?,?,?,?,?,?)');
    const targets = [
      [4, 'Bob', 'owner-old-b', 'b-old'], [4, 'Gone', 'owner-gone', 'g-old'], [4, 'Away', 'owner-away', 'away'],
      [7, 'Bob', 'owner-b', 'b-new'], [8, 'Bob', 'owner-b', 'b-previous'], [10, 'Bob', 'owner-old-b', 'b-old'],
      [11, 'Bob', 'owner-b', 'b-new'], [12, 'Bob', 'owner-old-b', 'b-new'],
      [13, 'Bob', null, 'partial-generation'], [13, 'Away', 'partial-owner', null], [14, 'Gone', 'owner-gone', 'g-old'],
    ];
    const orders = new Map();
    for (const [index, name, owner, generation] of targets) {
      const order = orders.get(index) ?? 0; orders.set(index, order + 1);
      audience.run(index, key(name), order, 'mention', owner === null ? null : enc(owner), generation === null ? null : enc(generation));
    }
    db.prepare('INSERT INTO caught_activity VALUES(?,?,?)').run(key('Bob'), 10, 2000);
    db.prepare('INSERT INTO caught_activity VALUES(?,?,?)').run(key('Gone'), 14, 2001);
    db.prepare('INSERT INTO catch_leases VALUES(?,?,?)').run(key('Bob'), enc('b-new'), enc({ leaseId: 'lease-kept', heartbeatAt: 1000, expiresAt: 3000, filter: { mention: 'Bob' } }));
    const notice = db.prepare('INSERT INTO square_notices VALUES(?,?,?,?,?)');
    const noticeAudience = db.prepare('INSERT INTO notice_audience VALUES(?,?,?,?,?,?)');
    for (const [index, recipient, owner, generation, consumed] of [
      [0, 'Bob', 'owner-old-b', 'b-old', 2000], [1, 'Bob', 'owner-b', 'b-new', null],
      [2, 'Gone', 'notice-only-owner', 'notice-only-gen', 2000], [3, 'Away', 'owner-away', 'away', null],
      [4, 'Gone', 'owner-gone', 'g-old', 2000],
    ]) {
      notice.run(index, 1500 + index, enc('notifier'), enc(`notice ${index}\r\nbytes`), enc({ outcome: 'done' }));
      noticeAudience.run(index, key(recipient), enc(recipient), enc(owner), enc(generation), consumed);
    }
    db.prepare('INSERT INTO producer_consumption VALUES(?,?,?,?,?,?)').run(key('Bob'), enc('owner-b'), enc('b-new'), key('notifier'), enc({ fields: [{ path: ['outcome'], equals: 'future' }] }), 1700);
    const post = db.prepare('INSERT INTO square_posts VALUES(?,?,?,?,?,?,?,?,?)');
    for (const row of [
      ['activity', 4, key('Bob'), 'old-outstanding', process.pid, 1, 1, 0, 1],
      ['activity', 7, key('Bob'), null, null, now - 200000, now - 200000, 1, 1],
      ['activity', 8, key('Bob'), null, null, 1, 1, 0, 0],
      ['activity', 11, key('Bob'), 'current-outstanding', process.pid, now - 120000, now - 120000, 0, 1],
      ['activity', 14, key('Gone'), null, null, 1, 1, 1, 1],
      ['notice', 2, key('Gone'), 'notice-outstanding', process.pid, now - 1000, now - 1000, 0, null],
    ]) post.run(...row);
    db.exec('COMMIT');
  } finally { db.close(); }
  return location;
}
