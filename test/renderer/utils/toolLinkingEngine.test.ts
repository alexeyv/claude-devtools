import { describe, expect, it } from 'vitest';

import { linkToolCallsToResults } from '@renderer/utils/toolLinkingEngine';

import type { ParsedMessage, SemanticStep } from '@renderer/types/data';

function callStep(id: string, toolName: string): SemanticStep {
  return {
    id,
    type: 'tool_call',
    startTime: new Date('2025-01-01T00:00:00Z'),
    durationMs: 0,
    content: { toolName, toolInput: {} },
    tokens: { input: 0, output: 0 },
    context: 'main',
  } as SemanticStep;
}

function responseWithCall(id: string, name: string, platform?: 'claude' | 'codex'): ParsedMessage {
  return {
    uuid: `msg-${id}`,
    type: 'assistant',
    role: 'assistant',
    timestamp: new Date('2025-01-01T00:00:00Z'),
    content: [],
    toolCalls: [{ id, name, input: {}, isTask: false, platform }],
    toolResults: [],
  } as unknown as ParsedMessage;
}

describe('linkToolCallsToResults platform', () => {
  it('takes the platform from the recorded tool call', () => {
    const linked = linkToolCallsToResults(
      [callStep('c1', 'exec')],
      [responseWithCall('c1', 'exec', 'codex')]
    );
    expect(linked.get('c1')?.platform).toBe('codex');
  });

  it('defaults to claude when the call records no platform', () => {
    const linked = linkToolCallsToResults([callStep('c2', 'Read')], [responseWithCall('c2', 'Read')]);
    expect(linked.get('c2')?.platform).toBe('claude');
    expect(linkToolCallsToResults([callStep('c3', 'Read')]).get('c3')?.platform).toBe('claude');
  });
});
