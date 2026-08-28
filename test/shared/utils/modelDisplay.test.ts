/**
 * Tests for cross-platform model name formatting.
 */

import { describe, expect, it } from 'vitest';

import { formatModelName } from '../../../src/shared/utils/modelDisplay';

describe('formatModelName', () => {
  it('uses the Claude parser for Claude models', () => {
    expect(formatModelName('claude-sonnet-4-5-20250929', 'claude')).toBe('sonnet4.5');
  });

  it('falls back to the raw identifier for unparseable Claude models', () => {
    expect(formatModelName('claude-experimental', 'claude')).toBe('claude-experimental');
  });

  it('capitalizes the vendor prefix of OpenAI models', () => {
    expect(formatModelName('gpt-5.6-sol', 'codex')).toBe('GPT-5.6-sol');
  });

  it('preserves identifiers it has no rule for', () => {
    expect(formatModelName('some-model-v2', 'codex')).toBe('some-model-v2');
  });

  it.each([undefined, '', '   ', '<synthetic>'])('returns undefined for %s', (model) => {
    expect(formatModelName(model, 'codex')).toBeUndefined();
  });
});
