---
title: 'Click through to the microscope'
type: 'feature'
created: '2026-08-16'
status: 'done'
baseline_revision: '98e9d2041a7c3dce515670707d0178763d185bf7'
baseline_commit: '98e9d2041a7c3dce515670707d0178763d185bf7'
review_loop_iteration: 1
followup_review_recommended: true
context: []
warnings:
  - oversized
deferred:
  - summary: >-
      A navigation request arriving within 500 ms of a failed request can remain pending without a scheduled retry.
    evidence: |-
      useTabNavigationController returns early while lastFailureAtRef is inside the debounce window, but no timer or dependency change guarantees that the same pending request is reconsidered after the window expires.
    location: >-
      src/renderer/hooks/useTabNavigationController.ts:548
    severity: medium
  - summary: >-
      The shared navigation-controller catch path does not clear highlight fields after an unexpected exception.
    evidence: |-
      The catch branch resets phase and request bookkeeping, but an error or search navigation that set highlight state before throwing can leave group/tool/color state visible without a highlight timer.
    location: >-
      src/renderer/hooks/useTabNavigationController.ts:517
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Swimlane bars currently display timing and tokens but cannot reach the existing turn/subagent microscope, so the overview is disconnected from the detail surface it summarizes.

**Approach:** Add serializable, identity-based microscope targets to navigable lane intervals and route bar clicks through the session view's existing reveal, expansion, virtualization, scroll, and highlight machinery.

## Boundaries & Constraints

**Always:** Dismiss Swimlane before navigating. Parent work targets its owning AI group. A child activation targets its existing root-level `SubagentItem` only when the lane projection can identify that card's owning AI group and spawn/process identities. For a child, expand the owning AI group, expand the outer subagent item, expand its trace, ensure the group is mounted, then scroll to the card. Preserve per-tab state and lane-model identity across IPC.

**Block If:** Block if an existing card cannot be targeted without inventing a second identity or microscope contract.

**Never:** Do not make silent parent intervals clickable, make nested rows without an existing card clickable, call `expandSubagentTraceForTab` alone, derive ownership by timestamp in the renderer, add an overlay or stacked pane, duplicate the microscope, or change lane classification/metrics/visual styling.

## I/O & Edge-Case Matrix

| Scenario                 | Input / State                                                                                         | Expected Output / Behavior                                                                                                                            | Error Handling                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Parent work              | Work segment with an owning chunk/group target, list covered and destination collapsed or virtualized | Swimlane closes, the group is mounted through `ensureGroupVisible` and the existing turn is centered/highlighted without changing its expansion state | A work segment without a target remains non-interactive                       |
| Root child               | Activation whose process has an existing `SubagentItem` in an owning AI group                         | Swimlane closes; group, outer item, and trace expand in order; the existing card is mounted and scrolled into view                                    | Missing group/card identity leaves the activation visible but non-interactive |
| Nested child             | Row nested under another child with no root-session card                                              | Timing and metrics remain visible                                                                                                                     | No click affordance and no fallback microscope                                |
| Parallel/resumed session | Parallel Agent children plus a parent checkpoint/resume gap                                           | Each targeted bar opens its own existing turn/card without changing the shared lane or HITL model                                                     | Repeated clicks create independent navigation requests                        |
| No children              | Parent-only model with work and silent intervals                                                      | Work remains navigable; silent intervals remain inert; no child controls appear                                                                       | No error or empty-state substitution                                          |

</intent-contract>

## Code Map

