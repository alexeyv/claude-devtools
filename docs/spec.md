# Swimlane epic: context heat along every lane

The session swimlane (`src/renderer/components/chat/SwimlaneSurface.tsx`, model built
by `src/main/services/analysis/SwimlaneBuilder.ts`) shows when each session was
working and how many tokens each request used. It does not show the one number that
governs a session's cost and behaviour moment to moment: how full its context window
is. Add a heat strip along every lane that colour-codes the session's context size
over wall time.

## What context size means

At each assistant request the model saw a prompt of a known size:

    context at request = inputTokens + cacheReadTokens + cacheCreationTokens

from that request's usage (`SessionMetrics` in `src/main/types/domain.ts`, already
attached to assistant request groups in the swimlane model). By the end of that
request's generation the session's context has grown by its `outputTokens`; that sum
is the size the next request starts from, before whatever tool results or user
messages get added.

Between requests the size does not move: tool execution, waiting on children, and
human waits are flat. Whatever enters the context between two requests (tool results,
a user message) shows up as a step at the moment the next request is submitted. During
a request's generation (reasoning, text, tool-call arguments, including the contents of
a Write) the size rises gradually from its start value to its end value. Generation
runs from the submission the request answers to its last assistant entry: the
transcript writes an assistant entry only when a content block finishes streaming, so
the first entry lands after the reasoning, not before it. A request whose submission
cannot be found starts at its first entry instead. Compaction
(`isCompactSummary`, see `src/main/types/messages.ts`) makes the next request's start
value smaller; that is a downward step and needs no other marking.

So a lane's context track is an ordered series of abutting intervals, each with a
start time, an end time, a token count at the start, and one at the end. Generation
intervals have different counts; flat intervals have equal counts; a step is two
neighbouring intervals whose counts disagree at the shared boundary.

## Model (main)

- `SwimlaneBuilder` derives a context track for the parent lane and one for every
  child activation (`SwimlaneChildActivation`), from that lane's own transcript
  messages and usage. Child tracks come from the child's own assistant messages,
  never from the parent's `mainSessionImpact`.
- The track covers the lane from its first request submission to its last request end.
  Continuation gaps between activations of the same child carry no track.
- A lane whose transcript has no usage records (a Codex rollout without token
  accounting, for example) has an empty track and draws nothing.
- The track is serializable, rides on `SwimlaneModel` through the existing IPC path,
  and bumps `SWIMLANE_SCHEMA_VERSION`. Consumers of the old shape must not break on a
  model with an empty track.
- Pure function, tested without Electron. Required fixtures: a single request; two
  requests with a tool result between them (flat then step up); a compaction between
  requests (step down); a child activation with its own requests; a lane with no
  usage.

## View (renderer)

- Each lane row (the parent lane and each child activation) draws its track as a
  thin strip along the bottom of the row's clock area, on the same wall-clock axis as
  the bars, at every zoom and scroll position. Row height, label column, fonts, bar
  geometry, and existing colours are unchanged.
- Colour encodes tokens on a fixed ramp: 20,000 and below is blank white, saturating
  into blue and warming through teal, green, khaki, amber and orange to red at
  200,000, then darkening to black at 300,000 and above. The scale is logarithmic in
  tokens, so every doubling of context moves the same distance along the ramp. No
  real request sits under the floor, so the ramp spends no colour there. Define the
  ramp once in the component. No new CSS variables or theme work.
- A flat interval is one colour; a generation interval is a gradient from its start
  colour to its end colour; a step is a hard edge.
- The existing hover time cursor, when over a lane row that has a track, adds that
  lane's context size at the pointer's instant to its label (interpolated within a
  generation interval, exact elsewhere; nothing when the instant is outside the
  track).
- The heat strips are optional: a control in the existing controls row (a button or
  checkbox, same language as the zoom controls) turns them off and on. On by default;
  component-local like zoom, so reopening the swimlane starts with them on. When off,
  no strip is drawn and the hover label carries no context size; the model is still
  built.
- A small legend beside that control shows the whole ramp, every stop in place, with
  its ends labelled (20k and 300k+), shown only
  while the strips are on.
- Each strip has an accessible name summarising the lane's start, peak, and end
  context sizes.
- Tests in the existing `SwimlaneSurface` harness: strip present per lane with a
  track, absent without; gradient and step rendering; hover label with and without a
  track; toggle off removes strips, legend, and hover size, toggle on restores them;
  legend; geometry unchanged under zoom.

## Non-goals

- No cost, no per-category breakdown, no persistence, no Settings.
- No changes to ChatHistory, the context panel, or the subagent modal.
- No restyle of bars, HITL marks, or the ruler; no vertical scaling of rows.
- No drag-to-zoom or other navigation changes.
