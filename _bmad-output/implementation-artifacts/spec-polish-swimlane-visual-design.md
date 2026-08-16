---
title: 'Polish the swimlane visual design'
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 1
baseline_commit: '85d36dcdc0a5c5ff4a3d88ef57b78589960aeb95'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The swimlane is functionally correct but reads like debug output: dense parent segments print overlapping metrics, state differences are weak, hierarchy is hard to scan, and the oversized rows make concurrency difficult to understand.

**Approach:** Redesign the existing surface as a compact profiler-style timeline. Preserve duration as the scannable inline value, move the four token measures into an accessible hover/focus popover, strengthen existing-token state treatments and hierarchy, and suppress labels that cannot fit without collisions.

## Boundaries & Constraints

**Always:** Preserve the shared wall-clock axis, parent/child interval classification, continuation gaps, HITL boundaries, exact navigation targets, target-only click behavior, per-tab toggle state, and the existing turn-list microscope. Keep all interval details available to keyboard and pointer users. Use existing theme tokens in both light and dark mode; keep duration visible inside bars only where it fits, with full duration and token details always available through accessible names and the popover.

**Ask First:** Any lane-model or builder change; any new persisted state; changing navigation behavior; adding new analysis such as critical-path calculation, aggregation, filtering, or zoom; introducing new theme variables or semantic colors.

**Never:** Print full token strings outside their bars, let text overflow into adjacent intervals, invent per-agent colors unsupported by the model, make silent or cardless intervals navigational, add another microscope/overlay, reparse messages in the renderer, or restyle ChatHistory outside the swimlane surface.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Dense parent timeline | Many short adjacent segments | Bars remain visually distinct; labels that cannot fit are omitted rather than overlapping | Details remain available by hover/focus and accessible name |
| Work and wait states | Work, child-wait, HITL-wait, and idle share one row | Existing-token color, fill, hatch, and empty-track treatments are immediately distinguishable | Silent states never inherit the work treatment |
| Child hierarchy | Root and nested children overlap in time | Compact rows, nesting guides, indentation, and stronger labels expose hierarchy and concurrency | Long Unicode labels truncate safely and retain full accessible text |
| Detailed metrics | A parent work or child activation has metrics | Hover or keyboard focus opens one viewport-clamped tooltip with duration, input, cache read, cache write, and output | Tooltip closes on blur, pointer leave, scroll, and unmount |
| Navigation | Targeted and untargeted metric intervals | Targeted bars remain buttons and navigate once; untargeted metric bars can expose details without becoming clickable | No nested interactive controls or fabricated targets |
| Degenerate session | Zero-duration intervals, close HITL marks, or no children | Markers remain visible, HITL labels do not collide, and the parent-only timeline remains useful | No empty-state substitution or rendering error |

</frozen-after-approval>

## Code Map

- `src/renderer/components/chat/SwimlaneSurface.tsx` -- primary edit. Refine `rowStyle`, `labelStyle`, tracks, intervals, `segmentTreatment`, and the render loops. Work and child bars must gain stronger existing-token emphasis than the baseline while child-wait remains hatched, HITL remains warning-colored, and idle remains empty. Replace overflow-visible metric strings with compact duration labels and one local accessible portal tooltip. Base fit/collision decisions on the rendered clock width, reacting to resize, rather than the 720px minimum. Preserve target forwarding, shared-axis math, and continuation rendering.
- `src/renderer/components/chat/SwimlaneSurface.tsx` -- tooltip and accessibility lifecycle. Clamp against measured tooltip and viewport geometry including very narrow/short windows; close or recompute on scroll, resize, model replacement, detached triggers, Escape, and unmount; track hover and focus independently so either keeps details open. Use a component-safe tooltip ID rather than raw model IDs and avoid duplicate accessible announcements. Narrow silent intervals must retain pointer/keyboard access to their duration without becoming navigational. Keep coincident HITL boundaries separately perceivable, truncate labels by grapheme, and bound deep nesting indentation while retaining ancestor guides.
- `test/renderer/components/chat/SwimlaneSurface.test.tsx` -- extend `mixedModel()` coverage for compact layout, deliberately changed parent/child treatments, actual clock-width changes, collision suppression, tooltip pointer/keyboard/combined-modality lifecycle, targeted-button details, narrow silent details, horizontal and vertical viewport edges, resize/model replacement/Escape cleanup, narrow/zero-duration intervals, coincident HITL ticks, bounded deep nesting, grapheme-safe labels, and parent-only sessions.
- `src/renderer/components/chat/items/MetricsPill.tsx` -- read-only precedent for `createPortal`, fixed viewport-clamped positioning, scroll dismissal, and theme-token tooltip styling.
- `src/renderer/components/common/TokenUsageDisplay.tsx` -- read-only precedent for focus/blur and keyboard-accessible token detail presentation.
- `src/renderer/components/chat/ChatHistory.tsx` and `test/renderer/components/chat/ChatHistory.test.ts` -- integration boundary and regression suite; preserve the hidden mounted turn list, per-tab handoff, toggle, navigation, and virtualization.
- `src/main/types/chunks.ts` and `src/main/services/analysis/SwimlaneBuilder.ts` -- read-only authoritative projection; no new metadata, classification, metrics, or target logic.
- `_bmad-output/specs/spec-session-swimlane/swimlane-visual.md` -- historical contract. This change deliberately replaces its full always-visible token line with collision-free inline duration plus accessible hover/focus token detail.

