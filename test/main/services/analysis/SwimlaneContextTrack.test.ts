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

  it('steps down at the request after a compaction without marking it further', () => {
    const track = buildContextTrack([
      request(0, 2, { inputTokens: 90_000, cacheReadTokens: 30_000, outputTokens: 5_000 }),
      request(5, 6, { inputTokens: 12_000, outputTokens: 400 }),
    ]);

    expect(track.map((interval) => [interval.startTokens, interval.endTokens])).toEqual([
      [120_000, 125_000],
      [125_000, 125_000],
      [12_000, 12_400],
    ]);
    expect(track).toHaveLength(3);
  });

  it('has no track for a lane whose requests carry no usage at all', () => {
    expect(buildContextTrack([])).toEqual([]);
    expect(buildContextTrack([request(0, 2), request(5, 6)])).toEqual([]);
  });

  it('skips requests with non-finite times', () => {
    const track = buildContextTrack([
      { start: Number.NaN, end: at(1), metrics: metrics({ inputTokens: 999 }) },
      { start: at(0), end: Number.POSITIVE_INFINITY, metrics: metrics({ inputTokens: 999 }) },
      request(2, 4, { inputTokens: 1000, outputTokens: 100 }),
    ]);

    expect(track).toEqual([
      {
        startTime: new Date(at(2)),
        endTime: new Date(at(4)),
        startTokens: 1000,
        endTokens: 1100,
      },
    ]);
  });

  it('draws no generation interval for a zero-length request but still advances the size', () => {
    const track = buildContextTrack([
      request(0, 0, { inputTokens: 1000, outputTokens: 200 }),
      request(4, 6, { inputTokens: 1500, outputTokens: 50 }),
    ]);

    expect(track).toEqual([
      {
        startTime: new Date(at(0)),
        endTime: new Date(at(4)),
        startTokens: 1200,
        endTokens: 1200,
      },
      {
        startTime: new Date(at(4)),
        endTime: new Date(at(6)),
        startTokens: 1500,
        endTokens: 1550,
      },
    ]);
  });

  it('clamps overlapping requests into abutting intervals in start order', () => {
    const track = buildContextTrack([
      request(0, 10, { inputTokens: 1000, outputTokens: 100 }),
      request(5, 20, { inputTokens: 1800, outputTokens: 200 }),
    ]);

    expect(track).toEqual([
      {
        startTime: new Date(at(0)),
        endTime: new Date(at(10)),
        startTokens: 1000,
        endTokens: 1100,
      },
      {
        startTime: new Date(at(10)),
        endTime: new Date(at(20)),
        startTokens: 1800,
        endTokens: 2000,
      },
    ]);
  });

  it('draws nothing for a request wholly inside its predecessor but still advances the size', () => {
    const track = buildContextTrack([
      request(0, 10, { inputTokens: 1000, outputTokens: 100 }),
      request(2, 4, { inputTokens: 1800, outputTokens: 200 }),
      request(15, 16, { inputTokens: 2500, outputTokens: 50 }),
    ]);

    expect(track).toEqual([
      {
        startTime: new Date(at(0)),
        endTime: new Date(at(10)),
        startTokens: 1000,
        endTokens: 1100,
      },
      {
        startTime: new Date(at(10)),
        endTime: new Date(at(15)),
        startTokens: 2000,
        endTokens: 2000,
      },
      {
        startTime: new Date(at(15)),
        endTime: new Date(at(16)),
        startTokens: 2500,
        endTokens: 2550,
      },
    ]);
  });

  it('orders requests by start and leaves abutting intervals that never run backwards', () => {
    const abutting = (track: ReturnType<typeof buildContextTrack>): void => {
      for (const interval of track) {
        expect(interval.endTime.getTime()).toBeGreaterThan(interval.startTime.getTime());
      }
      for (let index = 1; index < track.length; index++) {
        expect(track[index].startTime.getTime()).toBe(track[index - 1].endTime.getTime());
      }
    };

    const gapped = buildContextTrack([
      request(5, 6, { inputTokens: 1900, outputTokens: 50 }),
      request(0, 2, { inputTokens: 1200, outputTokens: 100 }),
    ]);
    expect(gapped.map((interval) => interval.startTime.getTime())).toEqual([at(0), at(2), at(5)]);
    abutting(gapped);

    const overlapping = buildContextTrack([
      request(8, 12, { inputTokens: 2000, outputTokens: 40 }),
      request(0, 10, { inputTokens: 1200, outputTokens: 100 }),
      request(3, 4, { inputTokens: 1500, outputTokens: 20 }),
    ]);
    expect(overlapping.map((interval) => interval.startTime.getTime())).toEqual([at(0), at(10)]);
    abutting(overlapping);
  });
});
