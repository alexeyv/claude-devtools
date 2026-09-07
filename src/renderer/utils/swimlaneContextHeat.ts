/**
 * Colour ramp for the swimlane's context-heat strips.
 *
 * A lane's context size is mapped onto one fixed cold-to-burning ramp so that
 * every lane, at every zoom, reads on the same absolute scale:
 * `CONTEXT_HEAT_MIN_TOKENS` and below is the cold end and
 * `CONTEXT_HEAT_MAX_TOKENS` and above the burning end. The floor sits where a
 * real session starts, since system prompt and tool schemas alone put every
 * request above it, so the ramp spends no colour on sizes no lane ever has.
 */

import { formatTokensCompact } from '@shared/utils/tokenFormatting';

import type { SwimlaneContextInterval } from '@shared/types';
import type { CSSProperties } from 'react';

/** Token count at and below which the ramp sits at its coldest colour. */
export const CONTEXT_HEAT_MIN_TOKENS = 20_000;

/** Token count at which the ramp saturates at its hottest colour. */
export const CONTEXT_HEAT_MAX_TOKENS = 200_000;

interface RampStop {
  /** Position on the ramp, 0 at the cold end and 1 at the burning end. */
  position: number;
  rgb: readonly [number, number, number];
}

/**
 * Cold blue turning teal within the first 30k, green and khaki across the
 * middle, amber late, and a burning incandescent orange only at the top. The
 * cold end changes fastest because that is where sub-agents live and where a
 * climb of 10k should still be visible on a four-pixel strip; the cool half of
 * the ramp covers the sizes a session sits at most of the time, so halfway up
 * reads as warm rather than already burning. Red rises and blue falls across
 * every stop, so hotter is unambiguous even for a colour-blind reader, and
 * relative luminance climbs the whole way, so the burning end is the brightest
 * band on the dark surface and no intermediate stop outshines it.
 */
const RAMP_STOPS: readonly RampStop[] = [
  { position: 0, rgb: [37, 99, 235] },
  { position: 0.17, rgb: [40, 160, 170] },
  { position: 0.4, rgb: [90, 165, 120] },
  { position: 0.6, rgb: [150, 160, 80] },
  { position: 0.8, rgb: [210, 145, 50] },
  { position: 1, rgb: [255, 132, 30] },
];

function clampRampPosition(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= CONTEXT_HEAT_MIN_TOKENS) return 0;
  if (tokens >= CONTEXT_HEAT_MAX_TOKENS) return 1;
  return (tokens - CONTEXT_HEAT_MIN_TOKENS) / (CONTEXT_HEAT_MAX_TOKENS - CONTEXT_HEAT_MIN_TOKENS);
}

/** The ramp colour for a context size, clamped at the ramp's minimum and maximum. */
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
