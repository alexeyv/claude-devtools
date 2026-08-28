import { describe, expect, it } from 'vitest';

import { buildToolExecutions } from '../../../../src/main/services/analysis/ToolExecutionBuilder';
import type { ParsedMessage, ToolCall, ToolResult } from '../../../../src/main/types';

function createMessage(overrides: Partial<ParsedMessage>): ParsedMessage {
  return {
    uuid: 'message',
    parentUuid: null,
    type: 'assistant',
    timestamp: new Date('2026-08-16T10:00:00Z'),
    content: '',
    isSidechain: false,
    isMeta: false,
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

function toolCall(id: string): ToolCall {
  return { id, name: 'Read', input: { file_path: id }, isTask: false };
}

function toolResult(toolUseId: string): ToolResult {
  return { toolUseId, content: `result for ${toolUseId}`, isError: false };
}

describe('buildToolExecutions', () => {
  it('pairs each result by tool_use_id when one message carries several results', () => {
    const messages = [
      createMessage({
        uuid: 'a1',
        toolCalls: [toolCall('tool-a'), toolCall('tool-b')],
      }),
      createMessage({
        uuid: 'r1',
        type: 'user',
        isMeta: true,
        timestamp: new Date('2026-08-16T10:00:05Z'),
        sourceToolUseID: 'tool-b',
        toolResults: [toolResult('tool-a'), toolResult('tool-b')],
      }),
    ];

    const executions = buildToolExecutions(messages);

    expect(executions).toHaveLength(2);
    const byId = new Map(executions.map((e) => [e.toolCall.id, e]));
    expect(byId.get('tool-a')?.result?.toolUseId).toBe('tool-a');
    expect(byId.get('tool-b')?.result?.toolUseId).toBe('tool-b');
    expect(byId.get('tool-b')?.durationMs).toBe(5000);
  });

  it('reports a zero duration instead of NaN when a timestamp is invalid', () => {
    const messages = [
      createMessage({ uuid: 'a1', toolCalls: [toolCall('tool-a')], timestamp: new Date(NaN) }),
      createMessage({
        uuid: 'r1',
        type: 'user',
        isMeta: true,
        sourceToolUseID: 'tool-a',
        toolResults: [toolResult('tool-a')],
      }),
    ];

    const [execution] = buildToolExecutions(messages);
    expect(execution.durationMs).toBe(0);
  });

  it('keeps calls without results', () => {
    const executions = buildToolExecutions([
      createMessage({ uuid: 'a1', toolCalls: [toolCall('tool-a')] }),
    ]);
    expect(executions).toHaveLength(1);
    expect(executions[0].result).toBeUndefined();
  });
});
