import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Square } from "../dist/index.js";
import { createArtifactPort, prepareSquareBuild, readSquareSnapshot } from "../dist/artifact.js";
import { createSquareApplication } from "../dist/square-application.js";

function aborted() {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  return controller;
}

test("pre-aborted lifecycle operations do not mutate the artifact", async () => {
  const square = Square.inMemory({ markdown: "context" });
  const before = await square.snapshot();
  await assert.rejects(() => square.join("Alice", { signal: aborted().signal }), /cancelled/);
  await assert.rejects(() => square.implicitJoin("Bob", { signal: aborted().signal }), /cancelled/);
  assert.equal((await square.snapshot()).actCount, before.actCount);
  await square.close();
});

test("application opens abort under an exclusive lock without deferred mutation", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "square-application-cancel-"));
  const location = path.join(root, "SQUARE.square");
  const env = { ...process.env, SQUARE_HOST_LEDGER_ROOT: path.join(root, "ledger") };
  const square = await Square.build({ path: location, markdown: "context", env });
  const writer = await square.join("Writer");
  await square.join("Reader");
  await writer.express("unread", { force: true, mentions: ["Reader"] });
  await square.close();
  const before = await readSquareSnapshot(location);
  const reader = createSquareApplication({ cwd: root, env, squarePath: location, participant: "Reader" });
  const speaker = createSquareApplication({ cwd: root, env, squarePath: location, participant: "Writer" });
  const newcomer = createSquareApplication({ cwd: root, env, squarePath: location, participant: "Newcomer" });
  const database = new DatabaseSync(location);
  database.exec("BEGIN EXCLUSIVE");
  const controller = new AbortController();
  const pending = [
    reader.catch({}, { signal: controller.signal }),
    speaker.express("cancelled", { force: true, mentions: ["Reader"] }, { signal: controller.signal }),
    newcomer.join({}, { signal: controller.signal }),
  ];
  const abort = setTimeout(() => controller.abort(new Error("cancelled")), 50);
  let deadline;
  try {
    await Promise.race([
      Promise.all(pending.map((operation) => assert.rejects(operation, /cancelled/))),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("cancellation waited for the artifact lock")), 1000); }),
    ]);
  } finally {
    clearTimeout(abort);
    clearTimeout(deadline);
    database.exec("ROLLBACK");
    database.close();
    await Promise.allSettled(pending);
    try { assert.deepEqual(await readSquareSnapshot(location), before); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  }
});

test("cancelled force-build leaves no rebuild behind after the artifact lock is released", async (t) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "square-build-cancel-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const location = path.join(root, "SQUARE.square");
  const env = { ...process.env, SQUARE_HOST_LEDGER_ROOT: path.join(root, "ledger") };
  const application = createSquareApplication({ cwd: root, env, squarePath: location });
  await application.build({ markdown: "original", hardCap: 7 });
  const before = await readSquareSnapshot(location);
  const lock = new DatabaseSync(location);
  lock.exec("BEGIN EXCLUSIVE");
  const controller = new AbortController();
  const pending = application.build({ markdown: "must not replace original", hardCap: 2, force: true }, { signal: controller.signal });
  const abort = setTimeout(() => controller.abort(new Error("force-build cancelled")), 50);
  let deadline;
  try {
    await Promise.race([
      assert.rejects(pending, /force-build cancelled/),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("force-build ignored cancellation while locked")), 1000); }),
    ]);
  } finally {
    clearTimeout(abort);
    clearTimeout(deadline);
    lock.exec("ROLLBACK");
    lock.close();
    await Promise.allSettled([pending]);
  }
  assert.deepEqual(await readSquareSnapshot(location), before);
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});

test("a newly published build keeps its result when cancellation follows the link", async (t) => {
  const fs = (await import("node:fs")).default;
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "square-build-committed-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const location = path.join(root, "SQUARE.square");
  const controller = new AbortController();
  const link = fs.promises.link;
  fs.promises.link = async (...args) => {
    await link(...args);
    controller.abort(new Error("late response cancellation"));
  };
  try {
    const app = createSquareApplication({ cwd: root, env: {}, squarePath: location });
    const result = await app.build({ markdown: "published", hardCap: 3 }, { signal: controller.signal });
    assert.equal(result.data.location, location);
    assert.equal(result.data.hardCap, 3);
  } finally { fs.promises.link = link; }
  assert.equal(controller.signal.aborted, true);
  assert.equal((await readSquareSnapshot(location)).state.hardCap, 3);
});

test("idle catch aborts without consuming activity added later", async () => {
  const square = Square.inMemory({ markdown: "context" });
  const alice = await square.join("Alice");
  const bob = await square.join("Bob");
  await bob.catch();
  const controller = new AbortController();
  const waiting = bob.catch({ idle: 60_000 }, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("cancelled"));
  await assert.rejects(waiting, /cancelled/);
  const activity = await alice.express("after cancellation", { force: true, mentions: ["Bob"] });
  const caught = await bob.catch();
  assert.equal(caught.activities[0].id, activity.activity.id);
  await square.close();
});

