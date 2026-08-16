---
title: 'Treat Agent as a spawn'
type: 'bugfix'
created: '2026-08-16'
status: 'done'
baseline_revision: '6c3d6c9d8a88f4b4f187c03fa8e541cc15b1caed'
baseline_commit: '6c3d6c9d8a88f4b4f187c03fa8e541cc15b1caed'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred:
  - summary: >-
      Conversation grouping ignores non-meta user messages that contain tool results.
    evidence: |-
      collectAIResponses admits user tool-result messages only when isMeta is true, while other parser/display paths explicitly support tool-result messages whose isMeta field is absent or false.
    location: >-
      src/main/services/analysis/ConversationGroupBuilder.ts:95
    severity: medium
  - summary: >-
      Conversation grouping requires sourceToolUseID instead of falling back to extracted tool-result IDs.
    evidence: |-
      separateTaskExecutions skips a result message without sourceToolUseID even when ParsedMessage.toolResults contains the matching toolUseId.
    location: >-
      src/main/services/analysis/ConversationGroupBuilder.ts:135
    severity: medium
  - summary: >-
      Conversation grouping handles only one source ID and the first ordinary result in a result message.
    evidence: |-
      The result loop keys the whole message through one sourceToolUseID and reads toolResults[0], so a batched message cannot represent every contained result.
    location: >-
      src/main/services/analysis/ConversationGroupBuilder.ts:135
    severity: medium
  - summary: >-
      Conversation-group process ownership is still assigned solely by timestamps.
    evidence: |-
      linkSubagentsToGroup checks only whether Process.startTime falls inside the group window, rather than preferring the process parentTaskId and the group's spawn tool IDs.
    location: >-
      src/main/services/analysis/ConversationGroupBuilder.ts:171
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Claude Code now emits `Agent` tool calls for child work, but the session pipeline only classifies and presents `Task` as a spawn. Linked Agent children can therefore remain raw tools, be grouped as regular executions, and collapse parallel children in the existing microscope.

**Approach:** Centralize the spawn-name rule for both `Task` and `Agent`, use it to populate the existing `ToolCall.isTask` flag, and make every remaining spawn-sensitive gate follow that rule or the flag already available at the call site.

## Boundaries & Constraints

**Always:** Preserve the existing `isTask` data contract while making it true for both names. Prefer `parentTaskId` / tool-use-id joins and retain timing only as the existing fallback. Keep each linked parallel Agent child as its own process and existing `SubagentItem`.

**Block If:** Block if an affected gate cannot see either the original tool name or `ToolCall.isTask` without changing serialized domain types; that would require a broader contract decision.

**Never:** Do not add `isTask` to `SemanticStep` or `LinkedToolItem` unless the block condition is reached. Do not restyle `SubagentItem`, change its renderer, alter the child join order, or edit `ChunkBuilder` beyond behavior inherited through the shared classification path. Do not broaden this story into the swimlane UI or lane model.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Current spawn | A parsed `Agent` tool use with spawn metadata | `ToolCall.isTask` is true and task metadata is retained | No error expected |
| Legacy spawn | A parsed `Task` tool use | Existing spawn classification and rendering remain unchanged | No error expected |
| Ordinary tool | Any other tool name, including task-coordination tools | `isTask` remains false and the tool remains a regular execution | No error expected |
| Linked Agent child | An `Agent` call and a `Process.parentTaskId` matching its tool-use id | The process joins by id, the raw Agent tool is suppressed, and the existing subagent item remains | Do not fall back to timing when a nonmatching parent id exists |
| Parallel children | Three Agent calls with three matching processes | Three distinct linked subagents survive grouping and microscope display | Do not merge or replace children |

</intent-contract>

## Code Map

