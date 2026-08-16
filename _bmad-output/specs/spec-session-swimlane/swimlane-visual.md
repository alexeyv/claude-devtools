# Swimlane visual

How the clock looks. Classification stays in `interval-classes.md`. No new CSS variables, no new design system, no theme work.

## Button

Label: **Swimlane**. Same size, type, and `--context-btn-*` idle/hover/active tokens as **Context**. Active while the swimlane is on.

## Surface

Replaces the turn list in the same ChatHistory content column (`max-w-5xl`). Background `--color-surface`. Type `--color-text`, `--color-text-secondary`, `--color-text-muted`. No zoom, no pan. If the clock is wider than the column, horizontal scroll inside the swimlane — not a new scrollbar theme.

## Interval classes (parent)

Distinguish by fill and pattern, not by inventing hues.

| Class | Look | Tokens |
| --- | --- | --- |
| **work** | Solid bar | fill `--color-surface-raised`, text `--color-text` |
| **child-wait** | Hatch or stripe on an empty track | stroke `--color-border-emphasis`, hatch `--color-border`. Not a third fill color. |
| **HITL-wait** | Tinted wait region | `--warning-bg`, `--warning-border`, `--warning-text`. Not `--interruption-*` (that is abort-red). |
| **idle** | Empty track | `--color-border-subtle` only. No fill. |

Silent (child-wait, HITL-wait, idle) must never use the work fill.

## Child bars

Solid bar, `--card-header-bg` / `--card-border` / `--card-text-light`. Lane accent may reuse existing `getSubagentTypeColorSet` / `getTeamColorSet` when the process already has a type or team color. Do not invent per-lane hues.

Row label: `Process.description` or `subagentType`, same 60-character truncate as `SubagentItem`. Parent row label: `Parent`. Nested rows indent under their parent.

## HITL marks

Vertical ticks on the axis, not bars. Short inferred label next to the tick: `ask`, `resume`, or `checkpoint`. Color `--warning-text`. Do not add certainty words.

## Metrics on bars

One compact line per bar, always visible:

`{formatDuration} · {uncached} in · {cache read} cache · {cache write} write · {output} out`

Use existing `formatDuration` and `formatTokensCompact`. If the bar is too short to hold the line, place the line to the right of the bar on the same row. Hover may repeat the same figures; it must not be the only place they exist.

## No children

One parent row, the axis, HITL marks if any. No empty-state illustration, no call-to-action.
