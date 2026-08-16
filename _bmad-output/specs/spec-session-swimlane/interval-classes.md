# Interval classes and HITL inference

Load-bearing classification for CAP-2 and CAP-4. The kernel names the classes; this file defines them.

## Time axis

Wall clock from the earliest to latest timestamp in the parent session plus resolved children.

## Parent interval classes

| Class | When | Must look like |
| --- | --- | --- |
| **work** | Parent is producing: assistant timestamps and their `tool_use` timestamps | Parent work |
| **child-wait** | Parent silent, and at least one linked child still has timestamps in the gap | Wait, not work. Distinct from HITL-wait |
| **HITL-wait** | Parent silent after an ask/checkpoint until the next real user/resume | Wait, not work. Distinct from child-wait. Ask and answer are marks; the gap is the wait |
| **idle** | Parent silent, no linked child running, no open HITL | Silent, not work |

Wrong wait-class is acceptable if the gap is still drawn. A silent stretch must never look like work.

## Child bars

One bar per spawned Agent/Task child, from the first to last timestamp in that child's jsonl. Parallel children overlap on the time axis.

**Nesting.** Process B is a child-of-child when `B.parentTaskId` matches a spawn tool_use id (`isTask`) in process A's messages. Render B as an extra row under A, not a second page.

**Continuations.** Processes linked by the existing `parentUuid` continuation chain are the same child: one row, bar from earliest `startTime` to latest `endTime`. Do not add extra rows for continuation files.

## HITL inference

HITL is inferred, not a log type. Label the mark; do not pretend certainty.

Treat as HITL when the parent stopped for a human, or for a scripted resume that looks like one:

- `AskUserQuestion`
- A real user message after the parent went quiet (`isParsedRealUserMessage`: `isMeta: false`, not a tool result)
- A headless `claude -p` checkpoint: last assistant in a segment, process ends, later a user string in the same session that is not a `tool_result` and not `isMeta`

Show ask and answer as marks. The gap between them is HITL-wait, not parent work, and must not be omitted.

## Token numbers on bars

Each bar (parent interval and child) shows:

- wall duration
- uncached input
- cache read
- cache write
- output

Child numbers are the child's own assistant `usage` in that jsonl (uncached input / cache_read / cache_creation / output). Do not use the parent's `mainSessionImpact` as if it were the child's burn.
