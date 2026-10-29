import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { Square } from '../dist/square-api.js';
import { createArtifactPort } from '../dist/artifact.js';
import { deliverPending } from '../dist/delivery-operations.js';
import { wakePreview } from '../dist/delivery.js';
import { HttpWakeTransport } from '../dist/http-delivery.js';

// Local receivers must not travel through a developer's environment proxy.
process.env.NO_PROXY = '127.0.0.1,localhost';

async function server(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/wake?secret=query-secret`;
}

async function fixture(t, url = 'https://example.com/wake', options = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'square-http-')));
  const location = path.join(dir, 'test.square');
  const input = { path: location, env: { ...process.env, SQUARE_INDEX: path.join(dir, 'index'),
    SQUARE_DISABLE_PASEO_WAKE: '1', BOB_WAKE_TOKEN: 'sender-token' } };
  const square = await Square.build({ ...input, markdown: '', wakeTransport: false });
  const alice = (await square.join('Alice', { owner: 'example:alice' })).participant;
  const wakeAddress = { kind: 'http', address: { url, tokenEnv: 'BOB_WAKE_TOKEN' } };
  const bob = (await square.join('Bob', { owner: 'example:bob', wakeAddress })).participant;
  const activity = (await alice.express({ body: 'ready', metadata: { job: 7 }, mentions: ['Bob'], force: true })).activity;
  const artifact = createArtifactPort(location);
  t.after(async () => { await artifact.close(); await square.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const seat = (await artifact.read(facts => facts.seat('Bob'))).value;
  const request = { location, participant: 'Bob', activity: activity.id, actor: 'Alice', seat, artifact,
    claimToken: 'private-claim', attemptN: 0, route: { ...wakeAddress, location, participant: 'Bob', updatedAt: Date.now() } };
  const transport = new HttpWakeTransport({ env: input.env, ...options });
  return { input, square, alice, bob, seat, artifact, request, transport, wakeAddress };
}

test('HTTP probe validates locally; invalid configuration, missing preview and refused final gate never send', async t => {
  let sends = 0, checks = 0;
  const f = await fixture(t, undefined, { fetch: async () => { sends++; assert.fail('no HTTP I/O'); } });
  const attempt = request => f.transport.attempt(request, 1000, async () => { checks++; return true; });
  for (const address of [
    {}, { url: 'broken' }, { url: 'file:///tmp/wake' }, { url: 'ftp://example.com/wake' },
    { url: 'http://' }, { url: 'https://user:secret@example.com/wake' },
    { url: 'https://example.com/wake#secret' }, { url: 'https://example.com/wake#' },
    { url: 'https://example.com', tokenEnv: '' }, { url: 'https://example.com', tokenEnv: 'MISSING' },
  ]) {
    const route = { ...f.request.route, address };
    assert.equal((await f.transport.probe(route)).outcome, 'not-capable');
    assert.deepEqual(await attempt({ ...f.request, route }), {
      outcome: 'failed', signature: 'http_config_rejected', message: 'Invalid HTTP wake configuration.',
    });
  }
  for (const token of ['', '   ', 'a\r\nInjected: secret', 'valid\n', 'a b', '☃']) {
    const transport = new HttpWakeTransport({ env: { BOB_WAKE_TOKEN: token }, fetch: async () => { sends++; } });
    assert.equal((await transport.probe(f.request.route)).outcome, 'not-capable');
    assert.equal((await transport.attempt(f.request, 1000, async () => true)).signature, 'http_config_rejected');
  }
  assert.equal(await f.transport.probe(f.request.route), true, 'HTTPS uses the same local validation');
  assert.equal((await attempt({ ...f.request, route: { ...f.request.route, kind: 'paseo' } })).outcome, 'not-capable');
  assert.equal((await attempt({ ...f.request, artifact: undefined })).outcome, 'not-capable');
  assert.equal((await f.transport.attempt(f.request, 1000, async () => false)).outcome, 'not-capable');
  await f.bob.catch({ id: f.request.activity });
  assert.equal((await attempt(f.request)).outcome, 'not-capable');
  assert.equal(sends, 0);
  assert.equal(checks, 0);
});

test('HTTPS uses a POST allowlist payload and cancels acknowledgement bodies without awaiting them', async t => {
  let cancelled = false, signal;
  const f = await fixture(t, 'https://example.com/wake?private=secret');
  const request = { ...f.request, attemptN: undefined };
  f.transport = new HttpWakeTransport({ env: f.input.env, fetch: async (url, init) => {
    assert.equal(url, f.request.route.address.url);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.get('authorization'), 'Bearer sender-token');
    assert.equal(init.headers.get('content-type'), 'application/json');
    assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(), ['activity', 'actor', 'location', 'participant', 'preview']);
    signal = init.signal;
    return new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }), { status: 200 });
  } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal((await f.transport.attempt(request, 1000, async () => true)).outcome, 'accepted');
  t.mock.timers.tick(1000);
  assert.equal(signal.aborted, false, 'success clears the live request deadline');
  assert.equal(cancelled, true);
});

test('public default open roundtrips the HTTP seat and records wake acceptance, not presentation or catch', async t => {
  const requests = [];
  const url = await server(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(202).end();
  });
  const f = await fixture(t, url);
  const opened = await Square.at(f.input);
  t.after(() => opened.close());
  assert.deepEqual((await f.artifact.read(facts => facts.seat('Bob'))).value.wakeAddress, f.wakeAddress);
  const alice = await opened.participant('Alice', { owner: 'example:alice' });
  const { activity } = await alice.express('hello @Bob', { force: true });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/wake?secret=query-secret');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers.authorization, 'Bearer sender-token');
  const expected = { ...f.request, activity: activity.id };
  const preview = (await f.artifact.read(facts => wakePreview(facts, expected))).value;
  assert.deepEqual(request.body, { location: f.input.path, participant: 'Bob', activity: activity.id, actor: 'Alice', attemptN: 0, preview });
  const state = (await f.artifact.read(facts => ({
    evidence: facts.deliveryEvidence('Bob', f.seat.generation, activity.id),
    receipt: facts.receipt('Bob', Number(activity.id.slice(4))),
  }))).value;
  assert.deepEqual(state.evidence.map(row => [row.kind, row.outcome]), [['wake', 'accepted']]);
  assert.equal(state.receipt, undefined);
  await deliverPending({ artifact: f.artifact, location: f.input.path, activity: activity.id, transport: f.transport });
  assert.equal(requests.length, 1, 'accepted wakes are not replayed');
});

test('HTTP statuses are known outcomes and redirects never forward bearer credentials', async t => {
  let destinationCalls = 0, calls = 0, status = 200;
  const destination = await server(t, (_req, res) => { destinationCalls++; res.end(); });
  const url = await server(t, async (req, res) => {
    assert.equal(req.headers.authorization, status === 302 ? 'Bearer sender-token' : undefined);
    for await (const _chunk of req) { /* drain the request */ }
    calls++;
    res.writeHead(status, { Location: destination }).end();
  });
  const f = await fixture(t, url);
  const request = { ...f.request, route: { ...f.request.route, address: { url } } };
  for (const [code, outcome, signature] of [[200, 'accepted', 'http_accepted'], [302, 'failed', 'http_status_rejected'],
    [401, 'failed', 'http_status_rejected'], [503, 'failed', 'http_status_transient']]) {
    status = code;
    const result = await f.transport.attempt(code === 302 ? f.request : request, 2000, async () => true);
    assert.equal(result.outcome, outcome);
    assert.equal(result.signature, signature);
    if (outcome === 'failed') assert.equal(result.message, `HTTP wake returned status ${code}.`);
  }
  assert.equal(calls, 4);
  assert.equal(destinationCalls, 0);
});

test('HTTPS retains certificate validation and network diagnostics cannot echo secrets', async t => {
  const f = await fixture(t);
  const dir = path.dirname(f.input.path);
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', cert, '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
  let calls = 0;
  const receiver = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_req, res) => {
    calls++; res.end();
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  t.after(() => new Promise(resolve => { receiver.close(resolve); receiver.closeAllConnections(); }));
  const request = { ...f.request, route: { ...f.request.route, address: { url: `https://127.0.0.1:${receiver.address().port}/wake` } } };
  const result = await f.transport.attempt(request, 2000, async () => true);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.signature, 'http_send_unknown');
  assert.equal(calls, 0, 'an untrusted certificate cannot reach the HTTP handler');
  const unsafe = new HttpWakeTransport({ env: f.input.env, fetch: async () => {
    throw new Error('https://user:password@example.com/?secret=query-secret Bearer sender-token');
  } });
  assert.deepEqual(await unsafe.attempt(f.request, 1000, async () => true), {
    outcome: 'unknown', signature: 'http_send_unknown', message: 'HTTP wake acceptance is unknown after a network error.',
  });
});

