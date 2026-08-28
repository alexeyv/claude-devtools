/**
 * Formatting utility functions for display values.
 */

// Re-export token formatting from shared module
export { formatTokensCompact } from '@shared/utils/tokenFormatting';

/**
 * Formats duration in milliseconds to a human-readable string.
 */
export function formatDuration(rawMs: number): string {
  // Clock skew between call and result can yield negatives; never render them.
  const ms = Math.max(0, rawMs);
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  // Round first, then split: rounding the remainder alone renders 419.6s as
  // "6m 60s" instead of carrying into the next minute.
  const wholeSeconds = Math.round(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}m ${wholeSeconds % 60}s`;
}
