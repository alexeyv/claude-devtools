/**
 * Friendly model names across platforms.
 *
 * `parseModelString` understands Claude identifiers only and returns null for
 * anything else, which would leave a Codex session's header blank. This wraps
 * it with light, non-inventive formatting for other platforms: the recorded
 * identifier is preserved, only its casing is tidied.
 */

import { parseModelString } from './modelParser';
import { type AgentPlatform } from './toolIdentity';

/** Vendor prefixes rendered in caps rather than title case. */
const UPPERCASE_PREFIXES = ['gpt', 'o1', 'o3', 'o4'];

/**
 * Format a model identifier for display.
 * Returns undefined when there is no usable model string.
 */
export function formatModelName(
  model: string | undefined,
  platform: AgentPlatform = 'claude'
): string | undefined {
  if (!model || model.trim() === '' || model === '<synthetic>') return undefined;

  if (platform === 'claude') {
    return parseModelString(model)?.name ?? model;
  }

  const trimmed = model.trim();
  const separator = trimmed.indexOf('-');
  const head = separator === -1 ? trimmed : trimmed.slice(0, separator);

  if (UPPERCASE_PREFIXES.includes(head.toLowerCase())) {
    return head.toUpperCase() + trimmed.slice(head.length);
  }

  return trimmed;
}
