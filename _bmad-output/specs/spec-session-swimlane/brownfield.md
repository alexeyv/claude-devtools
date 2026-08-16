# Brownfield fit

Existing surfaces and types this change must consume. Do not invent a parallel session model.

## Consume, do not replace

- `SessionParser` — jsonl parse. Inherit its drift handling and `requestId` / `calculateMetrics` dedup. Do not add a third interpretation of unofficial records.
- `SubagentLocator` / `SubagentResolver` — child file discovery and spawn join. Locator already handles NEW `{projectId}/{sessionId}/subagents/agent-*.jsonl` and OLD `{projectId}/agent-*.jsonl`. Call it; do not hardcode either path. Do not gate the Swimlane toggle or child lanes on `hasSubagents` / initial `session.hasSubagents` — that helper only checks the NEW directory. `listSubagentFiles` / resolved `Process[]` is authoritative. Session-detail already overwrites `session.hasSubagents` from `resolveSubagents()`.
- `ProcessLinker` — links `Process` to AI chunks via `parentTaskId`, then timing fallback (`startTime` inside parent chunk) for orphans with no `parentTaskId`.
- `Process` (`src/main/types/chunks.ts`): `startTime`, `endTime`, `parentTaskId`, `metrics`, `mainSessionImpact`. `metrics` is the child's own burn. `mainSessionImpact` is what the spawn tool_use / tool_result costs the parent context window — never treat it as the child's tokens.
- `SessionMetrics`: `inputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `outputTokens`, `durationMs`.

## Projection

New pure function `buildSwimlane(chunks, processes, messages)` in `src/main/services/analysis/`. Testable without Electron. This is the lane model. Not a second session parser. Not a renderer util.

`get-session-detail` clears top-level `messages` and every top-level `Process.messages` before IPC. Run `buildSwimlane` on the pre-strip inputs and attach a serializable `SwimlaneModel` to `SessionDetail`. The renderer reads that projection only.

After `get-session-detail`, the renderer can draw the lane without reading `session.messages` or `Process.messages`.

## Agent-as-spawn (allowed existing-code edit)

Today `isTask` is `block.name === 'Task'` in `src/main/utils/toolExtraction.ts`. `SubagentResolver` filters spawn calls with `tc.isTask`. `ProcessLinker` only collects `toolCall.isTask` ids. Current Claude Code uses **`Agent`**, not only `Task`. If `isTask` does not treat `Agent` as a spawn, three parallel layers collapse into one turn and the swimlane lies.

Set `isTask` for `Agent` as well as `Task`. Every check that decides a linked `Process` is a subagent must follow `isTask`, not `name === 'Task'`:

- `src/main/utils/toolExtraction.ts`
- `SubagentResolver` / `ProcessLinker` (already `isTask`)
- `displayItemBuilder` (hide raw spawn tool / show `SubagentItem`)
- `ConversationGroupBuilder` (associate spawn with process)

`contextTracker` display name follows `isTask`. Do not change `SubagentItem` appearance. Do not edit `ChunkBuilder` except as required to classify `Agent` as a spawn.

`SubagentResolver` assigns `parentTaskId` from the root session only. Nesting uses the same spawn-join rules on each process's messages (`interval-classes.md`). Prefer spawn-id join. Timing fallback remains last resort.

## Session-view chrome (do not invent a new language)

- Search lives in `SearchBar` (`MiddlePanel`) and only appears on Cmd+F. Not the swimlane slot.
- Context is a sticky top-right button inside `ChatHistory`, visibility in `tabUISlice.showContextPanel` (per-tab, default off).
- Swimlane toggle sits in that same sticky row, same button language (`--context-btn-*`). Label **Swimlane**. Always render the row so the toggle is visible when Context is hidden. No Settings. Tokens, marks, and metrics density: `swimlane-visual.md`.

## Click-through

Swimlane **replaces** the turn list while on. Click a bar that already has a microscope target turns the swimlane off, then opens that target with the navigation the session view already has.

- Parent work → that turn.
- Child with an existing card → that card.
- Silent parent intervals are not clickable. Nested rows without a card stay visible.

No overlay. No stacked pane. Do not duplicate the microscope. Do not restyle `ChatHistory`.

## Isolation

1. Pure lane-model function, testable without Electron.
2. Small view: time axis, rows, bars, marks. Reuse existing surface colors and type. No new design system.
3. One button. Toggle local to the tab. Off by default. No settings. No theme work.
4. Click-through dismisses the swimlane and opens an existing microscope target.

Do not restyle ChatHistory, tokens, context panel, or the subagent modal.
