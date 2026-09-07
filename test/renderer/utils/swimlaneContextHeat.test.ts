import { describe, expect, it } from 'vitest';

import {
  CONTEXT_HEAT_MAX_TOKENS,
  CONTEXT_HEAT_MIN_TOKENS,
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

/** WCAG relative luminance, the perceived brightness of a ramp colour. */
function relativeLuminance(color: string): number {
  const [red, green, blue] = channels(color).map((channel) => {
    const scaled = channel / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

describe('swimlaneContextHeat', () => {
  describe('contextHeatColor', () => {
    it('anchors the ramp at a cold floor and a burning ceiling', () => {
      expect(CONTEXT_HEAT_MIN_TOKENS).toBe(20_000);
      expect(CONTEXT_HEAT_MAX_TOKENS).toBe(200_000);
      expect(contextHeatColor(CONTEXT_HEAT_MIN_TOKENS)).toBe('rgb(37, 99, 235)');
      expect(contextHeatColor(CONTEXT_HEAT_MAX_TOKENS)).toBe('rgb(255, 132, 30)');
    });

    it('clamps at the floor and above the maximum', () => {
      expect(contextHeatColor(0)).toBe(contextHeatColor(CONTEXT_HEAT_MIN_TOKENS));
      expect(contextHeatColor(-5000)).toBe(contextHeatColor(CONTEXT_HEAT_MIN_TOKENS));
      expect(contextHeatColor(Number.NaN)).toBe(contextHeatColor(CONTEXT_HEAT_MIN_TOKENS));
      expect(contextHeatColor(CONTEXT_HEAT_MIN_TOKENS + 5_000)).not.toBe(
        contextHeatColor(CONTEXT_HEAT_MIN_TOKENS)
      );
      expect(contextHeatColor(CONTEXT_HEAT_MAX_TOKENS + 1)).toBe(
        contextHeatColor(CONTEXT_HEAT_MAX_TOKENS)
      );
      expect(contextHeatColor(1_000_000)).toBe(contextHeatColor(CONTEXT_HEAT_MAX_TOKENS));
    });

    it('interpolates between the stops it passes through', () => {
      expect(contextHeatColor(40_000)).toBe('rgb(68, 163, 142)');
      expect(contextHeatColor(110_000)).toBe('rgb(192, 149, 59)');
    });

    it('is logarithmic: each doubling moves the same three tenths of the ramp', () => {
      expect(contextHeatColor(2 * CONTEXT_HEAT_MIN_TOKENS)).toBe('rgb(68, 163, 142)');
      expect(contextHeatColor(4 * CONTEXT_HEAT_MIN_TOKENS)).toBe('rgb(151, 160, 80)');
      expect(contextHeatColor(8 * CONTEXT_HEAT_MIN_TOKENS)).toBe('rgb(233, 138, 40)');
      expect(contextHeatColor(4 * CONTEXT_HEAT_MIN_TOKENS)).not.toBe(
        contextHeatColor(3 * CONTEXT_HEAT_MIN_TOKENS)
      );
    });

    it('keeps the middle of the ramp cool: halfway up is not yet amber', () => {
      const halfway = Math.round(Math.sqrt(CONTEXT_HEAT_MIN_TOKENS * CONTEXT_HEAT_MAX_TOKENS));
      const [red, green] = channels(contextHeatColor(halfway));
      expect(green).toBeGreaterThan(red);
    });

    it('burns brightest at the maximum: no stop outshines the hot end', () => {
      const decade = CONTEXT_HEAT_MAX_TOKENS / CONTEXT_HEAT_MIN_TOKENS;
      const stopLuminances = [0, 0.17, 0.4, 0.6, 0.8, 1].map((position) =>
        relativeLuminance(contextHeatColor(CONTEXT_HEAT_MIN_TOKENS * decade ** position))
      );
      const hottest = stopLuminances[stopLuminances.length - 1];

      stopLuminances.slice(0, -1).forEach((luminance) => {
        expect(luminance).toBeLessThan(hottest);
      });
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
          backgroundImage: 'linear-gradient(90deg, rgb(37, 99, 235) 0%, rgb(255, 132, 30) 100%)',
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
