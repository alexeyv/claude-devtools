# Interval classes and HITL inference

Load-bearing classification for CAP-2 and CAP-4.

## Time axis

Wall clock from the earliest to latest timestamp in the parent session plus resolved children.

## Parent work vs silence

Parent **work** is when the parent is producing (assistant output). Assistant and `tool_use` timestamps are instants (`tool_use` inherits its containing assistant's timestamp). They are not intervals. Do not gap-fill to the next timestamp (`fillTimelineGaps` would paint silence as work).

Waiting on a spawned child is silence, then classified — even when the next parent assistant is still in the same AI chunk. That is the demo case: parent parks, children run.

Attribute parent-bar tokens from those producing assistants only, using the existing `requestId` / `calculateMetrics` dedup. Do not invent a second token sum. Do not attribute child usage or `mainSessionImpact`.

## Parent interval classes

| Class | When | Must look like |
| --- | --- | --- |
| **work** | Parent producing | Parent work |
| **HITL-wait** | Parent silent and a HITL ask is open | Wait, not work. Distinct from child-wait. Ask and answer are marks; the gap is the wait |
| **child-wait** | Parent silent, a linked child has timestamps in the gap, no HITL ask open | Wait, not work. Distinct from HITL-wait |
| **idle** | Parent silent, no linked child running, no open HITL | Silent, not work |

Precedence: HITL-wait while an ask is open, else child-wait, else idle. No fourth class.

A silent stretch must never look like work. Wrong wait-class is acceptable only for leftover gaps with no open HITL pair and no child timestamps in range.

Must not misclassify: child-only wait; explicit AskUserQuestion pair with no children; idle; overlapping HITL + children (HITL-wait).

## Child bars

One row per spawned Agent/Task child. Parallel children overlap on the time axis.

**Nesting.** Extra rows under the process that spawned them, not a second page. Use the same spawn-join rules already used for root children (including team members), applied to each process's messages. Do not assume resolver `parentTaskId` already means “spawned by this process.”

**Continuations.** `parentUuid` chain = the same child: one row, one bar per activation (`startTime`–`endTime` of that JSONL). Gaps between activations are empty, not child work. Click the activation that was clicked.

## HITL inference

HITL is inferred, not a log type. Label the mark; do not pretend certainty.

An ask is **open** from its start mark until its matching end mark (or axis end if unanswered). The gap is HITL-wait, not parent work, and must not be omitted.

- **AskUserQuestion:** start = the tool_use; end = the matching tool_result / `toolUseResult` for that tool_use id. Not the next `isParsedRealUserMessage` (that is the next typed prompt). Label `ask`.
- **Resume:** a later `isParsedRealUserMessage` (`isMeta: false`, not tool-result-only) after the parent went silent, and no AskUserQuestion pair already covers the gap. Label `resume`.

Do not require a separate checkpoint class. Messages cannot distinguish it from resume.

## Token numbers on bars

Each bar (parent work interval and child activation) shows wall duration plus uncached input, cache read, cache write, and output. Child numbers are that activation's own assistant usage. Never `mainSessionImpact`.
