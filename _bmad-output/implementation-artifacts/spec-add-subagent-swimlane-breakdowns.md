---
title: 'Add subagent swimlane breakdowns'
type: 'feature'
created: '2026-08-17'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'd9a685a2e0cb0c52e71ac2819955f8f0f635f6d9'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Subagent lanes are single aggregate activation bars while the parent lane distinguishes model response, assistant output, tools, waits, and unsupported time. This hides where child wall time and tokens are spent and makes the shared timeline semantically inconsistent.

**Approach:** Preserve each logical child row and physical continuation envelope, but partition every activation from its own JSONL messages using the same evidence-backed classifications and visual treatments as the parent.

## Boundaries & Constraints

**Always:** Bound child evidence and segments to one physical activation; keep continuation gaps empty; attribute request metrics once from that activation's assistant messages; retain exact evidence for overlap and sub-pixel disclosure; attribute nested-child wait only to the process that spawned it; keep aggregate `Process.metrics` on the activation; and inherit the activation's existing subagent-card navigation target on its segments.

**Ask First:** Adding new lanes or per-child HITL marks; adding internal child-message microscope destinations; changing child ownership/session bounds; or changing the shared classification vocabulary.

**Never:** Reparse JSONL in the renderer; use `mainSessionImpact` as child usage; classify across continuation files; leak nested-child wait onto the root parent lane; stretch short evidence for visibility; infer human wait from ordinary sidechain input; or break aggregate rendering for stale/legacy projections without segment arrays.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Child request and tool cycle | Timestamped sidechain prompt, request-ID assistant events, matched tool result | Activation contains model-response, assistant-output, tool-execution, and unattributed slices with per-request metrics | Broken links remain unattributed |
| Nested child | Child-owned spawn/result encloses a nested process | Only the owning activation shows nested `child-wait`; the root shows only root-owned waits | Unlinked nested activity is not causally attributed |
| Continuation | Two JSONL activations on one logical row | Each activation has independent evidence/segments; the gap remains empty | Cross-file parent links do not bridge the gap |
| Legacy or malformed IPC | Missing segments, invalid times/types, or out-of-bounds child data | Missing segments use the aggregate bar; current segments are clipped/validated | Invalid segments are discarded safely |
| Sub-pixel child evidence | Exact segment is below one rendered pixel | Evidence appears in suppressed activity and becomes visible when zoom permits | No minimum-width inflation or double count |

</frozen-after-approval>

## Code Map

- `src/main/types/chunks.ts:76-172` -- bump the wire schema; add activation-local evidence and a child segment type matching the parent segment's causal fields.
- `src/main/services/analysis/SwimlaneBuilder.ts:109-325` -- make request/model/tool classifiers lane-relative; namespace IDs; keep parent-only linked-resume inference.
- `src/main/services/analysis/SwimlaneBuilder.ts:507-571,574-748` -- build per-process activation projections and retain nested spawn owner identity so waits go to the correct lane.
- `src/main/services/analysis/SwimlaneBuilder.ts:756-912` -- reuse the deterministic precedence/partitioner for parent and child while preserving exact evidence and one metrics owner.
- `src/renderer/components/chat/SwimlaneSurface.tsx:190-360` -- normalize activation-local evidence/segments and preserve legacy aggregate fallback.
- `src/renderer/components/chat/SwimlaneSurface.tsx:1296-1365,1647-1748` -- disclose suppressed child evidence; draw outlined activation envelopes with classified segment intervals using existing treatments, tooltips, and targets.
- `src/main/services/infrastructure/DataCache.ts:34` -- invalidate cached session details for the expanded payload.
- `test/main/services/analysis/SwimlaneBuilder.test.ts`, `test/main/services/analysis/ChunkBuilder.test.ts` -- cover sidechain classification, ownership, continuations, metrics, and serialization without raw messages.
- `test/renderer/components/chat/SwimlaneSurface.test.tsx`, `test/main/services/infrastructure/DataCache.test.ts` -- cover rendering, normalization, navigation, suppression/zoom, legacy fallback, and cache versioning.

