import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Square } from "../dist/index.js";
import { createMemoryCell } from "../dist/square-storage.js";
import { createSquareState } from "../dist/artifact.js";

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
  const cell = createMemoryCell(createSquareState({ force: false, hardCap: null }, "context"));
  const controller = new AbortController();
  const waiting = cell.changed(0, 60_000, controller.signal);
  await cell.transact((state) => ({ state: { ...state, preamble: ["changed"] }, result: undefined }));
  assert.equal(await waiting, true);
  controller.abort(new Error("late cancellation"));
  await cell.close();
});

test("abort during a transition preserves the committed result", async () => {
  const initial = createSquareState({ force: false, hardCap: null }, "context");
  const cell = createMemoryCell(initial);
  const controller = new AbortController();
  const result = await cell.transact((state) => {
    controller.abort(new Error("response discarded"));
    state.preamble = ["committed"];
    return { state, result: "committed-result" };
  }, controller.signal);
  assert.equal(result, "committed-result");
  assert.deepEqual((await cell.read()).state.preamble, ["committed"]);
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
  const { buildMemorySquare } = await import("../dist/square-file-adapter.js");
  const { join, express } = await import("../dist/square-actions.js");
  const open = buildMemorySquare({ markdown: "context" });
  const joined = await join(open, "Writer");
  const controller = new AbortController();
  const artifact = open.artifact;
  const wrapped = { ...open, artifact: { ...artifact, transact: async (fn, signal) => { const result = await artifact.transact(fn, signal); controller.abort(new Error("response discarded")); return result; } } };
  const result = await express(wrapped, joined.name, "committed", { force: true }, { signal: controller.signal });
  assert.equal(result.activity.body, "committed");
  assert.equal((await artifact.read()).state.acts.at(-1).body, "committed");
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
  await releaseSessionParticipantClaim(location, "Owner", ledger, second);
  const rows = await ledger.listPresence({ location, participant: "Owner" });
  assert.equal(rows.length, 1);
  assert.equal(first?.status, "acquired");
  assert.equal(second?.status, "owned");
  await fs.rm(root, { recursive: true, force: true });
});

test("post-commit catch preserves its result before return cancellation", async () => {
  const { buildMemorySquare } = await import("../dist/square-file-adapter.js");
  const { join, express, catchUp } = await import("../dist/square-actions.js");
  const open = buildMemorySquare({ markdown: "context" });
  const alice = await join(open, "Alice");
  const bob = await join(open, "Bob");
  await catchUp(open, bob.name);
  await express(open, alice.name, "boundary catch", { force: true, mentions: ["Bob"] });
  const controller = new AbortController();
  const artifact = open.artifact;
  const wrapped = { ...open, artifact: { ...artifact, transact: async (fn, signal) => { const result = await artifact.transact(fn, signal); controller.abort(new Error("response discarded")); return result; } } };
  const result = await catchUp(wrapped, bob.name, {}, undefined, { signal: controller.signal });
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
