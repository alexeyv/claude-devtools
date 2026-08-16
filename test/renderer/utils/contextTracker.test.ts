import { describe, expect, it } from 'vitest';

import { processSessionContextWithPhases } from '../../../src/renderer/utils/contextTracker';
import type { AIGroup, ChatItem } from '../../../src/renderer/types/groups';

function createAIGroup(toolName: string): AIGroup {
  const startTime = new Date('2026-08-16T10:00:00Z');
  return {
    id: `ai-${toolName}`,
    turnIndex: 0,
    startTime,
    endTime: new Date(startTime.getTime() + 100),
    durationMs: 100,
    steps: [
      {
        id: 'spawn-1',
        type: 'tool_call',
        startTime,
        durationMs: 0,
        content: { toolName, toolInput: { description: 'Inspect code' } },
        context: 'main',
      },
      {
        id: 'spawn-1',
        type: 'tool_result',
        startTime: new Date(startTime.getTime() + 100),
        durationMs: 0,
        content: { toolName, toolResultContent: 'Finished', tokenCount: 2 },
        context: 'main',
      },
    ],
    tokens: { input: 0, output: 0, cached: 0 },
    summary: {
      toolCallCount: 1,
      outputMessageCount: 0,
      subagentCount: 0,
      totalDurationMs: 100,
      totalTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    },
    status: 'complete',
    processes: [],
    chunkId: 'chunk-1',
    metrics: {
      durationMs: 100,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      messageCount: 0,
    },
    responses: [],
  };
}

describe('processSessionContextWithPhases', () => {
  it.each([
    ['Task', 'Task (Subagent)'],
    ['Agent', 'Agent (Subagent)'],
  ])('uses the subagent context label for %s', (toolName, expectedLabel) => {
    const aiGroup = createAIGroup(toolName);
    const items: ChatItem[] = [{ type: 'ai', group: aiGroup }];

    const { statsMap } = processSessionContextWithPhases(items, '/project');
    const toolOutput = statsMap
      .get(aiGroup.id)
      ?.newInjections.find((injection) => injection.category === 'tool-output');

    expect(toolOutput?.category).toBe('tool-output');
    if (toolOutput?.category === 'tool-output') {
      expect(toolOutput.toolBreakdown).toHaveLength(1);
      expect(toolOutput.toolBreakdown[0].toolName).toBe(expectedLabel);
    }
  });
});
