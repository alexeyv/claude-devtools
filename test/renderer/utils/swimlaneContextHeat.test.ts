import { describe, expect, it } from 'vitest';

import {
  CONTEXT_HEAT_MAX_TOKENS,
  contextHeatBackground,
  contextHeatColor,
} from '../../../src/renderer/utils/swimlaneContextHeat';

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
});
