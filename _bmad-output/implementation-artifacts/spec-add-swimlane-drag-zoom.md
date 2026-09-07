---
title: 'Add swimlane drag-to-zoom'
type: 'feature'
created: '2026-09-07'
status: 'done'
baseline_commit: '4640ca59da18038a5fca255a09f5412dfd9aacb1'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Inspecting a short time range in the swim lane currently requires adjusting the zoom controls and then finding the desired position. The user needs mouse dragging to zoom into an area directly.

**Approach:** A primary-button drag anywhere in the timeline plotting area, including empty space below or between lanes, selects a horizontal time range. Hover anywhere in that area shows the elapsed-time cursor. Both the cursor guide and translucent selection span the entire timeline view height. On release, center the selected range at the closest supported zoom level that contains it. Keep ruler dragging available for panning. Once verified, open the app on the user's last-viewed session and show the swim lane.

## Boundaries & Constraints

**Always:** Support either drag direction, including drags starting over an interval. Preserve ordinary clicks and keyboard navigation. Require at least 5px horizontal movement before treating the gesture as a selection. Keep the existing power-of-two zoom levels, duration-based maximum, fixed labels, row geometry, scrollbar navigation, context heat, and elapsed ruler. Suppress navigation from the click generated after a completed drag. Retain the current zoom controls as the keyboard-accessible alternative and way to zoom back out. Restore the last-viewed session using available app state.

**Ask First:** Changing the existing zoom scale or minimum duration, adding persisted viewport preferences, or choosing a different session when the last-viewed session cannot be established.

**Never:** Start selection from the sticky labels, toolbar, ruler, scrollbars, or hidden-interval details. Add backend/model fields or dependencies. Interpret touch scrolling or non-primary buttons as selection gestures. Launch a different session based only on its file modification time.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Select range | Primary-button lane drag of at least 5px | Highlight selected span; release zooms and centers it | Clamp to supported zoom bounds |
| Empty timeline area | Hover or drag below/between lanes within the visible time columns | Same elapsed cursor and range zoom as over a lane; elapsed-only label outside lanes | Preserve horizontal clock mapping, including when zoomed/scrolled |
| Full view height | Few rows leave blank space, or many rows require vertical scrolling | Cursor guide and selection cover the whole visible plotting height | Resize and scroll keep overlays aligned; overlays never intercept controls |
| Reverse direction | Drag right to left | Same result as equivalent left-to-right selection | Normalize endpoints |
| Existing zoom | Timeline already zoomed and scrolled | Selection maps to the correct absolute session times | Include scroll offset and fixed-label geometry |
| Ordinary click | No drag or horizontal travel below 5px | Existing interval navigation still works | No zoom or stale click suppression |
| Completed drag on interval | Release after selecting across a clickable interval | Zoom without navigating away | Suppress only the associated pointer click |
| Outside release | Pointer leaves the viewport during selection | Continue gesture and clamp range to visible clock edges | Release outside completes cleanly |
| Interrupted gesture | Escape, blur, pointer cancellation, resize, scroll, or model replacement | Remove selection without applying zoom | Release capture/listeners and clear transient state |
| Bounds | Zero-duration run, maximum zoom, or broad selection | Finite geometry and no unsupported zoom | Never zoom out as a side effect of selection |

</frozen-after-approval>

## Code Map

- `src/renderer/components/chat/SwimlaneSurface.tsx` — `SwimlaneSurfaceContent` owns zoom, measured fit width, scroll position, tooltips and hover cursor. `pendingCenterRef` and the zoom layout effect implement center-preserving scroll updates; selection needs an explicit selected center, including when the level stays unchanged.
- Same file — `setZoom` clamps integer levels; `maximumZoomLevel` enforces the duration bound. `beginRulerPan` and window mouse listeners implement existing ruler panning. Lane elements expose `data-swimlane-clock-region` and `data-swimlane-lane-id`; ruler also marks a clock region, so selection must distinguish lanes.
- Same file — canvas overlays render the hover guide above all rows. Reuse canvas coordinates for a pointer-transparent selection spanning the lanes. Coordinate mapping must account for sticky label occlusion and viewport clipping.
- Follow-up: `beginSelection` and `recomputeHoverCursor` must use shared viewport/canvas clock bounds, not require a lane ancestor. Retain lane identity only for contextual token lookup. Give the canvas at least the viewport height, and use full-content top/bottom overlay extents so vertically scrolled views stay covered. Preserve exclusions for actual controls, ruler panning, sticky labels and scrollbar gutters.
- `test/renderer/components/chat/SwimlaneSurface.test.tsx` — existing DOM geometry, pointer, mouse, resize and zoom harnesses cover interactions, long timelines, and model replacement.
- `test/renderer/components/chat/ChatHistory.test.ts` — integration regression boundary for target navigation and view switching.
- `package.json` — `dev` launches Electron; static checks, Vitest, and production build commands are available.

## Tasks & Acceptance

