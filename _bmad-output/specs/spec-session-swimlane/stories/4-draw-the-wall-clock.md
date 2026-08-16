---
title: 'Draw the wall-clock'
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: '99c880b456480226405979d591b196b13d12d104'
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The Swimlane toggle currently reveals an empty surface, so the parent/child timing projection cannot be read or used to profile wall time and token economy.

**Approach:** Render the existing `SessionDetail.swimlane` projection as one compact, horizontally scrollable clock with a parent lane, nested child rows, inferred HITL ticks, and always-visible duration/token summaries. Use only the established surface, card, border, text, and warning tokens.

## Boundaries & Constraints

**Always:** Use the model's common axis for every segment, activation, and mark. Render parent work as solid, child-wait as a hatched empty track, HITL-wait with warning tokens, idle as unfilled track, and one solid child bar per activation with continuation gaps empty. Show `formatDuration` plus uncached input, cache read, cache write, and output on every work/activation bar; when a bar is short, keep the same line visible beside it. Render both boundaries of paired HITL evidence as warning-colored ticks labeled by inference (`ask` for explicit-ask marks, `resume` for inferred-resume marks). Truncate child labels after 60 characters and indent nested rows by model depth. A no-child session still renders the parent lane, axis, and any HITL marks.

**Block If:** The renderer does not receive a complete `SessionDetail.swimlane`, or satisfying the visual contract would require changing the lane-model semantics.

**Never:** Reparse messages in the renderer; derive new interval classes or token totals; use `mainSessionImpact`; merge continuation activations; make metrics hover-only; add CSS variables, a design system, zoom/pan, theme work, click-through, navigation behavior, or a ChatHistory restyle.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mixed orchestration | Parent work, child-wait, HITL-wait, idle, overlapping/nested children, paired marks | All elements share one axis; silent classes remain visually distinct from work; overlap and nesting are apparent | Ignore no model entries; preserve supplied ordering and bounds |
| Continuation | One child row with separated activations | One bar per activation with empty track in each gap | Never span first start to last end |
| Narrow/instant interval | Metrics text does not fit, or axis/segment duration is zero | A visible minimum marker/bar and the complete metrics line remain on the row | Clamp positions and widths without changing displayed duration |
| No children | Parent segments with zero child rows and optional marks | Parent-only clock renders without an empty-state illustration | Empty/zero-length axes remain stable and readable |

</intent-contract>

## Code Map

- `src/renderer/components/chat/SwimlaneSurface.tsx:1-14` -- replace the story-3 placeholder with the compact clock; normalize Date/string timestamps for placement, reuse renderer formatters, and expose semantic labels/test ids for rows, intervals, activations, and marks.
- `src/renderer/components/chat/ChatHistory.tsx:79-105,881-1012` -- already selects the tab-local slim `sessionDetail` and owns the replacement surface; pass `sessionDetail?.swimlane` into the surface without changing the mounted/inert turn-list or sticky controls.
- `src/main/types/chunks.ts:73-130,449-466` -- read-only renderer contract for parent segment classes, mark source/type, flat child hierarchy, per-activation metrics, and `SessionDetail.swimlane`.
- `src/renderer/utils/formatters.ts:6-23` -- reuse `formatDuration` and exported `formatTokensCompact`; do not add a competing formatter.
- `src/renderer/index.css:1-203,320-371` -- read-only theme evidence for the required surface/text/border, warning, and card tokens; add no variables or theme-specific rules.
- `test/renderer/components/chat/SwimlaneSurface.test.tsx` -- new focused DOM/style/accessibility coverage for the visual-class matrix, common-axis placement, mark labeling, metrics, continuation gaps, nesting, narrow bars, and parent-only output.
- `test/renderer/components/chat/ChatHistory.test.ts:230-541` -- extend the real tab/store integration fixture to prove the selected session model reaches the surface while prior toggle/list-preservation behavior remains intact.

## Tasks & Acceptance

**Execution:**
- [x] `src/renderer/components/chat/SwimlaneSurface.tsx` -- render the axis, parent track, nested child tracks/activations, HITL ticks, and compact metrics from `SwimlaneModel`, using existing tokens and a bounded minimum clock width with internal horizontal overflow.
- [x] `src/renderer/components/chat/ChatHistory.tsx` -- supply the selected tab's projected model to the visible swimlane surface without altering surrounding chrome, list state, or navigation.
- [x] `test/renderer/components/chat/SwimlaneSurface.test.tsx`, `test/renderer/components/chat/ChatHistory.test.ts` -- cover every matrix row and the real tab-local data handoff, including parent-only and overlapping HITL/child states.

