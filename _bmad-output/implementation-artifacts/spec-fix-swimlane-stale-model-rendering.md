---
title: 'Fix stale swimlane model rendering'
type: 'bugfix'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
baseline_commit: '9d4fe1c03974d9c35afd649924ac935fc16cf7ea'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** An already-open or mixed-version session can send the new swimlane renderer an unversioned legacy model. Legacy or missing segment categories fall through its exhaustive TypeScript switches at runtime, producing “Parent undefined,” while separately trusted duration fields can disagree with clipped bar geometry.

**Approach:** Version the swimlane wire model and normalize it at the renderer boundary. Preserve only classifications justified by the payload generation: migrate legacy request work to assistant output, downgrade unsupported legacy waits and unknown values to unattributed, and derive visible durations from the same axis-clipped timestamps used for widths.

## Boundaries & Constraints

**Always:** Accept current models unchanged when valid; tolerate stale, partial, and unknown runtime payloads without crashing or showing “undefined”; distinguish an unversioned legacy projection from a current `child-wait`; keep legacy `work` metrics and navigation; compute every painted parent duration from its normalized timestamp intersection with the axis; retain exact current evidence metadata for suppressed details; keep midpoint and endpoint axis labels independently testable.

**Ask First:** Rebuilding the evidence projection in the renderer; introducing persistent migrations beyond the existing cache version; changing the shared-axis layout or navigation destinations.

**Never:** Present legacy inferred child/HITL/idle ranges as evidence-backed child or human wait; stretch or synthesize timestamps from a stale `durationMs`; map unknown future categories to a confident activity type; require an application restart merely to avoid broken labels.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Current model | Current schema version, valid evidence categories and timestamps | Existing evidence-based labels, styles, metrics, targets, and exact scale remain unchanged | Invalid individual intervals normalize safely without poisoning valid siblings |
| Legacy model | No schema version/evidence; `work`, `HITL-wait`, `child-wait`, or `idle` segments | `work` becomes assistant output; all unsupported wait/remainder ranges become unattributed | Missing arrays default empty; UI never emits `undefined` |
| Future/partial model | Missing or unknown segment type and optional collections | Unknown parent activity appears as unattributed with fallback treatment | Invalid evidence entries are omitted from evidence-only affordances |
| Stale duration | Segment timestamps cover 2 seconds but `durationMs` claims 60 seconds | Width, inline label, and tooltip all report the same clipped 2 seconds | Non-finite/reversed timestamps produce no painted interval |
| Out-of-axis interval | Ten-second axis with a segment spanning before and after it | Bar fills the axis and reports 10 seconds | Clipping never manufactures time outside the shared domain |

</frozen-after-approval>

## Code Map

- `src/main/types/chunks.ts` -- `SwimlaneModel` is the IPC wire contract; add an explicit projection schema version so unversioned models are identifiable instead of conflated with current `child-wait` data.
- `src/main/services/analysis/SwimlaneBuilder.ts:868` -- sole production model builder; stamp the current schema version while retaining the established axis and evidence derivation.
- `src/main/services/infrastructure/DataCache.ts:37` -- cached `SessionDetail` structure version remains `2`; increment it for the changed swimlane payload.
- `src/renderer/components/chat/SwimlaneSurface.tsx:81` -- geometry already clips timestamps to the axis; introduce one boundary normalization path and feed normalized types, arrays, durations, labels, treatments, suppression, metrics, and targets through the existing renderer.
- `src/renderer/components/chat/SwimlaneSurface.tsx:779` -- the visible `7m38s` in the report is the midpoint (`axisDuration / 2`), not the endpoint; give clock ticks stable semantics so tests and assistive output distinguish them.
- `test/renderer/components/chat/SwimlaneSurface.test.tsx` -- current fixtures are type-correct and cannot expose stale runtime input; add unversioned, unknown, inconsistent-duration, clipped-axis, and tick-label cases.
- `test/main/services/analysis/SwimlaneBuilder.test.ts` and `test/main/services/analysis/ChunkBuilder.test.ts` -- assert schema version plus axis containment/duration invariants before and after JSON serialization.
- `test/main/services/infrastructure/DataCache.test.ts` -- create focused cache-version/invalidation coverage for stale `SessionDetail` structures.

## Tasks & Acceptance