- `src/main/types/chunks.ts:73-130` -- extend parent segments and child activations with a small serializable turn/subagent target union; keep absent targets explicit for silent and nested-only destinations.
- `src/main/services/analysis/SwimlaneBuilder.ts:96-132,435-490,568-611` -- attach parent group targets from source AI chunk ids and child-card targets from distinct processes already linked to one owning AI chunk; retain clicked physical `processId` for continuations, deduplicate identical candidates, and do not suppress a real card merely because lane nesting assigned depth greater than zero.
- `src/renderer/components/chat/SwimlaneSurface.tsx:15-20,190-315` -- accept one target callback and render semantic button behavior only for bars carrying a target; leave silent and untargeted bars visually unchanged and inert.
- `src/renderer/components/chat/ChatHistory.tsx:47-105,218-365,900-1025` -- enqueue target navigation from the active tab, dismissing Swimlane first, and reuse the mounted-list/virtualizer refs already owned here.
- `src/renderer/hooks/useTabNavigationController.ts:50-275` -- extend the existing navigation controller with exact lane group/card targets: parent runs `ensureGroupVisible` then scrolls without expanding the AI group; child expands AI group, outer item, and trace before `ensureGroupVisible` and scroll. Clear prior target highlight state before each request and fail rather than report success when the projected DOM target never mounts.
- `src/renderer/hooks/useTabUI.ts`, `src/renderer/store/slices/tabUISlice.ts` -- reuse the existing idempotent AI-group, display-item, and trace expansion actions; add no parallel visibility or microscope state.
- `src/renderer/types/tabs.ts:12-70,190-240` -- represent swimlane as a navigation-request source and carry the exact projected target without weakening notification/search payloads.
- `src/renderer/components/chat/DisplayItemList.tsx`, `src/renderer/components/chat/AIChatGroup.tsx` -- provide/reuse a deterministic outer `SubagentItem` expansion id so controller-driven expansion addresses the same card the list renders.
- `test/main/services/analysis/SwimlaneBuilder.test.ts` -- prove parent and root-child targets, clicked continuation process identity, and absent nested/no-card targets.
- `test/renderer/components/chat/SwimlaneSurface.test.tsx`, `test/renderer/components/chat/ChatHistory.test.ts`, `test/renderer/hooks/useTabNavigationController.test.ts` -- cover click affordances and controller ordering, plus real `ChatHistory` integrations that click a rendered child card, exercise actual off-screen virtualizer mounting, and run parallel-Agent/checkpoint-resume and parent-only/no-child shapes; do not pre-seed the child-card ref in the integration proof.

## Tasks & Acceptance

**Execution:**

- [x] `src/main/types/chunks.ts`, `src/main/services/analysis/SwimlaneBuilder.ts` -- project exact turn/subagent targets onto navigable bars, deduplicate identical ownership candidates, preserve real nested-row cards, and leave silent or genuinely cardless destinations untargeted.
- [x] `src/renderer/types/tabs.ts`, `src/renderer/hooks/useTabNavigationController.ts`, `src/renderer/hooks/useTabUI.ts`, `src/renderer/store/slices/tabUISlice.ts`, `src/renderer/components/chat/DisplayItemList.tsx`, `src/renderer/components/chat/AIChatGroup.tsx` -- route lane targets through the existing navigation lifecycle and make child group, outer-card, and trace expansion explicit and idempotent while preserving parent expansion state.
- [x] `src/renderer/components/chat/SwimlaneSurface.tsx`, `src/renderer/components/chat/ChatHistory.tsx` -- add target-only bar activation and dismiss the replacement surface before navigation begins.
- [x] `test/main/services/analysis/SwimlaneBuilder.test.ts`, `test/renderer/components/chat/SwimlaneSurface.test.tsx`, `test/renderer/components/chat/ChatHistory.test.ts`, `test/renderer/hooks/useTabNavigationController.test.ts` -- exercise every matrix row, including a real rendered child card, an initially unmounted virtualized target, repeated requests, parallel Agent/checkpoint-resume navigation, and a clickable parent-only/no-child session.

**Acceptance Criteria:**

- Given a targeted parent or child bar while Swimlane is active, when it is clicked, then the lane closes before the unchanged turn-list microscope is mounted and scrolled to the projected target; parent expansion state is unchanged.
- Given a child card is collapsed inside a collapsed or virtualized AI group, when its activation is clicked, then the owning group, outer `SubagentItem`, and trace are expanded in that order and the existing card—not a duplicate surface—is centered.
- Given a silent parent interval or child activation without an existing root card, when the lane renders, then it exposes no click affordance or navigation request.
- Given parallel Agents with a checkpoint/resume and a separate no-child session, when target clicks are exercised, then target identity, HITL rendering, per-tab state, and the ordinary turn list remain intact.

