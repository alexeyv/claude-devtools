---
title: 'Add the swimlane toggle'
type: 'feature'
created: '2026-08-16'
status: 'done'
baseline_revision: 'e001cb6d5f15ce34d7cd31f1359eb41c410e3bbb'
baseline_commit: 'e001cb6d5f15ce34d7cd31f1359eb41c410e3bbb'
review_loop_iteration: 1
followup_review_recommended: true
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** A loaded session has a serialized swimlane model but no session-view control for switching away from the existing turn list. The control must remain discoverable when Context has no content and must not depend on subagents.

**Approach:** Add an off-by-default, per-tab swimlane visibility flag following `showContextPanel`, render a Swimlane button beside Context in ChatHistory's always-present sticky control row, and replace only the turn-list surface while the flag is on. This story establishes an empty swimlane surface; story 4 draws the model.

## Boundaries & Constraints

**Always:** Keep visibility isolated by tab and default it to false. Label the control `Swimlane`; give it the same dimensions, typography, interaction states, and `--context-btn-*` tokens as Context. Render the sticky row for every loaded non-empty conversation even when there are no context injections or child processes. Preserve the mounted session data and existing list state so toggling off restores the same turn list.

**Block If:** Block if replacing the list requires changing the `SessionDetail.swimlane` contract or moving session-view state outside `tabUISlice`; those belong to another story or require an architecture decision.

**Never:** Do not gate the button on `hasSubagents`, resolved child rows, or context injections. Do not place it in `SearchBar`, Settings, a modal, an overlay, or a stacked pane. Do not draw lanes, bars, marks, metrics, or click-through behavior in this story. Do not restyle ChatHistory, Context, or the existing turn list, and do not persist the toggle outside the tab lifecycle.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Default loaded tab | A loaded conversation with no context injections and no child rows | Sticky row shows inactive Swimlane; unchanged turn list remains visible | Missing optional context/child data does not hide or disable the control |
| Toggle on/off | User clicks Swimlane, then clicks it again | First click replaces the list with the empty swimlane surface and activates the button; second restores the same list | No session reload or list-state reset |
| Per-tab isolation | Two tabs show the same or different sessions | Enabling one tab does not change the other; new tabs start off | Missing tab state reads false and setters lazily create it |
| Context coexistence | Context injections are present or absent | Context appears conditionally in the same always-rendered row; Swimlane always appears | Context behavior remains unchanged |

</intent-contract>

## Code Map

- `src/renderer/store/slices/tabUISlice.ts:27-58,65-114,273-288` -- authoritative per-tab UI state/default/action pattern; add `showSwimlane`, setter, and getter beside Context without using legacy tab metadata.
- `src/renderer/hooks/useTabUI.ts:33-51,76-101,179-188,218-250` -- reactive tab-state facade consumed by ChatHistory; expose the boolean and tab-bound setter following Context.
- `src/renderer/components/chat/ChatHistory.tsx:39-105,227-391,406-677,741-888` -- loaded-session chrome, navigation/search effects, scroll ownership, and list surface; make the sticky row unconditional, add the sibling button, keep the real turn-list subtree mounted and inert while covered by the swimlane, preserve its scroll position independently, and leave or restore the swimlane before any existing list-target navigation runs.
- `src/renderer/components/chat/SwimlaneSurface.tsx` -- new intentionally empty surface boundary in the existing content column for story 4 to populate.
- `src/renderer/index.css:185-188,375-378` -- read-only evidence for shared `--context-btn-*` tokens; add no visual variables.
- `src/renderer/components/layout/MiddlePanel.tsx` -- read-only evidence that SearchBar is a separate Cmd+F surface and is not a toggle host.
- `test/renderer/store/tabUISlice.test.ts:33-48,224-246,273-374` -- extend default, lazy-init, lifecycle, and cross-tab isolation coverage for swimlane visibility.
- `test/renderer/components/chat/ChatHistory.test.ts` -- focused renderer regression using real tab context/store wiring for the always-visible button, active toggle, empty surface replacement, stateful list/scroll restoration, two-tab isolation, list-target navigation, and unchanged conditional Context control.

## Tasks & Acceptance

