---
title: 'Evidence-based parent wall-time classification'
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
baseline_commit: '5adf58f159f3da1bceb68f01cbbf01f258c31f0a'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The parent swimlane currently calls all unfilled time idle and stretches sparse events into broad waits, so absence of logged output is presented as absence of work. Its 2px minimum also exaggerates instantaneous and sub-pixel activity.

**Approach:** Build a causal wall-time projection from request groups, message parent links, matched tool calls/results, linked child activity, and explicit user boundaries. Partition supported time into model response, assistant output, tool execution, child wait, and human wait; label only the unsupported remainder unattributed, and render intervals at their true scale.

## Boundaries & Constraints

**Always:** Define model response as submission-to-first-assistant-event observed latency and assistant output as first-to-last event for one request ID. Keep matched tool duration exact in the serialized model. Prefer specialized human/child evidence over a coincident generic tool range. Preserve exact microscope targets, child hierarchy, shared wall-clock axis, metrics, accessible details, and deterministic serialization. Retain suppressed sub-pixel intervals in model metadata and expose an aggregate count/detail affordance without painting a false-width bar.

**Ask First:** Adding a new lane or persisted UI state; changing child ownership, request parsing, session boundaries, or navigation behavior; inventing a server-only inference measurement; treating an unmatched call/result or unlinked process as causally matched.

**Never:** Stretch point events or sparse logs to fill gaps; describe unsupported gaps as idle; manufacture request IDs or parent links; enlarge short intervals for visibility; discard exact timestamps/durations merely because the current zoom cannot paint them; double-attribute overlapping wall time.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Request cycle | User or tool-result message is the causal parent of request-ID assistant events | Submission-to-first event is model response; first-to-last same-request events are assistant output | Broken/missing parent linkage stays unattributed |
| Matched tool | Tool-use ID has a timestamped result | Exact call-to-result interval is tool execution | Unmatched calls/results do not create stretched spans |
| Linked child | Parent-linked child is active during a matched tool span | Active overlap is child wait and surrounding supported tool time remains tool execution | Unlinked process activity does not suspend the parent |
| Human boundary | Ask has a matching answer, or a later real-user resume is parent-linked | Prior output/ask to input is human wait; input to next output is model response | Mere later user presence without causal linkage is not enough |
| Overlap | Multiple evidence ranges cover one wall-clock slice | Deterministic precedence assigns the slice once while retaining source evidence | Unsupported remainder is unattributed |
| Short activity | Exact interval is below the meaningful-pixel threshold | No enlarged bar; model duration and suppressed count/details remain available | Zero-duration activity remains metadata only |

</frozen-after-approval>

## Code Map

- `src/main/services/analysis/SwimlaneBuilder.ts` -- replace `WorkRange`/broad inferred waits and the `work > HITL > child > idle` fill with causal evidence ranges. `buildWorkRanges` already request-groups assistant events; message UUID/`parentUuid`, `toolUseIds`, `Process.parentTaskId`, result identity, and child ownership are the authoritative linkage points. Preserve deterministic overlap slicing, one metrics owner, and exact targets.
- `src/main/types/chunks.ts` -- replace the four catch-all segment types with the six wall-time categories and add serializable causal/source metadata needed to preserve exact underlying ranges and suppressed activity.
- `src/renderer/components/chat/SwimlaneSurface.tsx` -- update semantic treatments/labels and remove `MIN_INTERVAL_WIDTH`/`minWidth` inflation from `intervalStyle` and `intervalPixelWidth`. Render only meaningful-width intervals, retain accessible aggregate metadata for suppressed intervals, and keep existing tooltip/navigation/hierarchy/HITL behavior.
- `test/main/services/analysis/SwimlaneBuilder.test.ts` -- rebase classification tests on parent-linked request cycles, matched tools, linked children, explicit/later-user waits, overlap precedence, unmatched evidence, and exact serialized durations.
- `test/renderer/components/chat/SwimlaneSurface.test.tsx` -- update fixtures and assert true proportional widths, sub-pixel suppression metadata, new treatments/accessible names, details, and unchanged target behavior.
- `test/main/services/analysis/ChunkBuilder.test.ts` and `test/renderer/components/chat/ChatHistory.test.ts` -- protect projection serialization and the existing integration/navigation boundary.

