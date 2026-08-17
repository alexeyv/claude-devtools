---
title: 'Refine swimlane zoom and elapsed-time ruler'
type: 'feature'
created: '2026-08-17'
status: 'done'
review_loop_iteration: 0
baseline_commit: '879966ee4fdda0e7d0fcdb670a5c1a55871dd5ad'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Swimlane zoom advances in arbitrary 25% increments, stops before millisecond-scale activity is inspectable, reports an unhelpful seconds-per-pixel value, and offers only start/midpoint/end labels instead of a readable time ruler. Very high zoom on a long run also makes the native scrollbar too coarse for precise navigation.

**Approach:** Make zoom a factor-of-two sequence from Fit, bound it dynamically so the final visible span never goes below roughly 100ms, and replace scale text with a zero-anchored elapsed-time ruler using sparse, human-friendly ticks. Retain coarse native scrolling while allowing direct one-to-one ruler panning for precise movement through long runs.

## Boundaries & Constraints

**Always:** Keep Fit at 100% and make each plus/minus step change one power of two: 100%, 200%, 400%, 800%, and so on. Compute the maximum level from run duration so the most detailed viewport spans at least 100ms and, for ordinary pane widths, makes order-of-magnitude 1ms intervals visible. Show only the percentage in the zoom output. Place the ruler immediately above the lanes, anchor its elapsed values to session start at zero, use nice time steps and unit-aware labels, target roughly ten visible labels, prevent overlap, and never render more than twenty. Preserve visible center on zoom/resize, Fit reset, exact interval geometry, sticky labels, vertical dimensions, tooltips, accessibility, and navigation.

**Ask First:** Replacing the full-width canvas with a logically windowed timeline; changing the 100ms minimum viewport span; adding a minimap, persisted zoom/position, or new model data.

**Never:** Display seconds per pixel; use arbitrary decimal tick intervals such as 1.565s; restart elapsed labels at zero after panning; generate ticks for the entire offscreen multi-million-pixel clock; scale rows, labels, fonts, or the fixed label column; zoom closer than the supported duration bound.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Normal run | 10s run at Fit | Full run fits, output is 100%, and a zero-based ruler shows non-overlapping nice ticks | Tick density adapts to measured width |
| Exponential zoom | User presses plus repeatedly | Levels advance 100%, 200%, 400%, 800% while retaining the visible center | Controls clamp and disable at either bound |
| Maximum detail | Run is longer than 100ms | Highest level leaves a visible span in `[100ms, 200ms)` and exposes millisecond-class intervals | Runs of 100ms or less remain at Fit |
| Long-run navigation | 15-minute run at maximum zoom | Ruler renders at most twenty visible ticks and direct ruler drag pans one-to-one with the content | Native scrollbar remains available for coarse movement |
| Panned or resized | Viewport position/width changes | Tick values remain globally zero-anchored and recompute without collisions | Offscreen ticks are not mounted |
| Degenerate run | Zero duration or extremely narrow clock | Stable 100% output and finite ruler state | Zoom stays disabled; no NaN/Infinity labels |

</frozen-after-approval>

## Code Map

- `src/renderer/components/chat/SwimlaneSurface.tsx:16` -- replace fixed percent bounds/steps with discrete power-of-two levels and a duration-derived maximum; keep the 1px visibility threshold and vertical constants.
- `src/renderer/components/chat/SwimlaneSurface.tsx:374` -- remove seconds-per-pixel formatting and add ruler-specific nice-step and precision-aware elapsed-label helpers; shared `formatDuration()` is too lossy for adjacent millisecond ticks.
- `src/renderer/components/chat/SwimlaneSurface.tsx:902` -- retain measured Fit width and center preservation while tracking zoom level and scroll position; derive visible elapsed bounds and only the buffered visible ticks.
- `src/renderer/components/chat/SwimlaneSurface.tsx:1128` -- make the range level-based with percentage `aria-valuetext`, percentage-only output, and factor-of-two buttons.
- `src/renderer/components/chat/SwimlaneSurface.tsx:1202` -- keep the bounded two-axis viewport, make it keyboard reachable, and add precise direct panning on the ruler without changing lane geometry.
- `src/renderer/components/chat/SwimlaneSurface.tsx:1223` -- replace the three-label axis with actual tick hairlines and collision-safe elapsed labels immediately above the parent lane.
- `test/renderer/components/chat/SwimlaneSurface.test.tsx:297` -- replace midpoint/endpoint assertions and revise the zoom harness for dynamic levels, ruler virtualization, nice ms/s/min steps, resize/pan, detail bounds, and precise long-run panning.
- `test/renderer/components/chat/ChatHistory.test.ts:389` -- regression-only integration boundary for the existing toggle and exact target navigation.
- `_bmad-output/implementation-artifacts/spec-add-swimlane-horizontal-zoom-and-scroll.md:21` -- historical seconds-per-pixel requirement is superseded by this human request.

