---
title: 'Project the lane model'
type: 'feature'
created: '2026-08-16'
status: 'done'
baseline_revision: 'c857cb94c73a06016d1b2e2d06492e4d53cbba42'
baseline_commit: 'c857cb94c73a06016d1b2e2d06492e4d53cbba42'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings:
  - oversized
deferred:
  - summary: >-
      Missing raw JSONL timestamps are normalized to the current wall clock before analysis.
    evidence: |-
      parseChatHistoryEntry substitutes new Date() when entry.timestamp is absent, so downstream pure analysis cannot distinguish a missing source timestamp from genuine current-time activity.
    location: >-
      src/main/utils/jsonl.ts:173
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Session detail has parsed parent and child activity but no serializable wall-clock model that distinguishes production from silence, represents nested/continued children, infers HITL waits, or exposes per-bar token economy before raw messages are removed for IPC.

**Approach:** Add a pure `buildSwimlane(chunks, processes, messages)` projection in main analysis, attach its `SwimlaneModel` to `SessionDetail` before message stripping, and prove interval partitioning, ownership, continuation, HITL, and metric attribution with deterministic fixtures.

## Boundaries & Constraints

**Always:** Partition the complete parent/child time axis without extending assistant instants to the next event. Derive parent work from producing assistant request groups using existing metric deduplication. Pair `AskUserQuestion` results by tool-use id; infer resume only from later real user messages after prior work. Classify remaining silence with `HITL-wait` before `child-wait` before `idle`. Determine nesting from spawn calls/results in each possible owner's messages, preferring identity joins and using timing only as fallback. Collapse `parentUuid` continuations into one row with one activation bar per physical process. Copy child tokens from each activation's `Process.metrics`, never `mainSessionImpact`.

**Block If:** Block only if a required serializable lane target cannot be represented without changing the parser or existing chunk/process identity contracts.

**Never:** Do not call `fillTimelineGaps`, consume gap-filled semantic-step times, add filesystem discovery or a parser, trust resolver-populated `parentTaskId` as proof of nested ownership, gate rows on `hasSubagents`, implement against stripped renderer messages, add UI, or stretch continuation gaps into child work.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Child-only wait | Parent work surrounds a linked child activation | Silent overlap is `child-wait`; work remains only at production | Unmatched leftover silence is `idle` |
| Explicit HITL | Ask tool-use and matching result id, without children | Paired marks bound a `HITL-wait` segment | Unanswered ask remains open to axis end |
| Idle | Separated parent request groups, no open ask or active child | Gap is `idle`, never work | Invalid/empty timestamps do not introduce current-time data |
| HITL plus children | Open ask overlaps child activation | Overlap remains `HITL-wait` by precedence | Child activity resumes classification after HITL closes |
| Nested continuation | Root spawns child, child messages spawn grandchild, and child has a `parentUuid` continuation | Grandchild nests under child; child is one row with one bar per activation and empty gaps | Misleading root `parentTaskId` does not override the process-message join |
| Token provenance | Repeated parent request ids and child `metrics` differ from `mainSessionImpact` | Parent uses existing dedup; every child bar copies all four own-token fields | `mainSessionImpact` is ignored |

</intent-contract>

## Code Map

