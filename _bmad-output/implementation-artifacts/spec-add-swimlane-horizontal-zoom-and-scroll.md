---
title: 'Add swimlane horizontal zoom and scroll'
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
baseline_commit: '0b96218425f80d535003126d833c0df35d03affc'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The swimlane opens at a fixed minimum clock width, so narrow panes can overflow before the user asks to zoom while dense or long runs cannot be expanded for inspection. The timeline needs an explicit horizontal zoom control and a real scrolling viewport without making the rows or typography larger.

**Approach:** Make Fit the 100% baseline: the full skill run always spans the available horizontal clock area when the swimlane opens. A local, accessible zoom control expands only the wall-clock axis beyond 100%, with the resulting canvas navigated inside a bounded horizontal-and-vertical scroll area.

## Boundaries & Constraints

**Always:** At 100%, fit the complete start-to-end axis into one horizontal viewport with no horizontal scrollbar. Keep the 184px label column, row heights, track heights, font sizes, and vertical scale unchanged at every zoom. Let the lane list scroll vertically whenever its natural height exceeds the viewport; show horizontal overflow only above 100%. Report both zoom percent and the measured time-per-pixel scale, keep labels sticky while panning, preserve the visible time center when zoom changes, and retain existing interval geometry, sub-pixel suppression, HITL layout, tooltips, accessibility, and exact navigation.

**Ask First:** Persisting zoom or scroll position across closing/reopening the swimlane or across sessions; changing the projection model, wall-time classifications, row hierarchy, or navigation targets; adding vertical zoom, filtering, minimaps, or alternate time units.

**Never:** Use CSS transform/visual scaling that leaves layout and scroll geometry stale; allow Fit/100% to overflow horizontally; scale lane height, controls, labels, fonts, borders, or tooltip content with the time axis; zoom the fixed label column; replace exact proportional timing with minimum-width bars.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Initial view | Any valid run opens at 100% | Entire run fits horizontally; vertical overflow remains independently scrollable | Zero-duration or very narrow panes render a stable fitted axis without invalid scale text |
| Zoom in | User raises zoom above 100% | Only clock width grows, a horizontal scroll range appears, and the viewport remains centered on the same time | Clamp to supported zoom bounds and disable unavailable decrement/increment actions |
| Return to Fit | User activates Fit after panning | Zoom returns to 100%, horizontal overflow and stale scroll offset disappear, and the full run is visible | Tooltip state closes safely when geometry changes |
| Responsive resize | Pane width changes at any zoom | 100% refits; higher zoom recomputes from the new fitted width and updates seconds per pixel | Existing measured-width collision and suppression rules rerun from actual layout width |

</frozen-after-approval>

## Code Map

- `src/renderer/components/chat/SwimlaneSurface.tsx:16` -- replace the fixed 720px clock minimum with a fitted horizontal baseline; keep `LABEL_COLUMN_WIDTH`, `ROW_HEIGHT`, and type styles invariant.
- `src/renderer/components/chat/SwimlaneSurface.tsx:375` -- percentage interval geometry is already scale-independent; continue using measured layout width for `intervalPixelWidth`, fitted duration labels, suppressed evidence, and navigation.
- `src/renderer/components/chat/SwimlaneSurface.tsx:638` -- make row and clock layout accept a zoomed clock width while the label column stays fixed and sticky.
- `src/renderer/components/chat/SwimlaneSurface.tsx:891` -- add component-local zoom state, accessible Fit/range/step controls, measured time-per-pixel output, center-preserving scroll adjustment, and the combined scroll viewport. Local placement intentionally resets to Fit when the surface reopens or the model is replaced.
- `test/renderer/components/chat/SwimlaneSurface.test.tsx:233` -- extend the measured `ResizeObserver` harness for viewport, canvas, zoom, scroll, fit, bounds, and resize behavior while retaining geometry and tooltip coverage.
- `test/renderer/components/chat/ChatHistory.test.ts:389` -- regression boundary: keep the existing per-tab swimlane toggle and exact navigation behavior unchanged.
- `_bmad-output/specs/spec-session-swimlane/swimlane-visual.md:11` -- historical no-zoom statement is superseded by this approved feature; do not treat it as an implementation constraint.

## Tasks & Acceptance

**Execution:**
- [x] `src/renderer/components/chat/SwimlaneSurface.tsx` -- implement horizontal-only Fit/zoom and a bounded two-axis viewport using layout width, with accessible controls and scale feedback.
- [x] `test/renderer/components/chat/SwimlaneSurface.test.tsx` -- cover every matrix row, invariant row/type sizing, zoom accessibility, seconds-per-pixel, scroll centering, tooltip dismissal, and measured-width recomputation.
- [x] `test/renderer/components/chat/ChatHistory.test.ts` -- run the integration boundary to protect toggle state and target navigation.

**Acceptance Criteria:**
- Given a run of any duration, when the swimlane opens or returns to Fit, then 100% shows the complete horizontal time domain without a horizontal scrollbar.
- Given the user zooms and pans a dense run, when intervals are rendered or activated, then their horizontal detail increases while every vertical dimension, font size, semantic classification, and target behavior stays unchanged.

## Spec Change Log

## Design Notes

Treat zoom as a multiplier of the fitted clock width, not of the whole canvas: `zoomed clock = available clock at Fit × zoom`. The fixed label column and canvas padding therefore remain constant. A native range input plus step buttons and an explicit Fit action should expose the percentage and actual `duration / measured clock width` scale to sighted and assistive users.

## Verification

**Commands:**
- `node_modules/.bin/vitest run test/renderer/components/chat/SwimlaneSurface.test.tsx test/renderer/components/chat/ChatHistory.test.ts` -- expected: zoom/scroll behavior and existing surface integration pass.
- `npm run typecheck && npm run lint && npm test && npm run build && git diff --check` -- expected: static checks, full suite, production build, and patch validation pass.

## Suggested Review Order

**Fit and zoom geometry**

- Start with fitted-width state and measured horizontal scale composition.
  [`SwimlaneSurface.tsx:902`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L902)

- Center-preserving zoom clamps every control path to supported increments.
  [`SwimlaneSurface.tsx:993`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L993)

**Controls and scrolling**

- Responsive themed controls expose zoom percentage and time-per-pixel accessibly.
  [`SwimlaneSurface.tsx:1129`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1129)

- One bounded viewport owns independent vertical and zoom-driven horizontal overflow.
  [`SwimlaneSurface.tsx:1204`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1204)

**Scale-honest lanes**

- Parent geometry continues through the existing measured-width rendering path.
  [`SwimlaneSurface.tsx:1272`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1272)

- Child tracks receive the identical zoomed clock width without vertical scaling.
  [`SwimlaneSurface.tsx:1408`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1408)

**Verification**

- Fit, accessibility, and fixed vertical dimensions anchor the default-view contract.
  [`SwimlaneSurface.test.tsx:373`](../../test/renderer/components/chat/SwimlaneSurface.test.tsx#L373)

- Scrollbar-gutter coverage prevents tall lane sets from breaking horizontal Fit.
  [`SwimlaneSurface.test.tsx:420`](../../test/renderer/components/chat/SwimlaneSurface.test.tsx#L420)

- Button stepping, centering, bounds, reset, and dense detail cover interaction risks.
  [`SwimlaneSurface.test.tsx:434`](../../test/renderer/components/chat/SwimlaneSurface.test.tsx#L434)