## Tasks & Acceptance

**Execution:**
- [x] `src/renderer/components/chat/SwimlaneSurface.tsx` -- implement compact profiler styling, measurably stronger token-based state hierarchy, rendered-width collision decisions, robust tooltip geometry/lifecycle, safe hierarchy labels/guides, and separately perceivable HITL marks without changing model or navigation contracts.
- [x] `test/renderer/components/chat/SwimlaneSurface.test.tsx` -- verify every matrix row and protect real-width behavior, pointer/keyboard/combined-modality details on targeted and untargeted intervals, viewport edges, resize/model/Escape cleanup, target semantics, hierarchy, HITL density, and degenerate sessions.
- [x] `test/renderer/components/chat/ChatHistory.test.ts` -- run the existing integration suite to prove toggle, mounted-list preservation, virtualization, and exact click-through remain intact.

**Acceptance Criteria:**
- Given a dense real session, when the swimlane renders at its minimum clock width, then no duration or token text paints across neighboring intervals and the timeline's state/hierarchy remains readable.
- Given a metric-bearing interval, when a pointer hovers it or keyboard focus reaches it, then one themed tooltip presents the exact duration and four token measures without altering whether the interval is navigational.
- Given the surface is toggled or a targeted bar is clicked, when control returns to ChatHistory, then the existing per-tab list state and microscope navigation behave unchanged.

## Spec Change Log

- 2026-08-16: Review found the first implementation retained the baseline's weak state treatments and made duration/HITL collision and tooltip placement decisions from fixed estimates instead of rendered geometry. Amended the Code Map, tasks, tests, and design guidance to require visibly changed existing-token treatments, measured clock/tooltip geometry, narrow silent-interval details, independent hover/focus state, safe unique IDs, resize/model/Escape cleanup, targeted-button coverage, grapheme-safe bounded hierarchy, and separately perceivable coincident HITL boundaries. This avoids a compact but still visually weak surface whose labels remain unnecessarily hidden on wide clocks or whose tooltip leaves the viewport. KEEP: 34px-style compact rows, duration-as-scan/detail-as-tooltip layering, exact target-only navigation, portal presentation, collision suppression, nesting cues, and the passing integration boundary.

## Design Notes

Use a compact duration as the scan layer and a popover as the detail layer. Work should reuse existing active-context emphasis and child activations the card family so both are stronger than the original neutral bars; child-wait remains hatched, HITL warning amber, and idle empty. Do not use success, error, or arbitrary lane colors. Tooltip content is informational rather than interactive. Its trigger and `role="tooltip"` content must form one non-duplicative accessible description, and geometry must follow the rendered clock and viewport rather than constants alone.

## Verification

**Commands:**
- `node_modules/.bin/vitest run test/renderer/components/chat/SwimlaneSurface.test.tsx test/renderer/components/chat/ChatHistory.test.ts` -- expected: focused visual, accessibility, toggle, and navigation contracts pass.
- `npm run typecheck && npm run lint` -- expected: no TypeScript, hook, or accessibility errors and no new warnings.
- `npm test && npm run build && git diff --check` -- expected: full suite and production build pass with a clean patch.

**Manual checks (if no CLI):**
- Inspect a dense multi-agent session and a parent-only session at narrow and wide widths in the Electron app; expect readable states, collision-free labels, correctly clamped hover/focus details, and unchanged click-through.

## Suggested Review Order

**Surface composition**

- Start with the compact timeline, shared interaction state, and unchanged navigation boundary.
  [`SwimlaneSurface.tsx:566`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L566)

- Review stronger existing-token semantics for work, waits, idle, and child bars.
  [`SwimlaneSurface.tsx:112`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L112)

**Interaction and geometry**

- Confirm stable button/group semantics, fitted durations, and accessible tooltip triggers.
  [`SwimlaneSurface.tsx:209`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L209)

- Check close-boundary reservation and collision-aware HITL label placement.
  [`SwimlaneSurface.tsx:371`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L371)

- Inspect measured viewport clamping and exact metric-detail presentation.
  [`SwimlaneSurface.tsx:434`](../../src/renderer/components/chat/SwimlaneSurface.tsx#L434)

**Verification**

- Review rendered-width, targeted keyboard, tooltip lifecycle, hierarchy, and HITL regressions.
  [`SwimlaneSurface.test.tsx:304`](../../test/renderer/components/chat/SwimlaneSurface.test.tsx#L304)

- Confirm ChatHistory still preserves tab state and exact microscope navigation.
  [`ChatHistory.test.ts:410`](../../test/renderer/components/chat/ChatHistory.test.ts#L410)
