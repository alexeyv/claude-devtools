import { describe, expect, it } from 'vitest';

import {
  CONTEXT_HEAT_MAX_TOKENS,
  contextHeatBackground,
  contextHeatColor,
  contextSizeAt,
  contextTrackSummary,
} from '../../../src/renderer/utils/swimlaneContextHeat';

import type { SwimlaneContextInterval } from '../../../src/shared/types';

const BASE_TIME = Date.UTC(2024, 0, 1);

function at(seconds: number): Date {
  return new Date(BASE_TIME + seconds * 1000);
}

function interval(
  startSeconds: number,
  endSeconds: number,
  startTokens: number,
  endTokens: number
): SwimlaneContextInterval {
  return {
    startTime: at(startSeconds),
    endTime: at(endSeconds),
    startTokens,
    endTokens,
  };
}

/** Generation, a step up into a flat wait, generation, then a compaction step down. */
const track: SwimlaneContextInterval[] = [
  interval(0, 2, 1000, 1100),
  interval(2, 4, 1500, 1500),
  interval(4, 6, 1500, 3500),
  interval(6, 8, 900, 900),
];

function channels(color: string): number[] {
  const match = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(color);
  if (!match) throw new Error(`Unexpected ramp colour: ${color}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

describe('swimlaneContextHeat', () => {
  describe('contextHeatColor', () => {
    it('anchors the ramp at a cold and a burning end', () => {
      expect(CONTEXT_HEAT_MAX_TOKENS).toBe(200_000);
      expect(contextHeatColor(0)).toBe('rgb(37, 99, 235)');
      expect(contextHeatColor(CONTEXT_HEAT_MAX_TOKENS)).toBe('rgb(248, 40, 24)');
    });

    it('clamps below zero and above the maximum', () => {
      expect(contextHeatColor(-5000)).toBe(contextHeatColor(0));
      expect(contextHeatColor(Number.NaN)).toBe(contextHeatColor(0));
      expect(contextHeatColor(CONTEXT_HEAT_MAX_TOKENS + 1)).toBe(
        contextHeatColor(CONTEXT_HEAT_MAX_TOKENS)
      );
      expect(contextHeatColor(1_000_000)).toBe(contextHeatColor(CONTEXT_HEAT_MAX_TOKENS));
    });

    it('interpolates between the stops it passes through', () => {
      expect(contextHeatColor(CONTEXT_HEAT_MAX_TOKENS / 2)).toBe('rgb(235, 190, 40)');
      expect(contextHeatColor(CONTEXT_HEAT_MAX_TOKENS / 8)).toBe('rgb(41, 140, 213)');
    });

    it('warms monotonically: red never falls and blue never rises', () => {
      const samples = Array.from({ length: 41 }, (_, step) =>
        channels(contextHeatColor((step / 40) * CONTEXT_HEAT_MAX_TOKENS))
      );

      samples.slice(1).forEach(([red, , blue], index) => {
        const [previousRed, , previousBlue] = samples[index];
        expect(red).toBeGreaterThanOrEqual(previousRed);
        expect(blue).toBeLessThanOrEqual(previousBlue);
      });
      expect(samples[0]).not.toEqual(samples[samples.length - 1]);
    });
  });

  describe('contextHeatBackground', () => {
    it('paints a flat interval as one colour', () => {
      expect(contextHeatBackground({ startTokens: 40_000, endTokens: 40_000 })).toEqual({
        backgroundColor: contextHeatColor(40_000),
      });
    });

    it('paints a generation interval as a left-to-right gradient', () => {
      expect(contextHeatBackground({ startTokens: 0, endTokens: CONTEXT_HEAT_MAX_TOKENS })).toEqual(
        {
          backgroundImage: 'linear-gradient(90deg, rgb(37, 99, 235) 0%, rgb(248, 40, 24) 100%)',
        }
      );
      expect(
        contextHeatBackground({ startTokens: 120_000, endTokens: 60_000 }).backgroundColor
      ).toBeUndefined();
    });
  });

  describe('contextSizeAt', () => {
    it('returns nothing outside the track', () => {
      expect(contextSizeAt([], BASE_TIME)).toBeUndefined();
      expect(contextSizeAt(track, at(-0.001).getTime())).toBeUndefined();
      expect(contextSizeAt(track, at(8.001).getTime())).toBeUndefined();
    });

    it('interpolates inside a generation interval and is exact at its ends', () => {
      expect(contextSizeAt(track, at(0).getTime())).toBe(1000);
      expect(contextSizeAt(track, at(1).getTime())).toBe(1050);
      expect(contextSizeAt(track, at(5).getTime())).toBe(2500);
      expect(contextSizeAt(track, at(8).getTime())).toBe(900);
    });

    it('reads one value across a flat interval and the reached value at a step', () => {
      expect(contextSizeAt(track, at(2.5).getTime())).toBe(1500);
      expect(contextSizeAt(track, at(3).getTime())).toBe(1500);
      expect(contextSizeAt(track, at(2).getTime())).toBe(1100);
      expect(contextSizeAt(track, at(6).getTime())).toBe(3500);
    });

    it('answers a zero-length interval with the size it leaves behind', () => {
      expect(contextSizeAt([interval(3, 3, 500, 700)], at(3).getTime())).toBe(700);
    });
  });

  describe('contextTrackSummary', () => {
    it('states the start, peak, and end sizes', () => {
      expect(contextTrackSummary(track)).toBe('context from 1.0k to 900 tokens, peak 3.5k');
      expect(contextTrackSummary([interval(0, 1, 0, 250_000)])).toBe(
        'context from 0 to 250.0k tokens, peak 250.0k'
      );
    });

    it('has nothing to say about an empty track', () => {
      expect(contextTrackSummary([])).toBeUndefined();
    });
  });
});