**Execution:**
- [x] `src/renderer/components/chat/SwimlaneSurface.tsx` — implement selection lifecycle, overlay, selected-range zoom, click suppression, cancellation, and concise visible/accessibility instructions.
- [x] `test/renderer/components/chat/SwimlaneSurface.test.tsx` — cover the matrix with assertions on zoom, selected time/scroll location, navigation callbacks and cleanup; retain existing ruler-pan and hover coverage.
- [x] `src/renderer/components/chat/SwimlaneSurface.tsx` — extend hover and drag hit areas to blank plotting space and both overlays to the full view height; update the lane-only interaction hint.
- [x] `test/renderer/components/chat/SwimlaneSurface.test.tsx` — verify empty-space hover/drag, full-height overlay layout, resize, vertical scrolling, and absolute-time alignment when horizontally zoomed/scrolled.
- [x] `package.json` — use existing scripts to verify and launch the app, then restore the last-viewed session using app state; no script edit was needed. User-selected session was already open at follow-up and was preserved.

**Acceptance Criteria:**
- Given a rendered session, when a range is selected in either direction, then all lanes and the ruler remain aligned and the selected time span is visible after release.
- Given existing navigation and zoom controls, when used after a drag or cancellation, then they retain their established behavior without stale selection state.
- Given verification is complete and the last-viewed session is identifiable, when the app is opened, then that session's swim lane is displayed.

## Spec Change Log

- 2026-09-07: User explicitly expanded interaction from lanes to the entire plotting area and requested full-height timeline widgets. Updated approved intent and matrix accordingly. Keep zoom geometry, click suppression, cancellation, controls, and ruler panning from the verified implementation.
- 2026-09-07 corrective follow-up: User reported intermittent drag failure after drag/Escape. Native inspection found expanded evidence text scrolled offscreen inside an unconstrained details block, whose invisible full-canvas hit box was excluded from plot gestures. Shrink-wrap that block, cap it to fitted viewport width, and wrap long labels. Preserve native keyboard focus and evidence navigation. Added fresh-drag-after-Escape tests both during selection and after committed zoom.

## Verification

**Commands:**
- `node_modules/.bin/vitest run test/renderer/components/chat/SwimlaneSurface.test.tsx test/renderer/components/chat/ChatHistory.test.ts` — interaction and integration tests pass.
- `npm run typecheck` and `npm run lint` — static checks pass.
- `npm run build` and `git diff --check` — production build and patch checks pass.

Inspect the running app's selection highlight, zoom destination, ordinary click behavior, ruler pan, and restored session.

## Verification Results

- 2026-09-07: All 108 SwimlaneSurface and ChatHistory interaction/integration tests passed after review fixes.
- Typecheck, full repository lint, production build, and `git diff --check` passed.
- Three independent review layers completed. Patched cancelled-drag click suppression, unrelated pointer cancellation, and text-selection scope; added arbitrary-range containment, reverse clipping, lost-button and hidden-details regressions.
- Launched the updated app with `npm run dev`; native UI shows the dashboard. No session was restored. Startup does not persist the active session; context snapshots are only for context switching. Asked the user for the last-viewed project/session identity.
- At the initial handoff, native swimlane inspection and restoration were pending session identity; resolved at the follow-up below.
- 2026-09-07 follow-up: User's active `ui.wt` session for Shortcut story 23057 was open in the native app and preserved. Confirmed elapsed hover in empty space and guide coverage from the timeline top to the viewport bottom by screenshot.
- Final verification: 113 interaction/integration tests, typecheck, full repository lint, production build, and diff checks passed. Three independent review layers completed; prevented native text selection on blank-area drag origins and strengthened overlay tests against fixed-height regressions.
- Native automation limitation: CUA drag emitted pointer movement with `buttons: 0`, confirmed using temporary diagnostic logs, correctly triggering lost-button cancellation. Removed all diagnostic code. Held-button zoom and selection overlay behavior are covered by the interaction tests; a full native held-button drag was not verified.
- Corrective follow-up verification: 116 interaction/integration tests passed. Native screenshot at 800% zoom confirmed expanded evidence remained open, its text offscreen, and the elapsed cursor appeared below the lanes immediately after Escape. This exercises actual browser hit testing for the previously blocked area; held-button continuation is covered in component tests. Independent reviews identified long-label overflow and test assertion gaps, which were addressed.
- Corrective follow-up typecheck, full lint, production build, and diff checks also passed.

## Suggested Review Order

- Keep offscreen evidence from covering the blank timeline with an invisible interactive box.
  [SwimlaneSurface.tsx:3005](../../src/renderer/components/chat/SwimlaneSurface.tsx#L3005)
- Verify repeated drag after Escape, bounded evidence layout, resize, and long-label navigation.
  [SwimlaneSurface.test.tsx:803](../../test/renderer/components/chat/SwimlaneSurface.test.tsx#L803)
- Start with shared plotting bounds and full-area selection entry.
  [SwimlaneSurface.tsx:1689](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1689)
- Follow release handling, range containment, centering, and click suppression.
  [SwimlaneSurface.tsx:1778](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1778)
- Inspect gesture cancellation and model replacement cleanup.
  [SwimlaneSurface.tsx:1676](../../src/renderer/components/chat/SwimlaneSurface.tsx#L1676)
- Inspect full-height selection and hover overlay geometry.
  [SwimlaneSurface.tsx:3062](../../src/renderer/components/chat/SwimlaneSurface.tsx#L3062)
- Verify blank-space interaction, resize, vertical scrolling, and fixed-height regression coverage.
  [SwimlaneSurface.test.tsx:527](../../test/renderer/components/chat/SwimlaneSurface.test.tsx#L527)