**Execution:**
- [x] `src/renderer/store/slices/tabUISlice.ts`, `src/renderer/hooks/useTabUI.ts` -- add reactive per-tab swimlane visibility with false defaults, lazy setters, and tab cleanup inherited from the existing map.
- [x] `src/renderer/components/chat/ChatHistory.tsx`, `src/renderer/components/chat/SwimlaneSurface.tsx` -- keep the sticky control row mounted, add token-matched Swimlane beside conditional Context, keep the actual list subtree mounted but hidden/inert on a separately scrollable surface, and exit swimlane before existing Context, deep-link, or search navigation targets the list.
- [x] `test/renderer/store/tabUISlice.test.ts`, `test/renderer/components/chat/ChatHistory.test.ts` -- cover every matrix row through the real per-tab hook path, including no context/children, two-tab isolation, stateful descendant and scroll preservation, virtualized restoration, list-target navigation, off-by-default behavior, and Context coexistence.

**Acceptance Criteria:**
- Given any loaded non-empty session, including one with no subagents and no context injections, when ChatHistory renders, then its sticky top-right row contains an inactive `Swimlane` button using the Context button language.
- Given a tab's Swimlane button is clicked, when the tab rerenders, then the existing turn list is replaced by the swimlane surface and the button is active; when clicked again, the unchanged turn list returns.
- Given a turn has local interaction state or a saved scroll position, when Swimlane is toggled on and off, then that same mounted turn subtree and its reading position are preserved.
- Given two open tabs, when Swimlane is enabled in only one, then the other remains on its turn list and a newly initialized tab remains off.
- Given context injections exist, when the row renders and either control is used, then Context retains its existing visibility behavior and both controls remain in the same sticky row.
- Given Context, a deep link, or search requests a turn-list target while Swimlane is active, when navigation begins, then Swimlane closes before the existing target navigation and highlight behavior runs.

## Spec Change Log

- 2026-08-16: Review found that conditionally choosing between the list and swimlane unmounted stateful turns, collapsed the shared scroll container, and allowed existing navigation/search to target a hidden list. Amended the Code Map, execution task, acceptance criteria, tests, and Design Notes to require a continuously mounted inert list surface with independent scroll preservation, navigation-triggered swimlane exit, real tab/store integration coverage, a stateful descendant, and a virtualized/scrolled case. This avoids semantic-only reconstruction that loses UI state or swallows navigation. KEEP: the accepted `showSwimlane` tabUISlice/hook pattern, false default, lazy tab initialization/cleanup, unconditional loaded-session control row, conditional Context button, shared `--context-btn-*` styling, lack of `hasSubagents` gating, empty story-3 surface, and basic store isolation coverage.

## Review Triage Log

