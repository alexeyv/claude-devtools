/**
 * Colour ramp for the swimlane's context-heat strips.
 *
 * A lane's context size is mapped onto one fixed cold-to-burning ramp so that
 * every lane, at every zoom, reads on the same absolute scale: 0 tokens is the
 * cold end and `CONTEXT_HEAT_MAX_TOKENS` and above the burning end.
 */

import type { SwimlaneContextInterval } from '@shared/types';
import type { CSSProperties } from 'react';

/** Token count at which the ramp saturates at its hottest colour. */
export const CONTEXT_HEAT_MAX_TOKENS = 200_000;

interface RampStop {
  /** Position on the ramp, 0 at the cold end and 1 at the burning end. */
  position: number;
  rgb: readonly [number, number, number];
}

/**
 * Cold blue through teal and amber into burning red. Red rises and blue falls
 * across every stop, so hotter is unambiguous even for a colour-blind reader.
 */
const RAMP_STOPS: readonly RampStop[] = [
  { position: 0, rgb: [37, 99, 235] },
  { position: 0.25, rgb: [45, 180, 190] },
  { position: 0.5, rgb: [235, 190, 40] },
  { position: 0.75, rgb: [243, 120, 28] },
  { position: 1, rgb: [248, 40, 24] },
];

function clampRampPosition(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  if (tokens >= CONTEXT_HEAT_MAX_TOKENS) return 1;
  return tokens / CONTEXT_HEAT_MAX_TOKENS;
}

/** The ramp colour for a context size, clamped at 0 and at the ramp's maximum. */
export function contextHeatColor(tokens: number): string {
  const position = clampRampPosition(tokens);
  // Every position lands on or before the final stop, which sits at 1.
  const upperIndex = Math.max(
    1,
    RAMP_STOPS.findIndex((stop) => position <= stop.position)
  );
  const upper = RAMP_STOPS[upperIndex];
  const lower = RAMP_STOPS[upperIndex - 1];
  const ratio = (position - lower.position) / (upper.position - lower.position);
  const [red, green, blue] = lower.rgb.map((channel, index) =>
    Math.round(channel + (upper.rgb[index] - channel) * ratio)
  );
  return `rgb(${red}, ${green}, ${blue})`;
}

/**
 * The strip background for one context interval: a flat colour when the size
 * does not move, and a left-to-right gradient across a request's generation.
 */
export function contextHeatBackground(
  interval: Pick<SwimlaneContextInterval, 'startTokens' | 'endTokens'>
): CSSProperties {
  const startColor = contextHeatColor(interval.startTokens);
  const endColor = contextHeatColor(interval.endTokens);
  if (interval.startTokens === interval.endTokens) {
    return { backgroundColor: startColor };
  }
  return { backgroundImage: `linear-gradient(90deg, ${startColor} 0%, ${endColor} 100%)` };
}