test("memory change wait removes abort listeners on normal settlement", async () => {
  const cell = createArtifactPort(':memory:', prepareSquareBuild({ force: false, hardCap: null }, "context"));
  const controller = new AbortController();
  const waiting = cell.changed(0, 60_000, controller.signal);
  await cell.transact((facts) => facts.putLease("Watcher", { leaseId: "lease", heartbeatAt: 1, expiresAt: 60_000 }));
  assert.equal(await waiting, true);
  controller.abort(new Error("late cancellation"));
  await cell.close();
});

test("abort inside a transition before commit rolls back the whole change", async () => {
  const initial = prepareSquareBuild({ force: false, hardCap: null }, "context");
  const cell = createArtifactPort(':memory:', initial);
  const controller = new AbortController();
  await assert.rejects(
    () => cell.transact((facts) => {
      facts.land({ kind: "join", actor: "Alice", at: 1 });
      controller.abort(new Error("response discarded"));
    }, controller.signal),
    /response discarded/,
  );
  const header = (await cell.read((facts) => facts.header())).value;
  assert.equal(header.revision, 0);
  assert.equal(header.lastActIndex, -1);
  assert.equal(header.nextActIndex, 0);
  await cell.close();
});


test("real host-ledger claim lock abort prevents queued ownership", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { FileHostLedgerPort } = await import("../dist/host-ledger-file-adapter.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "square-claim-cancel-"));
  const lock = path.join(root, "presence-claim.lock");
  const port = new FileHostLedgerPort({ rootPath: root });
  const input = { location: path.join(root, "SQUARE.square"), participant: "Queued", session: "session-queued", channel: "codex", updatedAt: Date.now() };
  const controller = new AbortController();
  const database = new DatabaseSync(lock);
  database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS __square_file_lock (id INTEGER PRIMARY KEY CHECK (id = 1));");
  const claim = port.claimPresence(input, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("cancelled"));
  const result = await claim;
  assert.equal(result.status, "degraded");
  database.exec("ROLLBACK");
  database.close();
  assert.deepEqual(await port.listPresence({ location: input.location }), []);
  await fs.rm(root, { recursive: true, force: true });
});

test("post-commit express preserves its result after response cancellation", async () => {
  const { buildMemorySquare } = await import("../dist/open-square.js");
  const { join, express } = await import("../dist/square-actions.js");
  const open = buildMemorySquare({ markdown: "context" });
  const joined = await join(open, "Writer");
  const controller = new AbortController();
  const artifact = open.artifact;
  const wrapped = { ...open, artifact: { ...artifact, transact: async (fn, signal) => { const result = await artifact.transact(fn, signal); controller.abort(new Error("response discarded")); return result; } } };
  const result = await express(wrapped, joined.name, "committed", { force: true }, { signal: controller.signal });
  assert.equal(result.activity.body, "committed");
  const latest = (await artifact.read((facts) => facts.activityHeads({}, { edge: "newest", limit: 1 }))).value.items[0];
  assert.equal((await artifact.read((facts) => facts.activity(latest.index))).value.body, "committed");
  await open.artifact.close();
});


test("post-commit catch preserves its result after response cancellation", async () => {
  const square = Square.inMemory({ markdown: "context" });
  const alice = await square.join("Alice");
  const bob = await square.join("Bob");
  await bob.catch();
  await alice.express("committed catch", { force: true, mentions: ["Bob"] });
  const controller = new AbortController();
  const original = square;
  const catchResult = await bob.catch(undefined, { signal: controller.signal });
  controller.abort(new Error("response discarded"));
  assert.equal(catchResult.activities[0].body, "committed catch");
  assert.deepEqual((await bob.catch()).activities, []);
  await original.close();
});


test("owned claim cleanup never removes rightful ownership", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { claimSessionParticipant, releaseSessionParticipantClaim } = await import("../dist/registry.js");
  const { FileHostLedgerPort } = await import("../dist/host-ledger-file-adapter.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "square-owned-claim-"));
  const env = { ...process.env, CODEX_THREAD_ID: "owned-session", SQUARE_REGISTRY: path.join(root, "registry.ndjsonl"), SQUARE_HOST_LEDGER_ROOT: root };
  const location = path.join(root, "SQUARE.square");
  const ledger = new FileHostLedgerPort({ rootPath: root });
  const first = await claimSessionParticipant(location, "Owner", ledger, env);
  const second = await claimSessionParticipant(location, "Owner", ledger, env);
  await releaseSessionParticipantClaim(ledger, second);
  const rows = await ledger.listPresence({ location, participant: "Owner" });
  assert.equal(rows.length, 1);
  assert.equal(first?.status, "acquired");
  assert.equal(second?.status, "owned");
  await fs.rm(root, { recursive: true, force: true });
});