## Tasks & Acceptance

**Execution:**
- [x] `src/main/types/chunks.ts` and `src/main/services/analysis/SwimlaneBuilder.ts` -- model and derive a deterministic, non-overlapping causal account of parent wall time while retaining exact evidence durations.
- [x] `src/renderer/components/chat/SwimlaneSurface.tsx` -- render the new semantics honestly at the measured pixel scale and surface suppressed-activity metadata accessibly.
- [x] Builder, surface, chunk, and history tests -- cover every matrix row and preserve serialization, accessibility, and exact navigation.

**Acceptance Criteria:**
- Given a session with causally linked requests, tools, children, and human input, when the projection is built, then every parent slice is assigned once from timestamped evidence or explicitly marked unattributed.
- Given a matched 5ms tool execution on a scale where it occupies less than one meaningful pixel, when rendered, then its model duration remains 5ms and no wider execution bar is painted.
- Given existing turn and subagent targets, when classified bars are activated, then navigation reaches the same microscope card exactly once.

## Spec Change Log

## Design Notes

Evidence precedence resolves overlap as human wait, child wait, tool execution, assistant output, model response, then unattributed; specialized suspension evidence wins over generic activity. Each rendered segment reports attributed duration, while causal metadata retains its source interval and identity so slicing never falsifies the underlying matched duration.

## Verification

**Commands:**
- `node_modules/.bin/vitest run test/main/services/analysis/SwimlaneBuilder.test.ts test/main/services/analysis/ChunkBuilder.test.ts test/renderer/components/chat/SwimlaneSurface.test.tsx test/renderer/components/chat/ChatHistory.test.ts` -- expected: causal classification, serialization, scale honesty, and navigation pass.
- `npm run typecheck && npm run lint && npm test && npm run build && git diff --check` -- expected: all static, full-suite, production-build, and patch checks pass.

**Manual checks (if no CLI):**
- Inspect dense and sparse parent timelines at narrow and wide widths; labels/categories remain honest, short activity is not enlarged, and suppressed counts/details remain discoverable.

## Suggested Review Order

**Causal projection**

- Start with the entry point composing exact evidence and attributed wall-time slices.
  [`SwimlaneBuilder.ts:868`](../../src/main/services/analysis/SwimlaneBuilder.ts#L868)

- Request parent links define observed model-response latency without server inference.
  [`SwimlaneBuilder.ts:197`](../../src/main/services/analysis/SwimlaneBuilder.ts#L197)

- Matched results and explicit user links establish tool and human intervals.
  [`SwimlaneBuilder.ts:235`](../../src/main/services/analysis/SwimlaneBuilder.ts#L235)

- Matched spawn ownership bounds child suspension and rejects disconnected processes.
  [`SwimlaneBuilder.ts:573`](../../src/main/services/analysis/SwimlaneBuilder.ts#L573)

- Deterministic precedence partitions every supported slice exactly once.
  [`SwimlaneBuilder.ts:755`](../../src/main/services/analysis/SwimlaneBuilder.ts#L755)

**Scale-honest presentation**

- Existing theme tokens distinguish all six parent classifications.
  [`SwimlaneSurface.tsx:119`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L119)

- Visible evidence IDs prevent hidden exact ranges from disappearing.
  [`SwimlaneSurface.tsx:677`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L677)

- Keyboard-accessible hidden details preserve counts, metrics, and navigation.
  [`SwimlaneSurface.tsx:998`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L998)

**Contracts and verification**

- Projection types retain exact causal metadata independently of displayed slices.
  [`chunks.ts:77`](../../src/main/types/chunks.ts#L77)

- Causal-cycle tests cover model latency, exact tools, and parent attribution.
  [`SwimlaneBuilder.test.ts:250`](../../test/main/services/analysis/SwimlaneBuilder.test.ts#L250)

- Serialization tests protect evidence metrics, targets, and 5ms duration.
  [`ChunkBuilder.test.ts:495`](../../test/main/services/analysis/ChunkBuilder.test.ts#L495)

- Renderer tests prove sub-pixel tools stay metadata without false-width bars.
  [`SwimlaneSurface.test.tsx:558`](../../test/renderer/components/chat/SwimlaneSurface.test.tsx#L558)
