---
name: developing-sqaure
description: Develop, refactor, review, test, and ship changes in the sqaure repository. Use for Square domain modeling, artifact/parser work, delivery hooks, catch/history behavior, wake routes and attempts, Paseo integration, CLI behavior, architecture cleanup, test maintenance, and release verification.
---

# Developing Sqaure

Treat `AGENTS.md` as project authority. Read it before changing behavior, then inspect the current code and git state instead of reconstructing the system from memory.

## Make Architecture Decisions

- Minimize concepts, owners, and persisted facts. Consolidate or delete before adding another mechanism.
- Keep one internal square model. Isolate Markdown parsing and rendering from behavior, and preserve their bidirectional contract.
- Put behavior in the module that owns the underlying fact. Do not let presentation labels drive behavior.
- Persist only authoritative, monotonic evidence. Derive temporary conditions and diagnostic classifications at query time.
- Do not add compatibility reads, duplicate ledgers, speculative fields, daemons, or configuration unless a current invariant requires them.
- When replacing a model, remove the old code, vocabulary, and tests in the same change.

## Preserve Delivery Boundaries

- Treat native hooks as available for every session. Paseo is one wake path, not a separate session capability model.
- Keep Paseo timeline waiting inside `PaseoAdapter` until Paseo owns boundary queuing itself.
- Send wake awareness only. Never include activity bodies in wake prompts.
- Let boundary adapters alone write presented evidence. Let `catch` alone write delivered receipts.
- Record wake attempts only for real adapter calls. Never persist synthetic outcomes for missing routes or derived exhaustion.
- Keep leases limited to mutual exclusion and interrupted-dispatch recovery. Never consume lease content in delivery classification.
- Derive worker eligibility, doctor output, and future sweep behavior from the same primary-evidence predicates.

## Work In Focused Slices

1. Identify the authoritative facts, their owner modules, and the invariant being changed.
2. Trace the existing data and control flow end to end before editing.
3. Choose the smallest model that closes the behavior without parallel paths.
4. Patch the owner modules and delete superseded code immediately.
5. Add or retain only tests that directly prove the resulting invariants.
6. Run focused tests while iterating, then the full suite.
7. Inspect the final diff for leaked concepts, stale vocabulary, compatibility ballast, and unrelated churn.
8. Verify the staged snapshot before committing so unstaged local files cannot make the commit appear healthy.

## Test Real Invariants

Treat tests as evidence about the product model, not as a scenario archive.

- Name the invariant before writing or retaining a test. If the invariant cannot be stated independently of the implementation sequence, the test is probably too low quality.
- Prefer one focused test class per invariant over Cartesian scenario matrices.
- Test authoritative boundaries: exclusive writers, parser/render roundtrips, monotonic stop evidence, retry eligibility, awareness-only payloads, pure derivation, and ownership scope.
- Exercise time boundaries with an injected clock or explicit timestamps. Do not add sleeps or production configuration solely to make tests advance.
- Keep crash-recovery tests only when they prove a durable safety property that ordinary success tests cannot prove.
- Delete tests for removed mechanisms, heuristics, compatibility formats, duplicated state, or incidental call sequences. Do not leave tombstone tests.
- When an existing test fails after a model change, classify it first:
  - A live invariant failed: fix the implementation.
  - The invariant changed intentionally: rewrite the smallest test around the new invariant.
  - The tested mechanism no longer exists: delete the test.
- Never make stale tests pass by adding default fields, dual reads, compatibility branches, or weakened assertions unless backward compatibility is itself an explicit product invariant.
- Do not mechanically update expected objects because a schema gained a field. Decide whether the test should observe that field at all.
- Run `npm test` before delivery. Report failures honestly; do not hide them by narrowing the command.

## Consult Architecture Authority

Use Square history to recover existing rulings before asking a new question. Consult Faye only when verified code evidence leaves a cross-cutting invariant unresolved and the answer could redirect multiple modules. Send one self-contained question through the `communicating-with-faye` and `square` skills, then implement the ruling without adding a status conversation.

## Commit Verification

Stage only the intended slice. Create a temporary commit or equivalent staged snapshot, check it out in a temporary worktree, run `npm test` from that worktree, then remove the temporary worktree. Commit the accepted slice with a message that names the behavior, not the implementation activity.