test("post-commit catch preserves its result before return cancellation", async () => {
  const { buildMemorySquare } = await import("../dist/open-square.js");
  const { join, express, catchUp } = await import("../dist/square-actions.js");
  const open = buildMemorySquare({ markdown: "context" });
  const alice = await join(open, "Alice");
  const bob = await join(open, "Bob");
  await catchUp(open, bob.name);
  await express(open, alice.name, "boundary catch", { force: true, mentions: ["Bob"] });
  const controller = new AbortController();
  const artifact = open.artifact;
  const wrapped = { ...open, artifact: { ...artifact, transact: async (fn, signal) => { const result = await artifact.transact(fn, signal); controller.abort(new Error("response discarded")); return result; } } };
  const result = await catchUp(wrapped, bob.name, {}, { signal: controller.signal });
  assert.equal(result.activities[0].body, "boundary catch");
  assert.deepEqual((await catchUp(open, bob.name)).activities, []);
  await open.artifact.close();
});


test("same-session concurrent joins retain one rightful owner", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "square-concurrent-join-"));
  const env = { ...process.env, CODEX_THREAD_ID: "same-session", SQUARE_REGISTRY: path.join(root, "registry.ndjsonl"), SQUARE_HOST_LEDGER_ROOT: root };
  const square = await Square.build({ path: path.join(root, "SQUARE.square"), markdown: "context", env });
  await Promise.all([square.join("Same"), square.join("Same")]);
  const rows = await square.recognize(env);
  assert.ok(rows);
  assert.equal((await square.history()).filter((activity) => activity.kind === "join").length, 1);
  await square.close();
  await fs.rm(root, { recursive: true, force: true });
});


test("conditional claim removal preserves a refreshed row", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { FileHostLedgerPort } = await import("../dist/host-ledger-file-adapter.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "square-conditional-remove-"));
  const port = new FileHostLedgerPort({ rootPath: root });
  const location = path.join(root, "SQUARE.square");
  const original = { location, participant: "Owner", session: "session", channel: "codex", updatedAt: Date.now(), epoch: 1 };
  const refreshed = { ...original, updatedAt: original.updatedAt + 1, epoch: 2 };
  await port.ensurePresence(original);
  assert.equal(await port.removePresenceIfUnchanged(original), true);
  await port.ensurePresence(refreshed);
  assert.equal(await port.removePresenceIfUnchanged(original), false);
  assert.deepEqual((await port.listPresence({ location, participant: "Owner" }))[0].updatedAt, refreshed.updatedAt);
  assert.equal(await port.removePresenceIfUnchanged(refreshed), true);
  await fs.rm(root, { recursive: true, force: true });
});

test("presence claim holds the file lock across its read so a concurrent ensure write survives", async () => {
  const fsp = await import("node:fs/promises");
  const fsSync = (await import("node:fs")).default;
  const os = await import("node:os");
  const path = await import("node:path");
  const { FileHostLedgerPort } = await import("../dist/host-ledger-file-adapter.js");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "square-claim-lost-update-"));
  const port = new FileHostLedgerPort({ rootPath: root });
  const location = path.join(root, "SQUARE.square");
  const now = Date.now();
  // The presence file must already exist so the claim reads a real snapshot rather than ENOENT.
  await port.ensurePresence({ location: path.join(root, "OTHER.square"), participant: "Seed", session: "seed-session", channel: "codex", updatedAt: now });

  const realReadFile = fsSync.promises.readFile;
  let pauseResolve;
  const paused = new Promise((resolve) => { pauseResolve = resolve; });
  let capturedResolve;
  const captured = new Promise((resolve) => { capturedResolve = resolve; });
  let intercepted = false;
  fsSync.promises.readFile = async (...args) => {
    const result = await realReadFile(...args);
    if (!intercepted && path.basename(String(args[0])) === "presence.ndjsonl") {
      intercepted = true;
      capturedResolve();
      await paused;
    }
    return result;
  };
  try {
    const claim = port.claimPresence({ location, participant: "Claimant", session: "claim-session", channel: "codex", updatedAt: now });
    const reachedSnapshot = await Promise.race([
      captured.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    assert.equal(reachedSnapshot, true, "claimPresence must read the presence snapshot");
    const concurrent = port.ensurePresence({ location, participant: "Concurrent", session: "other-session", channel: "codex", updatedAt: now });
    const settledWhileClaimReads = await Promise.race([
      concurrent.then(() => true, () => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    assert.equal(settledWhileClaimReads, false, "claimPresence must hold the presence file lock across its read");
    pauseResolve();
    assert.equal((await claim).status, "acquired");
    await concurrent;
  } finally {
    fsSync.promises.readFile = realReadFile;
    pauseResolve();
  }
  const rows = await port.listPresence({ location });
  assert.deepEqual(rows.map((row) => row.participant).sort(), ["Claimant", "Concurrent"]);
  await fsp.rm(root, { recursive: true, force: true });
});