## Tasks & Acceptance

**Execution:**
- [x] `src/renderer/components/chat/SwimlaneSurface.tsx` -- implement exponential zoom, duration-aware maximum, virtualized nice-tick ruler, and direct ruler panning while preserving established geometry and interactions.
- [x] `test/renderer/components/chat/SwimlaneSurface.test.tsx` -- cover every matrix row plus center preservation, fixed vertical styling, tooltip dismissal, unique labels, and the twenty-label ceiling.
- [x] `test/renderer/components/chat/ChatHistory.test.ts` -- run the integration boundary to protect toggle and navigation behavior.

**Acceptance Criteria:**
- Given any supported run and pane width, when zooming and panning, then the ruler communicates elapsed time with readable nice ticks while lane positions remain on the same exact wall-clock axis.
- Given a 15-minute run at maximum zoom, when the user navigates with the scrollbar and ruler drag, then coarse and precise positioning both remain usable without mounting offscreen ruler labels.

## Spec Change Log

## Design Notes

Use an integer zoom level where `factor = 2^level`. Choose `maxLevel = floor(log2(duration / 100ms))` for durations above 100ms, otherwise zero. Tick selection should start near `visibleDuration / targetCount`, advance through a time-aware nice ladder (principally 1/2/5 multiples with conventional 15/30-second and minute steps), and increase again if estimated/measured label bounds would overlap. Tick positions remain multiples of the chosen step from elapsed zero.

## Verification

**Commands:**
- `node_modules/.bin/vitest run test/renderer/components/chat/SwimlaneSurface.test.tsx test/renderer/components/chat/ChatHistory.test.ts` -- expected: zoom, ruler, panning, accessibility, tooltip, and integration behavior pass.
- `npm run typecheck && npm run lint && npm test && npm run build && git diff --check` -- expected: static checks, full suite, production build, and patch validation pass.

## Suggested Review Order

**Zoom model and bounds**

- Duration-derived levels enforce factor-of-two zoom without crossing the 100ms detail floor.
  [`SwimlaneSurface.tsx:390`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L390)

- Center-preserving state composes measured Fit width with the discrete zoom factor.
  [`SwimlaneSurface.tsx:1126`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1126)

**Ruler scale and layout**

- Unit-aware formatting and nice-step selection cover milliseconds through compound hours.
  [`SwimlaneSurface.tsx:410`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L410)

- Visible-only tick selection coarsens for collisions and preserves zero anchoring.
  [`SwimlaneSurface.tsx:517`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L517)

- The elapsed ruler renders safe alignments directly above the unchanged lanes.
  [`SwimlaneSurface.tsx:1490`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1490)

**Interaction and accessibility**

- Zoom controls expose discrete levels, percentage announcements, and accessible range text.
  [`SwimlaneSurface.tsx:1399`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1399)

- Direct ruler dragging provides precise long-run panning with robust cancellation.
  [`SwimlaneSurface.tsx:1228`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1228)

- The focused viewport receives explicit keyboard, scrollbar, and ruler-drag guidance.
  [`SwimlaneSurface.tsx:1457`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1457)

**Verification**

- Power-of-two stepping, dynamic maximums, and center preservation anchor zoom behavior.
  [`SwimlaneSurface.test.tsx:451`](../../test/renderer/components/chat/SwimlaneSurface.test.tsx#L451)

- Panned, narrow, millisecond, and hour rulers protect scale and collision boundaries.
  [`SwimlaneSurface.test.tsx:538`](../../test/renderer/components/chat/SwimlaneSurface.test.tsx#L538)

- Fifteen-minute maximum zoom verifies precise drag navigation and cancellation.
  [`SwimlaneSurface.test.tsx:667`](../../test/renderer/components/chat/SwimlaneSurface.test.tsx#L667)