### 2026-08-16 — Review pass
- intent_gap: 0
- bad_spec: 7: (high 0, medium 7, low 0)
- patch: 3: (high 0, medium 0, low 3)
- defer: 0
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[bad_spec]` Required the real turn-list subtree and local interaction state to remain mounted across the toggle instead of accepting a stateless reconstruction.
  - `[medium]` `[bad_spec]` Required independent preservation of the list's scroll position so the empty surface cannot clamp or overwrite it.
  - `[medium]` `[bad_spec]` Required Context, deep-link, and search navigation to leave swimlane before targeting the list.
  - `[medium]` `[bad_spec]` Required swimlane mode not to clear rendered search matches or consume hidden navigation targets.
  - `[medium]` `[bad_spec]` Required verification through the real TabUIProvider/useTabUI/store path rather than a local-state hook mock.
  - `[medium]` `[bad_spec]` Required a stateful real turn descendant to prove interaction state survives.
  - `[medium]` `[bad_spec]` Required a scrolled virtualized case to prove long-list restoration.

### 2026-08-16 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 4, low 5)
- defer: 0
- reject: 12: (high 0, medium 0, low 12)
- addressed_findings:
  - `[medium]` `[patch]` Reapplied native `inert` and `aria-hidden` through the scroll-container ref callback so a remounted covered list remains inaccessible and both attributes clear on return.
  - `[medium]` `[patch]` Tracked handled search-navigation identity so an old global selection cannot close Swimlane or race Context navigation, while a new selection still reveals and navigates the list.
  - `[medium]` `[patch]` Suppressed refresh-scroll and hidden-list auto-follow effects, then restored the exact preserved list position after a manual toggle-off.
  - `[medium]` `[patch]` Preserved per-tab behavior across activation by waiting for the active tab's search matches before handling a new search target.
  - `[low]` `[patch]` Reserved the sticky control-row height so the first turn cannot be obscured.
  - `[low]` `[patch]` Strengthened Context, pending deep-link, and search tests to prove target scrolling/highlighting or request consumption after reveal.
  - `[low]` `[patch]` Strengthened the virtualized test to prove the same connected scroll surface and reading position survive asynchronous work.
  - `[low]` `[patch]` Covered covered-list refresh/conversation updates plus accessibility-attribute removal on return.
  - `[low]` `[patch]` Verified Context and Swimlane share sizing, typography, and idle/hover/active `--context-btn-*` language.

## Design Notes

Keep the control row outside both surfaces. The turn-list React subtree must stay mounted when Swimlane is active; hide it from view and interaction without using conditional unmounting, and give the list and swimlane independent scroll ownership so the empty surface cannot clamp or persist over the list position. Suspend list-only auto-follow/search-DOM synchronization while covered. Any Context, pending deep-link, or active search navigation that needs list refs first turns Swimlane off, waits for the visible list surface, and then reuses the existing navigation path. Do not transform, clear, or refetch conversation data. The placeholder component remains deliberately structural so story 4 can consume `sessionDetail.swimlane` without reopening chrome or state decisions.

## Verification

**Commands:**
- `pnpm vitest run test/renderer/store/tabUISlice.test.ts test/renderer/components/chat/ChatHistory.test.ts` -- expected: toggle state and session-view chrome regressions pass.
- `pnpm typecheck` -- expected: the store, hook, and component contracts compile.
- `pnpm lint` -- expected: no new lint, React hook, accessibility, or Electron-boundary errors.
- `pnpm test` -- expected: the full Vitest suite passes without changing the existing turn-list behavior.

## Auto Run Result

Status: done

Summary: Added an off-by-default, per-tab Swimlane toggle to ChatHistory's always-present loaded-session control row. The toggle uses Context's button language, is independent of Context data and subagents, covers the still-mounted/inert turn list with an intentionally empty story-3 surface, preserves local turn state and scroll position, and reveals the list before existing Context, deep-link, or new-search navigation continues.

Files changed:
- `src/renderer/store/slices/tabUISlice.ts` -- adds false-defaulted per-tab swimlane visibility with lazy setter/getter and existing tab cleanup.
- `src/renderer/hooks/useTabUI.ts` -- exposes reactive swimlane visibility and a tab-bound setter.
- `src/renderer/components/chat/ChatHistory.tsx` -- adds the sticky-row control, mounted-list surface switching, scroll/accessibility preservation, and navigation/search coordination.
- `src/renderer/components/chat/SwimlaneSurface.tsx` -- defines the intentionally empty surface boundary for story 4.
- `test/renderer/store/tabUISlice.test.ts` -- covers defaults, lazy initialization, cleanup, lifecycle, and tab isolation.
- `test/renderer/components/chat/ChatHistory.test.ts` -- covers the real store/provider path, stateful and virtualized restoration, Context coexistence, navigation completion, search identity, refresh/update stability, accessibility, and visual-token parity.
- `_bmad-output/specs/spec-session-swimlane/stories/3-add-the-swimlane-toggle.md` -- records the implementation contract, review repair, triage, verification, and terminal result.

Review findings breakdown: The first pass repaired 7 medium-severity bad-spec findings and re-derived the implementation. The final pass applied 9 patches (high 0, medium 4, low 5), deferred 0 findings, and rejected 12 duplicate, ambiguous-reading, pre-existing, or non-actionable findings. No deferred findings remain.

Follow-up review recommendation: true. Final-pass patched findings: high 0, medium 4, low 5; score `3 × 4 + 1 × 5 = 17`.

Verification performed:
- Focused Vitest suite: 2 files passed, 31 tests passed.
- Matrix audit: all four rows ran and passed, covering the default no-context/no-child session, on/off restoration, real per-tab isolation, and Context coexistence.
- TypeScript typecheck: passed.
- ESLint source check: passed with 0 errors and 5 pre-existing warnings outside the reviewed diff.
- Full Vitest suite: 59 files passed, 760 tests passed.
- Prettier check for all changed TypeScript/TSX files: passed.
- `git diff --check`: passed.
- Production Electron/Vite build: passed; Browserslist reported only its pre-existing stale-data advisory.
- `pnpm` was unavailable, so the equivalent repository binaries from `node_modules/.bin` were used.

Residual risks: The actual lane drawing remains intentionally empty for story 4. No story-local implementation risk or deferred review finding remains.
