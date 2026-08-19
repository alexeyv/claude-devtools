---
title: 'Add swimlane hover time cursor'
type: 'feature'
created: '2026-08-18'
status: 'done'
review_loop_iteration: 0
baseline_commit: '48f5659b71035ddb5c8810b945a068df87421535'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The elapsed-time ruler is readable at rest, but locating the exact time represented by an arbitrary point across the lanes requires visual interpolation. Users need continuous pointer feedback anywhere within the timeline clock.

**Approach:** While the pointer is over the ruler or any parent/child clock track, draw one red vertical guide through the lane region at that exact horizontal position and place a precise elapsed-time label near the pointer. Keep the guide synchronized with zooming, panning, scrolling, and resizing, and hide it immediately outside clock regions.

## Boundaries & Constraints

**Always:** Use the same zero-anchored elapsed-time domain as the ruler; map against the full zoomed clock width; show the guide over ruler, intervals, and empty track space; keep the time label inside the visible viewport near the pointer; span only the ruler and rendered lanes; preserve interval hover/focus details, clicks, ruler drag-to-pan, native scrolling, sticky labels, and keyboard access; use existing theme tokens with a distinctly red guide; and produce finite output for degenerate models.

**Ask First:** Showing wall-clock timestamps instead of elapsed time; making the guide keyboard-operable or persistent; changing ruler precision or tick generation; extending the guide into labels, suppressed-detail sections, or other ChatHistory regions; or adding model data.

**Never:** Intercept pointer events; derive coordinates from a nested target's `offsetX`; announce every pointer move to assistive technology; replace or close the existing interval tooltip; paint over the fixed label column; or leave stale guide state after the pointer leaves, the model changes, or the surface unmounts.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Clock hover | Pointer enters ruler, an interval, or empty parent/child track | One red guide follows pointer x and a nearby label shows the corresponding elapsed time | Clamp start/end coordinates and label placement to visible bounds |
| Non-clock hover | Pointer moves over sticky labels, padding, suppressed details, or outside the canvas | Guide and label are hidden immediately | Descendant elements must not confuse region detection |
| Changed geometry | Pointer remains while zoom, native scroll, ruler drag, vertical scroll, resize, or Fit changes geometry | Guide remains under the pointer and time is recomputed from current geometry | Clear safely when the pointer no longer resolves to a clock region |
| Degenerate axis | Zero-duration model or very narrow viewport | Guide remains stable and label shows finite zero elapsed time | Never render `NaN` or `Infinity` |

</frozen-after-approval>

## Code Map

- `src/renderer/components/chat/SwimlaneSurface.tsx:489-525` -- reuse the elapsed-time formatting helpers with clock resolution so the hover label agrees with the existing ruler from milliseconds through hours.
- `src/renderer/components/chat/SwimlaneSurface.tsx:1204-1390` -- `SwimlaneSurfaceContent` owns axis, zoom, viewport, scroll, ruler-pan, and tooltip lifecycle state; add pointer coordinates and recomputation/cleanup alongside those geometry paths.
- `src/renderer/components/chat/SwimlaneSurface.tsx:1633-2010` -- identify the ruler and every parent/child clock as hover-active regions and render a single non-interactive canvas overlay with viewport-aware label placement; exclude the sticky label column and suppressed details.
- `src/renderer/components/chat/SwimlaneSurface.tsx:840-945,1065-1145` -- preserve interval pointer/click handlers and the existing portal tooltip; the cursor label is supplemental, visually layered, and not another `role="tooltip"`.
- `test/renderer/components/chat/SwimlaneSurface.test.tsx:249-290` -- extend geometry mocks with canvas/clock rectangles and scroll-aware pointer coordinates.
- `test/renderer/components/chat/SwimlaneSurface.test.tsx:301-710,1381-1430,1731-1863` -- cover mapping, Fit/zoom/scroll/ruler-drag synchronization, clock-region boundaries, tooltip coexistence, and unchanged target clicks.

## Tasks & Acceptance

**Execution:**
- [x] `src/renderer/components/chat/SwimlaneSurface.tsx` -- implement the pointer-only hover guide and elapsed label using current clock geometry without changing projection or navigation contracts.
- [x] `test/renderer/components/chat/SwimlaneSurface.test.tsx` -- verify every matrix row, viewport-edge label placement, red non-interactive styling, zero-duration safety, tooltip coexistence, and ruler/click regressions.

**Acceptance Criteria:**
- Given a fitted or zoomed swimlane, when the pointer moves anywhere within a ruler or lane clock region, then a red guide stays directly beneath it and the nearby label reports the correct zero-anchored elapsed time.
- Given existing interval hover, click, keyboard, scrolling, and ruler-pan interactions, when the hover guide is visible, then each interaction retains its current behavior and accessibility semantics.

## Spec Change Log

## Design Notes

Use client coordinates and the rendered canvas/clock rectangle rather than event-target offsets, because nested interval elements and horizontal panning otherwise shift the result. The overlay should be `pointer-events: none` and below sticky labels but above clock content. Treat it as sighted pointer feedback (`aria-hidden`) because the ruler and focusable interval details remain the keyboard-accessible path.

## Verification

**Commands:**
- `node_modules/.bin/vitest run test/renderer/components/chat/SwimlaneSurface.test.tsx test/renderer/components/chat/ChatHistory.test.ts` -- expected: hover mapping, interaction coexistence, zoom/pan behavior, and integration tests pass.
- `npm run typecheck && npm run lint && npm test && npm run build && git diff --check` -- expected: static checks, full suite, production build, and patch hygiene pass.

## Suggested Review Order

**Pointer mapping and feedback**

- Maps clock geometry into finite elapsed time and collision-safe viewport placement.
  [`SwimlaneSurface.tsx:1293`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1293)

- Coalesces pointer updates while touch, cancellation, and invalid geometry clear synchronously.
  [`SwimlaneSurface.tsx:1426`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1426)

- Carries precision-aware rounding cleanly across minute and hour boundaries.
  [`SwimlaneSurface.tsx:524`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L524)

**Rendering and interaction coexistence**

- Keeps resize and scroll synchronization singular, current, and stale-state safe.
  [`SwimlaneSurface.tsx:1517`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1517)

- Marks only ruler and lane clocks as active pointer regions.
  [`SwimlaneSurface.tsx:1919`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1919)

- Layers the red guide without intercepting bars, tooltips, or higher overlays.
  [`SwimlaneSurface.tsx:2345`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L2345)

**Verification**

- Covers start/end mapping, clock boundaries, pointer kinds, cancellation, and coalescing.
  [`SwimlaneSurface.test.tsx:509`](../../test/renderer/components/chat/SwimlaneSurface.test.tsx#L509)

- Exercises geometry changes, rollover labels, stale cleanup, tooltip coexistence, and clicks.
  [`SwimlaneSurface.test.tsx:615`](../../test/renderer/components/chat/SwimlaneSurface.test.tsx#L615)