**Execution:**
- [x] `src/main/types/chunks.ts`, `src/main/services/analysis/SwimlaneBuilder.ts`, and `src/main/services/infrastructure/DataCache.ts` -- version the current projection and invalidate structurally stale cached session details.
- [x] `src/renderer/components/chat/SwimlaneSurface.tsx` -- normalize untrusted runtime models once, use axis-clipped timestamp duration everywhere visible, and provide deterministic unattributed fallbacks.
- [x] Builder, cache, serialization, and surface tests -- cover every matrix row and assert the complete projection contract rather than only valid hand-authored fixtures.

**Acceptance Criteria:**
- Given the unversioned model shape that produced the screenshot, when the surface renders, then no visible, tooltip, accessible, or suppressed-detail text contains `undefined`, legacy request work remains usable, and unsupported legacy waits are labeled unattributed.
- Given a current projection, when it crosses the builder, cache, JSON serialization, and renderer boundaries, then its schema version, evidence categories, exact targets, metrics, and axis-consistent durations survive unchanged.
- Given inconsistent or out-of-axis parent timestamps and duration metadata, when rendered, then painted width, inline duration, and tooltip duration all describe the same intersection with the wall-clock axis.

## Spec Change Log

## Design Notes

An unversioned payload is legacy as a whole. This matters because `child-wait` exists in both schemas: preserving that string from the old catch-all projector would falsely claim the new parent-link and matched-spawn guarantees. Legacy `work` is safe to retain as assistant output because it was already grouped from the first through last assistant event for a request; the other legacy parent categories degrade to unattributed until a fresh current projection arrives.

## Verification

**Commands:**
- `node_modules/.bin/vitest run test/main/services/analysis/SwimlaneBuilder.test.ts test/main/services/analysis/ChunkBuilder.test.ts test/main/services/infrastructure/DataCache.test.ts test/renderer/components/chat/SwimlaneSurface.test.tsx test/renderer/components/chat/ChatHistory.test.ts` -- expected: legacy/current normalization, serialization, cache, geometry, accessibility, and navigation pass.
- `npm run typecheck && npm run lint && npm test && npm run build && git diff --check` -- expected: all static checks, full tests, production build, and patch validation pass.

## Suggested Review Order

**Runtime compatibility boundary**

- Start with the single normalization gateway for every stale or current projection.
  [`SwimlaneSurface.tsx:183`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L183)

- Timestamp intersection keeps painted geometry and displayed durations identical.
  [`SwimlaneSurface.tsx:147`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L147)

- Runtime metrics and navigation accept only honest, resolvable values.
  [`SwimlaneSurface.tsx:99`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L99)

- The public surface normalizes before any rendering or interaction state.
  [`SwimlaneSurface.tsx:1373`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1373)

**Wire version and freshness**

- An explicit schema version distinguishes causal projections from legacy lookalikes.
  [`chunks.ts:77`](../../src/main/types/chunks.ts#L77)

- The sole production builder stamps every freshly derived projection.
  [`SwimlaneBuilder.ts:904`](../../src/main/services/analysis/SwimlaneBuilder.ts#L904)

- Cache version three invalidates session details carrying the prior wire shape.
  [`DataCache.ts:37`](../../src/main/services/infrastructure/DataCache.ts#L37)

**Presentation clarity**

- Axis tick names distinguish midpoint from endpoint and include their durations.
  [`SwimlaneSurface.tsx:1070`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1070)

**Regression coverage**

- The screenshot's unversioned payload proves honest legacy classification and navigation.
  [`SwimlaneSurface.test.tsx:347`](../../test/renderer/components/chat/SwimlaneSurface.test.tsx#L347)

- Malformed roots, axes, and schema versions fail closed without crashing.
  [`SwimlaneSurface.test.tsx:458`](../../test/renderer/components/chat/SwimlaneSurface.test.tsx#L458)

- Child clipping and point metadata preserve scale honesty without synthetic tokens.
  [`SwimlaneSurface.test.tsx:578`](../../test/renderer/components/chat/SwimlaneSurface.test.tsx#L578)

- Duplicate runtime identities remain deterministic across every rendered collection.
  [`SwimlaneSurface.test.tsx:758`](../../test/renderer/components/chat/SwimlaneSurface.test.tsx#L758)

- Builder invariants protect schema stamping, axis containment, and serialized duration.
  [`SwimlaneBuilder.test.ts:86`](../../test/main/services/analysis/SwimlaneBuilder.test.ts#L86)

- Cache coverage locks the version-two invalidation and version-three stamp.
  [`DataCache.test.ts:27`](../../test/main/services/infrastructure/DataCache.test.ts#L27)
