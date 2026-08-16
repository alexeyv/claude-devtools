---
id: SPEC-session-swimlane
companions:
  - interval-classes.md
  - brownfield.md
  - swimlane-visual.md
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Session swimlane

## Why

A pain: Claude Code sessions that matter — especially BMAD skill runs — are orchestrations, and DevTools cannot show the orchestration. The parent loads a skill, asks, parks, then fans out Agents; children run in parallel for minutes while the parent is idle; HITL is a short gap, not the wall. The turn microscope already shows tool name, args, output, and tokens *inside* a turn. It hides interplay: subagents are drill-downs on an AI chunk, HITL is just another user message, overlap is invisible. The missing picture is the one you need to profile a skill run — uncached vs cache-read token economy, wall time, and whether a prompt actually caused the fan-out you wrote.

## Capabilities

- **CAP-1**
  - **intent:** User can switch a loaded session between the existing turn list and a wall-clock swimlane from the session-view chrome, without opening Settings.
  - **success:** A control labeled Swimlane sits in ChatHistory's sticky top-right row (same button language as Context). That row is always rendered so the control is visible even when Context is hidden. One click replaces the turn list with the swimlane. Toggle off restores the unchanged turn list. Visibility is per-tab and off by default. Visual tokens live in `swimlane-visual.md`.

- **CAP-2**
  - **intent:** User can see when the parent was producing versus silent on one wall clock spanning the parent and its resolved children.
  - **success:** Parent work intervals align with assistant and tool-use timestamps. Every silent stretch is drawn and never classified as work. Classification rules live in `interval-classes.md`.

- **CAP-3**
  - **intent:** User can see each spawned Agent/Task child on its own lane, overlapping on the same axis, with nested children as extra rows under their parent.
  - **success:** Parallel children are visibly concurrent. Nested children add rows, not a second page. Nesting is `parentTaskId` matching a spawn tool id in another process's messages; `parentUuid` continuation files are the same child (one row), not extra rows. A session with no children still works: one parent lane, plus HITL marks if any.

- **CAP-4**
  - **intent:** User can distinguish human (or scripted-resume) waits from parent work and from child-wait.
  - **success:** Ask and answer appear as marks; the gap between them is HITL-wait, not parent work, and is not omitted. Child-wait looks different from HITL-wait (hatch vs warning tint — `swimlane-visual.md`). Inference rules live in `interval-classes.md`. Marks are labeled; they do not claim certainty.

- **CAP-5**
  - **intent:** User can profile wall time and token economy from the lane without opening the JSONL.
  - **success:** Each bar shows wall duration plus uncached input, cache read, cache write, and output on one compact line (`swimlane-visual.md`). Child-bar tokens are that child's own assistant usage, never the parent's `mainSessionImpact`. Hover is not the only place those numbers exist.

- **CAP-6**
  - **intent:** User can jump from a swimlane bar into the existing turn or subagent microscope.
  - **success:** Click a parent interval or child bar turns the swimlane off, then calls existing navigation: parent → that turn; child → `expandSubagentTrace`. No second microscope. No overlay. No stacked pane above the list.

- **CAP-7**
  - **intent:** Spawn join treats Claude Code `Agent` tool calls as child spawns, not only `Task`, so parallel children do not collapse into one turn and remain reachable in the existing microscope.
  - **success:** Three parallel Agent children produce three lanes. `isTask` is true for `Agent` as well as `Task`. Every check that decides a linked `Process` is a subagent (`SubagentResolver`, `ProcessLinker`, `displayItemBuilder`, `ConversationGroupBuilder`) follows `isTask`, not `name === 'Task'`. Join prefers `parentTaskId` / spawn tool id. Timing fallback (child `startTime` inside the parent chunk) is last resort. `SubagentItem` appearance is unchanged.

## Constraints

- One Claude data root, one session tree. An orchestrator in `~/.claude` that launched `claude -p` into `/tmp/.../claude-home` is two roots; out of scope. The swimlane for a reviewer session is that session plus its `subagents/`.
- Add a projection `buildSwimlane(chunks, processes, messages)`, not a second session model. Consume `SessionParser`, `SubagentLocator` / `SubagentResolver`, `ProcessLinker`, and `Process` (`startTime`, `endTime`, `parentTaskId`, `metrics`). See `brownfield.md`.
- Do not edit `ChunkBuilder` except as required to classify `Agent` as a spawn. Do not restyle `ChatHistory`. Do not add a new parser or a third interpretation of unofficial jsonl; inherit the existing parser's drift handling.
- Child file paths go through the existing locator. Do not hardcode `projects/<id>/subagents/` vs `projects/<id>/<sessionId>/subagents/`.
- A silent stretch must never look like work. Wrong wait-class is acceptable if the gap is still drawn.
- Isolate the change: (1) a pure lane-model function testable without Electron; (2) a small view that reuses existing surface colors and type — no new design system, no new CSS variables (`swimlane-visual.md`); (3) one Swimlane button in ChatHistory's sticky top-right row, tab-local toggle like Context panel visibility, off by default, no Settings, no theme work; (4) click-through dismisses the swimlane and calls the navigation they already have.
- HITL is inferred, not a log type. Label the mark; do not pretend certainty.

## Non-goals

- Redesign of ChatHistory, token displays, the context panel, or the subagent modal.
- A new parser, or a third interpretation of unofficial jsonl records.
- Cross-home stitching of orchestrator sessions to isolated `claude -p` homes.
- Skill-run comparer, run-vs-run, or "this SKILL.md cost X."
- Live tail of the lane, live steering, or Cogpit.
- Custom themes, or any "improvement" to the existing turn UI.

## Success signal

Open a session that spawned parallel Agents and had a checkpoint/resume (the shape of bmad-code-review run 1). The button is visible at the top of the session view without hunting Settings. One click shows parent plus each child on one time axis; overlapping children are visibly concurrent. The HITL gap is a marked wait, not parent work, and not omitted. Child-wait (parent quiet, hunters running) looks different from HITL-wait. Bars carry wall time and the four token numbers. Click parent bar → that turn; click child bar → existing subagent detail. Toggle off → the normal turn list, unchanged. A session with no children still works: one parent lane, HITL marks if any.

## Assumptions

- Uncached input maps to existing `inputTokens`. Cache write maps to `cacheCreationTokens` / `cache_creation_input_tokens`. Cache read and output map to `cacheReadTokens` and `outputTokens`.
- Child-bar tokens may be taken from `Process.metrics` when that object is the sum of assistant `usage` in that child jsonl.
- Tab-local visibility follows the existing `showContextPanel` pattern in `tabUISlice`, not Settings.
