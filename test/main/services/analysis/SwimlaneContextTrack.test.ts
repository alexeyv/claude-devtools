/**
 * buildContextTrack: assistant requests projected onto the lane's context size.
 */

import { describe, expect, it } from 'vitest';

import {
  buildContextTrack,
  type ContextTrackRequest,
} from '../../../../src/main/services/analysis/SwimlaneContextTrack';

import type { SessionMetrics } from '../../../../src/main/types';

const baseTime = new Date('2026-08-16T10:00:00.000Z').getTime();

function at(seconds: number): number {
  return baseTime + seconds * 1000;
}

function metrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    durationMs: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    messageCount: 0,
    ...overrides,
  };
}

function request(
  start: number,
  end: number,
  overrides: Partial<SessionMetrics> = {}
): ContextTrackRequest {
  return { start: at(start), end: at(end), metrics: metrics(overrides) };
}

describe('buildContextTrack', () => {
  it('turns one request into a generation interval from its prompt size to its grown size', () => {
    const track = buildContextTrack([
      request(1, 3, { inputTokens: 1200, cacheReadTokens: 500, cacheCreationTokens: 300 }),
    ]);

    expect(track).toEqual([
      {
        startTime: new Date(at(1)),
        endTime: new Date(at(3)),
        startTokens: 2000,
        endTokens: 2000,
      },
    ]);
  });

  it('grows a generation interval by the request output tokens', () => {
    const [generation] = buildContextTrack([
      request(0, 2, { inputTokens: 1000, outputTokens: 250 }),
    ]);

    expect(generation.startTokens).toBe(1000);
    expect(generation.endTokens).toBe(1250);
  });

  it('fills the gap between two requests flat, then steps up at the next request', () => {
    const track = buildContextTrack([
      request(0, 2, { inputTokens: 1000, cacheReadTokens: 200, outputTokens: 100 }),
      request(5, 6, { inputTokens: 1500, cacheReadTokens: 400, outputTokens: 50 }),
    ]);

    expect(track).toEqual([
      {
        startTime: new Date(at(0)),
        endTime: new Date(at(2)),
        startTokens: 1200,
        endTokens: 1300,
      },
      {
        startTime: new Date(at(2)),
        endTime: new Date(at(5)),
        startTokens: 1300,
        endTokens: 1300,
      },
      {
        startTime: new Date(at(5)),
        endTime: new Date(at(6)),
        startTokens: 1900,
        endTokens: 1950,
      },
    ]);
  });

  it('orders requests by start and leaves abutting intervals that never run backwards', () => {
    const track = buildContextTrack([
      request(5, 6, { inputTokens: 1900, outputTokens: 50 }),
      request(0, 2, { inputTokens: 1200, outputTokens: 100 }),
    ]);

    expect(track.map((interval) => interval.startTime.getTime())).toEqual([at(0), at(2), at(5)]);
    for (const interval of track) {
      expect(interval.endTime.getTime()).toBeGreaterThanOrEqual(interval.startTime.getTime());
    }
    for (let index = 1; index < track.length; index++) {
      expect(track[index].startTime.getTime()).toBe(track[index - 1].endTime.getTime());
    }
  });
});
