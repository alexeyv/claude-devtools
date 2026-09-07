/**
 * Context-window size along one swimlane lane.
 *
 * Every assistant request saw a prompt of a known size, and by the end of its
 * generation the lane's context has grown by the request's output. Between two
 * requests nothing moves: whatever entered the context meanwhile (tool results,
 * a user message, a compaction) shows up as a step at the next request's start.
 * A compaction needs no marking of its own: it simply makes the next request's
 * start size smaller, which is a downward step like any other.
 */

import type { SessionMetrics, SwimlaneContextInterval } from '@main/types';

/**
 * One assistant request on a lane, structurally compatible with the builder's
 * `RequestRange` so callers pass those straight through without a module cycle.
 */
export interface ContextTrackRequest {
  start: number;
  end: number;
  metrics: SessionMetrics;
}

/** Size of the prompt the model saw for this request. */
function promptTokens(metrics: SessionMetrics): number {
  return metrics.inputTokens + metrics.cacheReadTokens + metrics.cacheCreationTokens;
}

/** A request is usable only when it carries a real, forward wall-clock range. */
function isPlaceable(request: ContextTrackRequest): boolean {
  return (
    Number.isFinite(request.start) && Number.isFinite(request.end) && request.end >= request.start
  );
}

/** Whether this request accounts for any token at all. */
function hasUsage(request: ContextTrackRequest): boolean {
  return promptTokens(request.metrics) + request.metrics.outputTokens > 0;
}

/**
 * Project a lane's requests onto an ordered series of abutting context intervals:
 * a generation interval per request, and a flat interval carrying its end size
 * across the gap to the next request.
 *
 * A lane whose transcript carries no token accounting has no track at all, and a
 * request without a usable wall-clock range is left out entirely. Requests that
 * overlap in wall time are clamped to start where the previous interval ended, so
 * the series stays abutting and the step lands at that clamped boundary.
 */
export function buildContextTrack(requests: ContextTrackRequest[]): SwimlaneContextInterval[] {
  const ordered = requests
    .filter(isPlaceable)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (!ordered.some(hasUsage)) return [];
  const intervals: SwimlaneContextInterval[] = [];
  let cursorTime: number | undefined;
  let cursorTokens = 0;

  for (const request of ordered) {
    const startTokens = promptTokens(request.metrics);
    const endTokens = startTokens + request.metrics.outputTokens;
    const start = cursorTime === undefined ? request.start : Math.max(request.start, cursorTime);

    if (cursorTime !== undefined && start > cursorTime) {
      intervals.push({
        startTime: new Date(cursorTime),
        endTime: new Date(start),
        startTokens: cursorTokens,
        endTokens: cursorTokens,
      });
    }

    // A request left with no room of its own - instantaneous, or wholly inside
    // its predecessor - draws nothing, but still moves the size the next flat
    // interval carries.
    if (request.end > start) {
      intervals.push({
        startTime: new Date(start),
        endTime: new Date(request.end),
        startTokens,
        endTokens,
      });
      cursorTime = request.end;
    } else {
      cursorTime = cursorTime === undefined ? request.end : Math.max(cursorTime, request.end);
    }
    cursorTokens = endTokens;
  }

  return intervals;
}