## Spec Change Log

- 2026-08-16: Review found that the parent path incorrectly required AI-group expansion despite the caller's exact `ensureGroupVisible` then scroll sequence. Amended the parent matrix, navigation Code Map, task, acceptance criteria, and integration evidence so parent navigation preserves expansion state while child navigation retains group → outer item → trace → visibility → scroll ordering. Also made explicit that a lane-nested process remains clickable when it has a real root-session card and that identical ownership candidates are deduplicated. Required real child-card registration, off-screen virtualization, orchestration/resume, and no-child click integrations rather than seam-only mocks. KEEP: serializable exact targets, target-only button semantics, dismissal before per-tab nonce request, stable child-card identity/ref, inert silent/cardless bars, and no overlay/stacked/duplicate microscope.

## Review Triage Log

### 2026-08-16 — Review pass

- intent_gap: 0
- bad_spec: 1: (high 0, medium 1, low 0)
- patch: 10: (high 0, medium 7, low 3)
- defer: 2: (high 0, medium 2, low 0)
- reject: 4: (high 0, medium 1, low 3)
- addressed_findings:
  - `[medium]` `[bad_spec]` Removed parent AI-group expansion from the planned click-through sequence and required `ensureGroupVisible` followed by scroll while preserving the parent's prior expansion state; retained the distinct explicit child expansion sequence.

### 2026-08-16 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 3, low 3)
- defer: 1: (high 0, medium 1, low 0)
- reject: 13: (high 0, medium 5, low 8)
- addressed_findings:
  - `[medium]` `[patch]` Projected and navigated timing-linked rendered child cards that lack `parentTaskId` through the same exact group/process identity, without renderer timestamp inference.
  - `[medium]` `[patch]` Rejected child-card elements that detach during lookup or stabilization instead of scrolling stale geometry or reporting success.
  - `[medium]` `[patch]` Strengthened the integrated demo to independent parallel Agent destinations across a checkpoint/resume-shaped gap.
  - `[low]` `[patch]` Added builder coverage for positive-duration parent work so ranged bars retain the exact owning-turn target.
  - `[low]` `[patch]` Preserved exact ref registration and destination highlighting for shutdown-only team child cards, with real navigation coverage.
  - `[low]` `[patch]` Verified the configured blue destination highlight for both parent and child Swimlane navigation.

## Design Notes

The projection is authoritative for navigation eligibility: a parent target is its AI chunk/group id; a child target contains the owning root AI group, the clicked physical process/subagent id, and the spawn identity needed by the existing card ref. Renderer navigation may validate that target against the current conversation, but must not manufacture ownership from timestamps. Reusing the nonce-based tab navigation controller keeps repeated clicks, virtualization waits, scrolling, highlighting, and request consumption consistent with error navigation.

## Verification

**Commands:**

- `npx vitest run test/main/services/analysis/SwimlaneBuilder.test.ts test/renderer/components/chat/SwimlaneSurface.test.tsx test/renderer/components/chat/ChatHistory.test.ts test/renderer/hooks/useTabNavigationController.test.ts` -- expected: projection, interaction, expansion-order, virtualization, orchestration, and no-child regressions pass.
- `npm run typecheck` -- expected: main/IPC/renderer target contracts compile.
- `npm run lint` -- expected: no new lint, hook, accessibility, or Electron-boundary errors.
- `npm test` -- expected: full Vitest suite passes.
- `npm run build` -- expected: production Electron/Vite build succeeds.
- `git diff --check` -- expected: no whitespace errors.

## Auto Run Result

Status: done