test('a lost acknowledgement records unknown and the dispatcher never automatically replays it', async t => {
  let calls = 0;
  const url = await server(t, async (req, res) => {
    for await (const _chunk of req) { /* receiver may already have accepted custody */ }
    calls++;
    res.destroy();
  });
  const f = await fixture(t, url);
  const input = { artifact: f.artifact, location: f.input.path, transport: f.transport, activity: f.request.activity };
  await deliverPending(input);
  await deliverPending(input);
  assert.equal(calls, 1);
  const evidence = (await f.artifact.read(facts => facts.deliveryEvidence('Bob', f.seat.generation))).value;
  assert.deepEqual(evidence.map(row => [row.outcome, row.signature]), [['unknown', 'http_send_unknown']]);
  assert.equal(evidence[0].message, 'HTTP wake acceptance is unknown after a network error.');
});

test('preview and final check consume one budget; an expired local budget never starts fetch', async t => {
  let calls = 0, now = Date.now();
  const f = await fixture(t, undefined, { fetch: async () => { calls++; assert.fail('expired budget sent'); } });
  t.mock.method(Date, 'now', () => now);
  const artifact = { read: async (...args) => { const result = await f.artifact.read(...args); now += 40; return result; } };
  const result = await f.transport.attempt({ ...f.request, artifact }, 100, async () => { now += 60; return true; });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.signature, 'http_pre_send_timeout');
  assert.equal(calls, 0);
});