**Acceptance Criteria:**
- Given a projected session containing every parent interval class and overlapping nested children, when Swimlane is enabled, then one shared wall-clock axis renders solid work, non-work silence in the three required distinct treatments, and one activation bar per child activation at the supplied times.
- Given any work or child activation bar, when the surface renders at a width too narrow for its content, then wall duration and all four formatted token values remain visible on that row without hover.
- Given explicit-ask or inferred-resume mark pairs, when the surface renders, then both supplied boundaries are warning-colored ticks labeled `ask` or `resume` from their source and remain aligned to the common axis.
- Given a session with no child rows, when Swimlane is enabled, then the parent lane, axis, and supplied HITL marks render with no illustration or call to action.
- Given the selected tab has a swimlane projection, when ChatHistory toggles the replacement surface on and off, then the projection is drawn only while on and the unchanged turn-list subtree retains the story-3 behavior.

## Spec Change Log

## Review Triage Log

### 2026-08-16 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 3, low 3)
- defer: 0
- reject: 13: (high 0, medium 7, low 6)
- addressed_findings:
  - `[medium]` `[patch]` Prevented a requested-on swimlane without a projection from hiding and inerting the turn list behind a blank replacement.
  - `[medium]` `[patch]` Stopped an existing tab with null detail from borrowing another tab's global swimlane projection.
  - `[medium]` `[patch]` Reused a logical work range's existing metrics on every visible split segment so no work bar omits its required summary.
  - `[low]` `[patch]` Matched the 60-code-point child-label truncation contract without splitting surrogate pairs and retained the full accessible activation label.
  - `[low]` `[patch]` Added regression coverage for the horizontal auto-overflow and minimum clock-canvas width contract.
  - `[low]` `[patch]` Added regression coverage that short/instant metrics remain unwrapped and are not clipped by their interval container.

## Design Notes

Use a fixed label column plus a position-relative clock canvas shared by every row. Percentages come only from `(timestamp - axisStart) / axisDuration`; a visual minimum width may keep zero/short bars perceivable but must not alter ordering, gaps, or metric values. Explicit ask start/answer ticks both use the contract's `ask` label; inferred resume start/end ticks both use `resume`, preserving paired evidence without introducing unsupported certainty labels.

## Verification

**Commands:**
- `npx vitest run test/renderer/components/chat/SwimlaneSurface.test.tsx test/renderer/components/chat/ChatHistory.test.ts` -- expected: visual matrix and real store handoff pass.
- `npm run typecheck` -- expected: renderer/model boundary typechecks.
- `npm run lint` -- expected: no new lint errors.
- `npm test` -- expected: full Vitest suite passes.
- `npm run build` -- expected: production Electron/Vite build succeeds.
- `git diff --check` -- expected: no whitespace errors.

## Auto Run Result

Status: done

Summary: Replaced the story-3 placeholder with a compact wall-clock renderer driven solely by `SessionDetail.swimlane`. The view shares one axis across parent interval classes, nested child rows and continuation activations, draws paired inferred HITL ticks, preserves silent gaps, and keeps duration plus the four token values visible. ChatHistory now passes only the selected tab's complete projection and leaves the turn list usable when no projection is available.

Files changed:
- `../../../../src/renderer/components/chat/SwimlaneSurface.tsx` -- renders the axis, class-specific parent segments, child activation rows, marks, labels, and formatted metrics with existing visual tokens.
- `../../../../src/renderer/components/chat/ChatHistory.tsx` -- supplies the selected tab projection and guards active replacement behavior on model availability.
- `../../../../test/renderer/components/chat/SwimlaneSurface.test.tsx` -- covers interval treatments, common-axis placement, continuations, nesting, paired marks, split metrics, narrow/instant bars, horizontal overflow, Unicode labels, and parent-only sessions.
- `../../../../test/renderer/components/chat/ChatHistory.test.ts` -- covers tab-local projection handoff, missing-model fallback, cross-tab isolation, and existing toggle/list behavior.
- `../../../../vitest.config.ts` -- includes `.test.tsx` files in Vitest discovery.
- `4-draw-the-wall-clock.md` -- records the implementation contract, review triage, verification, and terminal outcome.

Review findings breakdown: 6 patches applied (high 0, medium 3, low 3), 0 findings deferred, and 13 findings rejected as duplicate, invalid-model, speculative layout/accessibility expansion, or expected pre-finalization workflow state.

Follow-up review recommendation: true. Patched findings: high 0, medium 3, low 3; score `3 × 3 + 1 × 3 = 12`.

Verification performed:
- Focused Vitest renderer/integration suite: 2 files passed, 15 tests passed.
- Matrix audit: all four rows ran and passed, covering mixed orchestration, continuation gaps, narrow/instant intervals, and no-child output.
- TypeScript typecheck: passed.
- ESLint: passed with 0 errors and 5 pre-existing warnings outside the reviewed diff.
- Full Vitest suite: 60 files passed, 767 tests passed.
- Production Electron/Vite build: passed; Browserslist reported only its pre-existing stale-data advisory.
- `git diff --check`: passed.

Residual risks: happy-dom protects the emitted placement, overflow, token, and accessibility contracts but does not provide pixel-level Chromium layout or theme-contrast validation. No story-local implementation work or deferred review finding remains.