- `src/main/types/chunks.ts:12-57,386-410` -- `Process` owns physical activation bounds/messages/metrics; add serializable swimlane types and the required `SessionDetail.swimlane` projection here.
- `src/main/services/analysis/SwimlaneBuilder.ts` -- new pure projection; output plain dates, ids, arrays, metrics, parent segments, HITL marks, and flat ordered child rows with `parentRowId`/depth.
- `src/main/services/analysis/ChunkBuilder.ts:178-195` -- build the model after chunks exist and while parent and process messages are intact, then include it in the returned detail.
- `src/main/services/analysis/index.ts` -- export the new builder through the existing analysis barrel.
- `src/main/utils/jsonl.ts:224-340` -- reuse `calculateMetrics` request-id deduplication and existing spawn-call extraction; do not duplicate token or spawn-name rules.
- `src/main/types/messages.ts:93-143` -- normalized tool call/result ids and `isParsedRealUserMessage` define Ask pairing and resume inputs.
- `src/main/services/discovery/SubagentResolver.ts:219-307,354-403` -- reuse result/agent/team identity and continuation-edge conventions; its root-session enrichment is evidence, not nested ownership.
- `src/main/services/analysis/ProcessLinker.ts:22-60` -- reuse root chunk microscope association and id-before-timing precedence; never use it to infer nesting.
- `src/main/ipc/sessions.ts:247-292` -- read-only boundary evidence: projection must already exist before top-level and process messages are cleared.
- `test/main/services/analysis/SwimlaneBuilder.test.ts` -- deterministic pure fixtures for partition classes, marks, nesting, continuations, axis bounds, and token provenance.
- `test/main/services/analysis/ChunkBuilder.test.ts` -- integration proof that session detail carries a JSON-serializable model even when session metadata says no subagents.

## Tasks & Acceptance

**Execution:**
- [x] `src/main/types/chunks.ts`, `src/main/services/analysis/SwimlaneBuilder.ts`, `src/main/services/analysis/index.ts` -- define and implement the pure serializable model, request-group work, HITL/resume inference, precedence sweep, nested spawn ownership, and continuation rows.
- [x] `src/main/services/analysis/ChunkBuilder.ts` -- attach the projection to `SessionDetail` before any consumer strips raw messages.
- [x] `test/main/services/analysis/SwimlaneBuilder.test.ts`, `test/main/services/analysis/ChunkBuilder.test.ts` -- exercise every matrix row, two nesting levels, one-row/multi-activation continuation, misleading `parentTaskId`, no-child behavior, request deduplication, own child metrics, and serialization.

**Acceptance Criteria:**
- Given parent messages and resolved processes, when session detail is built, then `swimlane` serializes without raw messages and spans the earliest through latest valid parent/child timestamp.
- Given production points separated by silence, when the model partitions the axis, then work is never gap-filled and each silent span is exactly one of HITL-wait, child-wait, or idle using the required precedence.
- Given root, nested, parallel, and continued child processes, when rows are projected, then spawn identity determines hierarchy, every logical child has one row, and every physical activation has its own bar and own `Process.metrics`.
- Given `session.hasSubagents` is false while resolved processes exist, when session detail is built, then all resolved child rows remain present.

## Spec Change Log

- 2026-08-16: Implemented the serializable lane projection, pre-strip SessionDetail attachment, and deterministic model/integration coverage.

## Review Triage Log

### 2026-08-16 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 12: (high 0, medium 2, low 10)
- defer: 1: (high 0, medium 1, low 0)
- reject: 5: (high 0, medium 0, low 5)
- addressed_findings:
  - `[medium]` `[patch]` Constrained deduplicated timing fallback to plausible owner activations and one logical child per spawn, preserving identity-first nesting without resolver `parentTaskId` ownership.
  - `[medium]` `[patch]` Correlated Ask and spawn results through every normalized/toolUseResult id shape instead of assuming `sourceToolUseID` or the first result.
  - `[low]` `[patch]` Deduplicated streamed Ask and spawn calls by tool-use id.
  - `[low]` `[patch]` Required stable message-order pairing when Ask and result timestamps are equal.
  - `[low]` `[patch]` Selected inferred-resume starts by greatest preceding work end.
  - `[low]` `[patch]` Subtracted collectively covering explicit Ask intervals from inferred resume gaps.
  - `[low]` `[patch]` Made process/axis bounds iterative, partial-endpoint safe, and message-aware without unbounded spread calls.
  - `[low]` `[patch]` Made continuation endpoints chronological, retained chain-root row identity, and kept activation bars ordered.
  - `[low]` `[patch]` Selected child-row labels from the first activation carrying resolved metadata.
  - `[low]` `[patch]` Added an assertion that continuation gaps remain idle rather than child-wait.
  - `[low]` `[patch]` Added nested team `agent_id` identity coverage with competing timing.
  - `[low]` `[patch]` Gave overlapping work slices unique ids and exactly one metrics-bearing representation per request group.