test('a stalled final check is bounded and cannot send when it eventually resumes', async t => {
  let enter, release, calls = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, undefined, { fetch: async () => { calls++; assert.fail('late final check sent'); } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.transport.attempt(f.request, 1000, async () => { enter(); return gate; });
  await entered;
  t.mock.timers.tick(1000);
  assert.equal((await pending).signature, 'http_pre_send_timeout');
  release(true);
  await Promise.resolve();
  assert.equal(calls, 0);
});

test('dispatcher timeout stays unknown without HTTP I/O, late gate send or automatic replay', { timeout: 5000 }, async t => {
  let enter, release, finalCheck, attempts = 0, calls = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, undefined, { fetch: async () => { calls++; assert.fail('expired dispatch sent HTTP'); } });
  const transport = { attempt(request, budget, beforeSend) {
    attempts++;
    return f.transport.attempt(request, budget, () => finalCheck = (async () => {
      enter();
      await gate;
      return beforeSend();
    })());
  } };
  const input = { artifact: f.artifact, location: f.input.path, activity: f.request.activity, transport, timeoutMs: 1000 };
  const evidence = async () => (await f.artifact.read(facts => facts.deliveryEvidence('Bob', f.seat.generation))).value;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const pending = deliverPending(input);
  await entered;
  assert.equal(calls, 0);
  t.mock.timers.tick(1001);
  await pending;
  const timedOut = await evidence();
  assert.deepEqual(timedOut.map(row => [row.outcome, row.diagnostic]), [['unknown', 'transport timeout']]);
  assert.equal(calls, 0, 'the outer fallback can be unknown before any HTTP I/O');
  release();
  assert.equal(await finalCheck, true, 'the final gate eventually allows the still-pending activity');
  await new Promise(setImmediate); // drain the adapter continuation after the late gate
  assert.equal(calls, 0, 'the expired adapter must not send when the gate resumes');
  assert.deepEqual(await evidence(), timedOut, 'late local completion cannot rewrite the conservative fallback');
  await deliverPending(input);
  assert.equal(attempts, 1, 'unknown evidence prevents automatic replay');
  assert.equal(calls, 0);
});

test('the absolute deadline aborts a live request waiting for headers, leaving no receiver connection', { timeout: 5000 }, async t => {
  let received, closed;
  const arrived = new Promise(resolve => { received = resolve; });
  const disconnected = new Promise(resolve => { closed = resolve; });
  const url = await server(t, (req, res) => {
    req.resume();
    res.on('close', closed);
    received(); // intentionally never send headers
  });
  const f = await fixture(t, url);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.transport.attempt(f.request, 1000, async () => true);
  await arrived;
  t.mock.timers.tick(1000);
  const result = await pending;
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.signature, 'http_send_timeout');
  t.mock.timers.reset();
  await disconnected;
});

test('HTTP final gates share deferral, cancellation and attachment fences without sending', async t => {
  let calls = 0;
  const url = await server(t, (_req, res) => { calls++; res.end(); });
  const f = await fixture(t, url);
  const input = { artifact: f.artifact, location: f.input.path };
  let lease, attempts = 0;
  for (const change of [
    async () => { lease = await f.bob.deferDelivery({ match: { fields: [{ path: ['job'], equals: 7 }] }, durationMs: 10000 }); },
    async () => { await f.square.cancelDeliveries('Bob', { owner: f.seat.owner, generation: f.seat.generation }); },
    async () => { await f.square.detach('Bob', { owner: f.seat.owner, generation: f.seat.generation }); },
  ]) {
    const { activity } = await f.alice.express({ body: 'ready', metadata: { job: 7 }, mentions: ['Bob'], force: true });
    await deliverPending({ ...input, activity: activity.id, transport: {
      probe: route => f.transport.probe(route),
      attempt: (request, budget, beforeSend) => {
        attempts++;
        return f.transport.attempt(request, budget, async () => { await change(); return beforeSend(); });
      },
    } });
    if (lease) { await f.bob.releaseDeliveryDeferral(lease.id); lease = undefined; }
  }
  assert.equal(attempts, 3);
  assert.equal(calls, 0);
  const evidence = (await f.artifact.read(facts => facts.deliveryEvidence('Bob', f.seat.generation))).value;
  assert.deepEqual(evidence.slice(0, 2).map(row => row.outcome), ['released', 'released']);
  assert.equal(evidence.some(row => row.outcome === 'accepted'), false);
});