Summary: Added exact, serializable turn and existing-card targets to the swimlane projection. Targeted bars now dismiss Swimlane and use the per-tab navigation controller: parent targets are mounted and centered without changing expansion, while child targets expand the owning AI group, outer `SubagentItem`, and trace before virtualization mounting and exact-card scrolling. Silent and genuinely cardless intervals remain inert; no overlay, stacked pane, or duplicate microscope was added.

Files changed:
- `src/main/types/chunks.ts` -- defines serializable turn/subagent navigation targets on parent work and child activations.
- `src/main/services/analysis/SwimlaneBuilder.ts` -- projects unambiguous owning-group/card targets, including continuations and timing-linked rendered cards.
- `src/renderer/types/tabs.ts` -- adds nonce-based Swimlane navigation requests and stable child-card identities.
- `src/renderer/hooks/useTabNavigationController.ts` -- executes exact parent/child sequences, validates current identities, mounts virtualized groups, and centers/highlights destinations.
- `src/renderer/components/chat/ChatHistory.tsx` -- dismisses Swimlane before enqueueing per-tab target navigation and owns exact child-card refs.
- `src/renderer/components/chat/SwimlaneSurface.tsx` -- gives button semantics only to bars carrying projected targets.
- `src/renderer/components/chat/ChatHistoryItem.tsx` -- forwards exact child-card ref registration and exposes stable group identity for destination verification.
- `src/renderer/components/chat/AIChatGroup.tsx` -- uses stable child display-item identities for explicit expansion.
- `src/renderer/components/chat/DisplayItemList.tsx` -- renders `SubagentItem` keys that match controller expansion identities.
- `src/renderer/components/chat/items/SubagentItem.tsx` -- registers exact normal and shutdown-only cards and applies destination highlighting consistently.
- `test/main/services/analysis/SwimlaneBuilder.test.ts` -- covers parent ranges, exact child ownership, continuations, timing-linked cards, ambiguity, and inert cardless rows.
- `test/renderer/components/chat/SwimlaneSurface.test.tsx` -- covers target-only button semantics and inert silent/nested intervals.
- `test/renderer/hooks/useTabNavigationController.test.ts` -- covers exact sequences, orphan identity, detach/missing-card failure, scrolling, highlighting, and repeated nonce requests.
- `test/renderer/components/chat/ChatHistory.test.ts` -- covers real child cards, off-screen virtualization, parallel Agent/checkpoint-resume shape, shutdown-only cards, and parent-only/no-child navigation.
- `_bmad-output/specs/spec-session-swimlane/stories/5-click-through-to-the-microscope.md` -- records planning, review repair, triage, verification, and terminal outcome.

Review findings breakdown: The first pass triggered one medium-severity bad-spec repair and full re-derivation. The final pass applied 6 patches (high 0, medium 3, low 3), deferred 1 pre-existing medium issue, and rejected 13 duplicate, speculative, pre-finalization, or non-actionable findings. Two pre-existing navigation-controller findings are recorded in `deferred` across the review passes.

Follow-up review recommendation: true. Final-pass patched findings: high 0, medium 3, low 3; score `3 × 3 + 1 × 3 = 12`.

Verification performed:
- Focused story suite: 4 files passed, 44 tests passed.
- Matrix audit: all five rows ran and passed, including targeted parent work, real root child cards, inert nested/cardless rows, independent parallel Agent destinations across resume, and a clickable parent-only/no-child session.
- Real virtualization integration: passed with an initially unmounted child owner row/card mounted by the actual ChatHistory virtualizer and centered through the production click path.
- TypeScript typecheck: passed.
- ESLint: passed with 0 errors and 5 pre-existing warnings outside the reviewed diff.
- Full Vitest suite: 61 files passed, 781 tests passed.
- Production Electron/Vite build: passed; Browserslist reported only its pre-existing stale-data advisory.
- `git diff --check`: passed.

Residual risks: The two pre-existing navigation-controller issues recorded in `deferred` remain. Happy DOM requires deterministic geometry for the virtualizer test, but the integration retains the real ChatHistory, TanStack virtualizer, card refs, expansion state, and scroll calculation. No story-local implementation work remains.