## Tasks & Acceptance

**Execution:**
- [x] `src/main/types/chunks.ts`, `src/main/services/analysis/SwimlaneBuilder.ts` -- project exact activation-local evidence and classified segments without changing logical row ownership.
- [x] `src/renderer/components/chat/SwimlaneSurface.tsx` -- normalize and render child breakdowns with an aggregate fallback and scale-honest suppressed details.
- [x] `src/main/services/infrastructure/DataCache.ts` and focused tests -- invalidate stale payloads and verify every matrix scenario plus serialization/navigation compatibility.

**Acceptance Criteria:**
- Given a session with parent work, child tool cycles, nested children, and continuations, when the swimlane opens, then parent and child rows use the same truthful classification language on one axis while every continuation gap remains empty.
- Given an existing target-bearing subagent activation, when any classified child segment is activated, then navigation reaches the same existing subagent card exactly once.

## Spec Change Log

## Design Notes

Activation-local `evidence` stays nested rather than joining `SwimlaneModel.evidence`, because the latter is parent evidence and its renderer suppression accounting assumes parent ownership. A classified activation uses a non-interactive outline plus sibling segment intervals, avoiding nested buttons; an activation without segment arrays keeps the existing aggregate interval.

## Verification

**Commands:**
- `node_modules/.bin/vitest run test/main/services/analysis/SwimlaneBuilder.test.ts test/main/services/analysis/ChunkBuilder.test.ts test/renderer/components/chat/SwimlaneSurface.test.tsx test/main/services/infrastructure/DataCache.test.ts` -- expected: focused projection, IPC, rendering, and cache tests pass.
- `npm run typecheck && npm run lint && npm test && npm run build && git diff --check` -- expected: static checks, full suite, production build, and patch hygiene pass.

## Suggested Review Order

**Causal projection**

- Start where root and owner-scoped evidence become the complete wire projection.
  [`SwimlaneBuilder.ts:952`](../../src/main/services/analysis/SwimlaneBuilder.ts#L952)

- Each physical activation is independently classified without bridging continuation gaps.
  [`SwimlaneBuilder.ts:541`](../../src/main/services/analysis/SwimlaneBuilder.ts#L541)

- Spawn ownership directs nested waits to the correct parent or child lane.
  [`SwimlaneBuilder.ts:635`](../../src/main/services/analysis/SwimlaneBuilder.ts#L635)

- One partitioner applies deterministic evidence precedence to parent and child segments.
  [`SwimlaneBuilder.ts:831`](../../src/main/services/analysis/SwimlaneBuilder.ts#L831)

**Renderer boundary**

- Runtime normalization clips child evidence, repairs identities, and preserves aggregate fallback.
  [`SwimlaneSurface.tsx:190`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L190)

- Suppressed child activity stays discoverable without inflating sub-pixel intervals.
  [`SwimlaneSurface.tsx:1435`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1435)

- Classified segments reuse parent treatments while retaining the existing subagent destination.
  [`SwimlaneSurface.tsx:1879`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1879)

**Contracts and verification**

- Schema v2 adds activation-local evidence and segments without removing aggregate metrics.
  [`chunks.ts:77`](../../src/main/types/chunks.ts#L77)

- Builder coverage protects request metrics, teammate prompts, child asks, nesting, and continuations.
  [`SwimlaneBuilder.test.ts:1130`](../../test/main/services/analysis/SwimlaneBuilder.test.ts#L1130)

- Renderer coverage protects clipping, navigation, tooltip metrics, fallback, and suppression.
  [`SwimlaneSurface.test.tsx:1432`](../../test/renderer/components/chat/SwimlaneSurface.test.tsx#L1432)

- Cache v4 prevents stale payloads from bypassing the new wire model.
  [`DataCache.ts:37`](../../src/main/services/infrastructure/DataCache.ts#L37)