- `src/shared/utils/toolNames.ts` -- new renderer/main-safe predicate for the two spawn tool names; avoids duplicating name checks across Electron boundaries.
- `src/main/utils/toolExtraction.ts:18-33` -- authoritative construction of `ToolCall.isTask` and extraction of spawn description/type metadata; start the behavior change here.
- `src/main/services/discovery/SubagentResolver.ts:207-215` -- already filters through `ToolCall.isTask`; preserve as evidence that resolver behavior updates transitively.
- `src/main/services/analysis/ProcessLinker.ts:22-56` -- already joins spawn ids through `isTask`, then uses timing only for processes without `parentTaskId`; preserve this precedence.
- `src/main/services/analysis/ConversationGroupBuilder.ts:108-155` -- replace the remaining `name === 'Task'` execution gate with the available `ToolCall.isTask` flag.
- `src/renderer/utils/displayItemBuilder.ts:94-175,287-560` -- both semantic-step and raw-message paths currently suppress only named Task tools; use the shared name predicate without extending `SemanticStep` or `LinkedToolItem`.
- `src/renderer/utils/contextTracker.ts:193-220` -- make the context-breakdown subagent label follow the same spawn predicate.
- `test/main/utils/toolExtraction.test.ts` -- focused classification coverage for Agent, Task, and an ordinary tool.
- `test/main/services/analysis/ChunkBuilder.test.ts:326-367` -- extend the existing primary-id process-linking coverage with Agent classification behavior while leaving `ChunkBuilder` production code unchanged.
- `test/main/services/analysis/ConversationGroupBuilder.test.ts` -- grouping regression proving a linked Agent becomes a task execution, not a regular tool execution.
- `test/renderer/utils/displayItemBuilder.test.ts` -- renderer regression proving a linked Agent produces one existing subagent item and no duplicate raw tool; include multiple matching Agent children.
- `test/renderer/utils/contextTracker.test.ts` -- context breakdown regression proving Agent uses the subagent display label.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/utils/toolNames.ts`, `src/main/utils/toolExtraction.ts` -- introduce and consume one spawn-name predicate for `Task` and `Agent`, retaining the current metadata fields and ordinary-tool behavior.
- [x] `src/main/services/analysis/ConversationGroupBuilder.ts`, `src/renderer/utils/displayItemBuilder.ts`, `src/renderer/utils/contextTracker.ts` -- replace every remaining linked-process or spawn-label Task-name gate with `ToolCall.isTask` where visible or the shared predicate where only a name is present.
- [x] `test/main/utils/toolExtraction.test.ts`, `test/main/services/analysis/ChunkBuilder.test.ts`, `test/main/services/analysis/ConversationGroupBuilder.test.ts`, `test/renderer/utils/displayItemBuilder.test.ts`, `test/renderer/utils/contextTracker.test.ts` -- cover classification, id-first joining/grouping, duplicate suppression, parallel-child preservation, legacy Task behavior, and the context label.

**Acceptance Criteria:**
- Given equivalent `Agent` and `Task` tool-use blocks, when they are parsed, then both have `isTask: true`, expose their spawn metadata, and non-spawn tools remain false.
- Given three Agent calls and three processes with matching `parentTaskId` values, when chunks, conversation groups, and display items are built, then all three processes remain distinct subagents, each joins by its tool id, and no duplicate raw Agent tool is displayed.
- Given a linked Agent tool contributes context tokens, when context tracking builds its tool breakdown, then its label follows the existing subagent label convention used for Task.
- Given existing Task and ordinary-tool fixtures, when the targeted suite runs, then their grouping, display, and fallback behavior are unchanged.

## Spec Change Log

## Review Triage Log

### 2026-08-16 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 0, low 2)
- defer: 4: (high 0, medium 4, low 0)
- reject: 14: (high 0, medium 0, low 14)
- addressed_findings:
  - `[low]` `[patch]` Added legacy `Task` coverage at the changed `ConversationGroupBuilder` `isTask` gate, preserving the Agent and ordinary-tool assertions.
  - `[low]` `[patch]` Added legacy `Task` coverage at the semantic-step `buildDisplayItems` suppression gate while retaining the three-child Agent regression.

## Design Notes

The shared helper accepts the tool name and answers whether it represents a child spawn. Main parsing records that answer in `ToolCall.isTask`; later main-process code should trust the recorded flag. Renderer paths reconstruct display items from stripped shapes that still expose a name, so they call the shared helper directly rather than expanding IPC-facing types.

## Verification

**Commands:**
- `pnpm vitest run test/main/utils/toolExtraction.test.ts test/main/services/analysis/ChunkBuilder.test.ts test/main/services/analysis/ConversationGroupBuilder.test.ts test/renderer/utils/displayItemBuilder.test.ts test/renderer/utils/contextTracker.test.ts` -- expected: all spawn classification and display regressions pass.
- `pnpm typecheck` -- expected: no TypeScript errors.
- `pnpm lint` -- expected: no lint or Electron-boundary errors.
- `pnpm test` -- expected: full Vitest suite passes.

## Auto Run Result

Status: done

Summary: Added a shared spawn-name predicate so both `Agent` and legacy `Task` populate `ToolCall.isTask`; all remaining spawn-sensitive grouping, display suppression, and context-label gates now follow the flag or the shared predicate. Linked parallel Agent children remain distinct existing subagent items and raw duplicate spawn tools are hidden.

Files changed:
- `src/shared/utils/toolNames.ts` -- defines the main/renderer-safe `Task` and `Agent` spawn predicate.
- `src/main/utils/toolExtraction.ts` -- classifies both spawn names through the existing `isTask` contract and retains spawn metadata.
- `src/main/services/analysis/ConversationGroupBuilder.ts` -- groups linked spawn calls through `ToolCall.isTask`.
- `src/renderer/utils/displayItemBuilder.ts` -- suppresses linked spawn duplicates in both semantic-step and raw-message paths.
- `src/renderer/utils/contextTracker.ts` -- labels both spawn tools as subagent context.
- `test/main/utils/toolExtraction.test.ts` -- covers Agent, Task, and ordinary-tool classification.
- `test/main/services/analysis/ChunkBuilder.test.ts` -- covers three id-linked Agent processes and excludes a mismatched parent id.
- `test/main/services/analysis/ConversationGroupBuilder.test.ts` -- covers three linked Agent and Task executions alongside an ordinary tool.
- `test/renderer/utils/displayItemBuilder.test.ts` -- covers linked Task/Agent suppression and distinct parallel subagent items.
- `test/renderer/utils/contextTracker.test.ts` -- covers Task and Agent subagent labels.

Review findings breakdown: 2 low-severity patches applied, 4 medium-severity pre-existing items deferred, and 14 review items rejected as duplicates, noise, or outside this story's explicit intent.

Follow-up review recommendation: false. Patched findings: high 0, medium 0, low 2; score `3 × 0 + 1 × 2 = 2`.

Verification performed:
- Targeted Vitest suite: 5 files passed, 32 tests passed.
- Matrix audit: all five rows were exercised by passing classification, grouping, process-linking, display, and legacy-compatibility tests.
- TypeScript typecheck: passed.
- ESLint: passed with 0 errors and 5 pre-existing warnings outside the reviewed diff.
- Full Vitest suite: 57 files passed, 734 tests passed.
- Production Electron/Vite build: passed; Browserslist reported only its pre-existing stale-data advisory.

Residual risks: the four pre-existing ConversationGroupBuilder limitations recorded in `deferred` remain; they concern non-meta, source-id-free, batched result messages, and timestamp-only group ownership. No story-local work remains.
