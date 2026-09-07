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
 * request without a usable wall-clock range is left out entirely.
 */
export function buildContextTrack(requests: ContextTrackRequest[]): SwimlaneContextInterval[] {
  const ordered = requests
    .filter(isPlaceable)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (!ordered.some(hasUsage)) return [];
  const intervals: SwimlaneContextInterval[] = [];

  ordered.forEach((request, index) => {
    const startTokens = promptTokens(request.metrics);
    const endTokens = startTokens + request.metrics.outputTokens;
    // An instantaneous request draws nothing, but still moves the size the next
    // flat interval carries.
    if (request.end > request.start) {
      intervals.push({
        startTime: new Date(request.start),
        endTime: new Date(request.end),
        startTokens,
        endTokens,
      });
    }

    const next = ordered[index + 1];
    if (next && next.start > request.end) {
      intervals.push({
        startTime: new Date(request.end),
        endTime: new Date(next.start),
        startTokens: endTokens,
        endTokens,
      });
    }
  });

  return intervals;
}
