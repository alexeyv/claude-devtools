/**
 * Colour ramp for the swimlane's context-heat strips.
 *
 * A lane's context size is mapped onto one fixed ramp so that every lane, at
 * every zoom, reads on the same absolute scale: `CONTEXT_HEAT_MIN_TOKENS` and
 * below is blank white, saturating into blue by 50k and warming through the middle to
 * red at `CONTEXT_HEAT_RED_TOKENS`, then darkening to black at
 * `CONTEXT_HEAT_MAX_TOKENS` and above. The scale is logarithmic in tokens, so
 * a doubling anywhere reads as the same change. The floor sits where a real
 * session starts, since system prompt and tool schemas alone put every request
 * above it, so the ramp spends no colour on sizes no lane ever has.
 */

import { formatTokensCompact } from '@shared/utils/tokenFormatting';

import type { SwimlaneContextInterval } from '@shared/types';
import type { CSSProperties } from 'react';

/** Token count at and below which the ramp sits at its coldest colour. */
export const CONTEXT_HEAT_MIN_TOKENS = 20_000;

/** Token count at which the ramp reaches pure red, a session filling its window. */
export const CONTEXT_HEAT_RED_TOKENS = 200_000;

/** Token count at and above which the ramp has burnt out to black. */
export const CONTEXT_HEAT_MAX_TOKENS = 300_000;

interface RampStop {
  /** Context size this colour is exact at. */
  tokens: number;
  rgb: readonly [number, number, number];
}

/**
 * Blank white saturating into blue across the first 30k, so a sub-agent's
 * early tens of thousands are visible motion on a four-pixel strip; from blue
 * at 50k the warm stops sit a quarter of a doubling apart through teal, green,
 * khaki, amber and orange to red at 200k, where a session is filling its
 * window; then darker and darker red until 300k is black. Stops sit at token
 * counts and the ramp interpolates between them on the logarithmic scale.
 */
const RAMP_STOPS: readonly RampStop[] = [
  { tokens: 20_000, rgb: [250, 250, 252] },
  { tokens: 30_000, rgb: [160, 195, 245] },
  { tokens: 50_000, rgb: [37, 99, 235] },
  { tokens: 63_000, rgb: [40, 160, 170] },
  { tokens: 79_000, rgb: [90, 165, 120] },
  { tokens: 100_000, rgb: [150, 160, 80] },
  { tokens: 126_000, rgb: [210, 145, 50] },
  { tokens: 159_000, rgb: [255, 132, 30] },
  { tokens: 200_000, rgb: [255, 45, 25] },
  { tokens: 300_000, rgb: [0, 0, 0] },
];

/**
 * Position on the ramp, logarithmic in tokens between the floor and the
 * ceiling, so every doubling of context moves the same distance.
 */
function clampRampPosition(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= CONTEXT_HEAT_MIN_TOKENS) return 0;
  if (tokens >= CONTEXT_HEAT_MAX_TOKENS) return 1;
  return (
    Math.log(tokens / CONTEXT_HEAT_MIN_TOKENS) /
    Math.log(CONTEXT_HEAT_MAX_TOKENS / CONTEXT_HEAT_MIN_TOKENS)
  );
}

const STOP_POSITIONS = RAMP_STOPS.map((stop) => clampRampPosition(stop.tokens));

/** The whole ramp as a CSS gradient, every stop at its place, for the legend. */
export function contextHeatLegendGradient(): string {
  const stops = RAMP_STOPS.map(
    ({ rgb: [red, green, blue] }, index) =>
      `rgb(${red}, ${green}, ${blue}) ${(STOP_POSITIONS[index] * 100).toFixed(1)}%`
  );
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/** The ramp colour for a context size, clamped at the ramp's minimum and maximum. */
export function contextHeatColor(tokens: number): string {
  const position = clampRampPosition(tokens);
  // Every position lands on or before the final stop, which sits at 1.
  const upperIndex = Math.max(
    1,
    STOP_POSITIONS.findIndex((stopPosition) => position <= stopPosition)
  );
  const upper = RAMP_STOPS[upperIndex];
  const lower = RAMP_STOPS[upperIndex - 1];
  const ratio =
    (position - STOP_POSITIONS[upperIndex - 1]) /
    (STOP_POSITIONS[upperIndex] - STOP_POSITIONS[upperIndex - 1]);
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

/**
 * The context size at one instant, or undefined when the instant falls outside
 * the track. Interpolated inside a generation interval and exact everywhere
 * else; at a shared boundary the earlier interval's end value wins, so a step
 * reads as the size the lane had reached.
 *
 * Assumes the sorted, abutting track the renderer's normalizer produces.
 */
export function contextSizeAt(
  track: readonly SwimlaneContextInterval[],
  instantMs: number
): number | undefined {
  for (const interval of track) {
    const start = interval.startTime.getTime();
    const end = interval.endTime.getTime();
    if (instantMs < start || instantMs > end) continue;
    if (end <= start) return interval.endTokens;
    const ratio = (instantMs - start) / (end - start);
    return Math.round(interval.startTokens + (interval.endTokens - interval.startTokens) * ratio);
  }
  return undefined;
}

/**
 * The body of a strip's accessible name: where the lane's context started,
 * how high it climbed, and where it ended. Undefined for an empty track.
 */
export function contextTrackSummary(track: readonly SwimlaneContextInterval[]): string | undefined {
  const first = track[0];
  const last = track[track.length - 1];
  if (!first || !last) return undefined;
  const peak = track.reduce(
    (highest, interval) => Math.max(highest, interval.startTokens, interval.endTokens),
    Number.NEGATIVE_INFINITY
  );
  return `context from ${formatTokensCompact(first.startTokens)} to ${formatTokensCompact(
    last.endTokens
  )} tokens, peak ${formatTokensCompact(peak)}`;
}
