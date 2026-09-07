import { describe, expect, it } from 'vitest';

import {
  CONTEXT_HEAT_MAX_TOKENS,
  CONTEXT_HEAT_MIN_TOKENS,
  CONTEXT_HEAT_RED_TOKENS,
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
    it('runs from blank white at the floor through red to black at the ceiling', () => {
      expect(CONTEXT_HEAT_MIN_TOKENS).toBe(20_000);
      expect(CONTEXT_HEAT_RED_TOKENS).toBe(200_000);
      expect(CONTEXT_HEAT_MAX_TOKENS).toBe(300_000);
      expect(contextHeatColor(CONTEXT_HEAT_MIN_TOKENS)).toBe('rgb(250, 250, 252)');
      expect(contextHeatColor(CONTEXT_HEAT_RED_TOKENS)).toBe('rgb(255, 45, 25)');
      expect(contextHeatColor(CONTEXT_HEAT_MAX_TOKENS)).toBe('rgb(0, 0, 0)');
    });

    it('clamps at the floor and above the ceiling', () => {
      expect(contextHeatColor(0)).toBe(contextHeatColor(CONTEXT_HEAT_MIN_TOKENS));
      expect(contextHeatColor(-5000)).toBe(contextHeatColor(CONTEXT_HEAT_MIN_TOKENS));
      expect(contextHeatColor(Number.NaN)).toBe(contextHeatColor(CONTEXT_HEAT_MIN_TOKENS));
      expect(contextHeatColor(CONTEXT_HEAT_MIN_TOKENS + 1000)).not.toBe(
        contextHeatColor(CONTEXT_HEAT_MIN_TOKENS)
      );
      expect(contextHeatColor(CONTEXT_HEAT_MAX_TOKENS + 1)).toBe(
        contextHeatColor(CONTEXT_HEAT_MAX_TOKENS)
      );
      expect(contextHeatColor(1_000_000)).toBe(contextHeatColor(CONTEXT_HEAT_MAX_TOKENS));
    });

    it('interpolates between the stops it passes through', () => {
      expect(contextHeatColor(29_000)).toBe('rgb(168, 200, 246)');
      expect(contextHeatColor(110_000)).toBe('rgb(175, 154, 68)');
      expect(contextHeatColor(250_000)).toBe('rgb(115, 20, 11)');
    });

    it('is logarithmic: each doubling moves the same distance along the ramp', () => {
      expect(contextHeatColor(2 * CONTEXT_HEAT_MIN_TOKENS)).toBe('rgb(91, 141, 239)');
      expect(contextHeatColor(4 * CONTEXT_HEAT_MIN_TOKENS)).toBe('rgb(93, 165, 118)');
      expect(contextHeatColor(8 * CONTEXT_HEAT_MIN_TOKENS)).toBe('rgb(255, 130, 30)');
    });

    it('saturates from white into blue between 20k and 50k', () => {
      const spread = (tokens: number) => {
        const values = channels(contextHeatColor(tokens));
        return Math.max(...values) - Math.min(...values);
      };
      expect(spread(20_000)).toBeLessThan(5);
      expect(spread(30_000)).toBeGreaterThan(spread(20_000));
      expect(spread(50_000)).toBeGreaterThan(spread(30_000));
      expect(contextHeatColor(50_000)).toBe('rgb(37, 99, 235)');
    });

    it('keeps the middle of the ramp cool: 60k is greener than it is red', () => {
      const [red, green] = channels(contextHeatColor(60_000));
      expect(green).toBeGreaterThan(red);
    });

    it('burns red at 200k and darkens to black beyond it', () => {
      const [red, green, blue] = channels(contextHeatColor(CONTEXT_HEAT_RED_TOKENS));
      expect(red).toBe(255);
      expect(green).toBeLessThan(60);
      expect(blue).toBeLessThan(40);
      const beyond = [220_000, 250_000, 280_000, 300_000].map((tokens) =>
        channels(contextHeatColor(tokens))
      );
      beyond.slice(1).forEach(([nextRed], index) => {
        expect(nextRed).toBeLessThan(beyond[index][0]);
      });
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
          backgroundImage: 'linear-gradient(90deg, rgb(250, 250, 252) 0%, rgb(0, 0, 0) 100%)',
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