## Design Notes

Use a flat ordered child-row collection so the IPC contract cannot become cyclic. Each row carries a stable logical id, parent row id, depth, and activation list; each activation retains its physical process id for later click-through. Parent work groups share a `requestId` when present and otherwise stand alone; their interval is the group's earliest through latest producing assistant timestamp, with a zero-duration interval allowed. Resume wait starts at the latest preceding parent work end and ends at the later real-user timestamp unless an explicit Ask pair already covers that gap. Empty input returns a deterministic zero-length axis rather than wall-clock time.

## Verification

**Commands:**
- `pnpm vitest run test/main/services/analysis/SwimlaneBuilder.test.ts test/main/services/analysis/ChunkBuilder.test.ts` -- expected: focused projection and attachment fixtures pass.
- `pnpm typecheck` -- expected: all main, shared, IPC, and renderer consumers accept the required `SessionDetail.swimlane` field.
- `pnpm lint` -- expected: no lint or Electron-boundary errors.
- `pnpm test` -- expected: full Vitest suite passes without regressions.

## Auto Run Result

Status: done

Summary: Added the pure, serializable `buildSwimlane` main-process projection and attached it to `SessionDetail` while raw parent/process messages are still available. The model partitions parent production and silence, pairs explicit/inferred HITL waits, preserves wait precedence, builds nested and continued child rows from process-message evidence, and attributes each activation's own metrics.

Files changed:
- `src/main/types/chunks.ts` -- defines swimlane segments, marks, child rows/activations, the top-level model, and `SessionDetail.swimlane`.
- `src/main/services/analysis/SwimlaneBuilder.ts` -- implements the pure axis, interval, HITL, nesting, continuation, and metric projection.
- `src/main/services/analysis/ChunkBuilder.ts` -- builds the projection before IPC consumers strip raw messages.
- `src/main/services/analysis/index.ts` -- exports the new analysis builder.
- `test/main/services/analysis/SwimlaneBuilder.test.ts` -- covers required interval fixtures and review-hardened identity/timing edge cases.
- `test/main/services/analysis/ChunkBuilder.test.ts` -- proves session-detail attachment, serialization, and resolved-child behavior independent of `hasSubagents`.
- `_bmad-output/specs/spec-session-swimlane/stories/2-project-the-lane-model.md` -- records the implementation contract, review triage, verification, and terminal result.

Review findings breakdown: 12 patches applied (high 0, medium 2, low 10), 1 pre-existing medium-severity parser issue deferred, and 5 findings rejected after deduplication as noise, implausible states, or already-covered claims.

Follow-up review recommendation: true. Patched findings: high 0, medium 2, low 10; score `3 × 2 + 1 × 10 = 16`.

Verification performed:
- Focused Vitest projection/attachment suite: 2 files passed, 35 tests passed.
- Matrix audit: all six rows ran and passed, including child-only wait, explicit/unanswered HITL, idle, overlapping HITL plus children, nested continuations, and token provenance.
- TypeScript typecheck: passed.
- ESLint: passed with 0 errors and 5 pre-existing warnings outside the reviewed diff.
- Full Vitest suite: 58 files passed, 750 tests passed.
- `git diff --check`: passed.
- `pnpm`/`corepack` were unavailable, so the equivalent repository npm scripts and local binaries were used.

Residual risks: Missing raw JSONL timestamps are normalized to current wall time before the pure builder sees them; this pre-existing parser behavior is recorded in `deferred`. No story-local work remains.
