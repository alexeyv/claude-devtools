import { describe, expect, it } from 'vitest';
import {
  buildDisplayItems,
  buildDisplayItemsFromMessages,
} from '../../../src/renderer/utils/displayItemBuilder';
import type { ParsedMessage, Process, SemanticStep } from '../../../src/main/types';

/**
 * Helper to create a minimal ParsedMessage for testing.
 */
function makeMessage(
  overrides: Partial<ParsedMessage> & Pick<ParsedMessage, 'type' | 'content'>
): ParsedMessage {
  return {
    uuid: `msg-${Math.random().toString(36).slice(2, 8)}`,
    parentUuid: null,
    timestamp: new Date('2025-01-01T00:00:00Z'),
    isMeta: false,
    isSidechain: false,
    toolCalls: [],
    toolResults: [],
    ...overrides,
  } as ParsedMessage;
}

function makeProcess(id: string, parentTaskId: string, offsetMs = 0): Process {
  const startTime = new Date(new Date('2025-01-01T00:00:01Z').getTime() + offsetMs);
  return {
    id,
    filePath: `/tmp/${id}.jsonl`,
    messages: [],
    startTime,
    endTime: new Date(startTime.getTime() + 100),
    durationMs: 100,
    metrics: {
      durationMs: 100,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      messageCount: 0,
    },
    description: id,
    isParallel: true,
    parentTaskId,
  };
}

describe('buildDisplayItemsFromMessages', () => {
  describe('subagent tool results with isMeta=false', () => {
    it('should collect tool results from user messages without isMeta field', () => {
      // Simulates real subagent JSONL where user messages with tool_result
      // blocks have isMeta absent (defaults to false after parsing).
      const toolUseId = 'toolu_test123';

      const assistantMsg = makeMessage({
        uuid: 'assistant-1',
        type: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'Bash',
            input: { command: 'echo hello' },
          },
        ],
        timestamp: new Date('2025-01-01T00:00:00Z'),
      });

      // This is the key scenario: user message with tool_result but isMeta: false
      // (simulating subagent JSONL where isMeta field is absent)
      const toolResultMsg = makeMessage({
        uuid: 'user-result-1',
        type: 'user',
        isMeta: false,
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: 'hello\n',
            is_error: false,
          },
        ],
        toolResults: [
          {
            toolUseId: toolUseId,
            content: 'hello\n',
            isError: false,
          },
        ],
        timestamp: new Date('2025-01-01T00:00:01Z'),
      });

      const items = buildDisplayItemsFromMessages([assistantMsg, toolResultMsg], []);

      const toolItems = items.filter((item) => item.type === 'tool');
      expect(toolItems).toHaveLength(1);

      const tool = toolItems[0];
      if (tool.type !== 'tool') throw new Error('Expected tool item');

      // The critical assertion: result must be present, not orphaned
      expect(tool.tool.isOrphaned).toBe(false);
      expect(tool.tool.result).toBeDefined();
      expect(tool.tool.result?.content).toBe('hello\n');
      expect(tool.tool.name).toBe('Bash');
    });

    it('should still render subagent_input for plain text user messages without tool results', () => {
      const userMsg = makeMessage({
        uuid: 'user-input-1',
        type: 'user',
        isMeta: false,
        content: 'Please run the tests',
        toolResults: [],
        timestamp: new Date('2025-01-01T00:00:00Z'),
      });

      const items = buildDisplayItemsFromMessages([userMsg], []);

      const inputItems = items.filter((item) => item.type === 'subagent_input');
      expect(inputItems).toHaveLength(1);
      if (inputItems[0].type !== 'subagent_input') throw new Error('Expected subagent_input');
      expect(inputItems[0].content).toBe('Please run the tests');
    });
  });

  it.each(['Task', 'Agent'])('suppresses a linked %s call in the raw-message path', (name) => {
    const toolUseId = `${name.toLowerCase()}-1`;
    const process = makeProcess('process-1', toolUseId);
    const message = makeMessage({
      type: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name, input: { description: 'Child' } }],
    });

    const items = buildDisplayItemsFromMessages([message], [process]);

    expect(items.filter((item) => item.type === 'tool')).toHaveLength(0);
    expect(items.filter((item) => item.type === 'subagent')).toHaveLength(1);
  });
});

describe('buildDisplayItems', () => {
  it.each(['Agent', 'Task'])(
    'preserves three linked %s children as separate subagent items without raw tools',
    (spawnToolName) => {
      const ids = ['spawn-1', 'spawn-2', 'spawn-3'];
      const processes = ids.map((id, index) => makeProcess(`process-${index + 1}`, id, index));
      const steps: SemanticStep[] = [
        ...ids.map(
          (id, index): SemanticStep => ({
            id,
            type: 'tool_call',
            startTime: new Date(new Date('2025-01-01T00:00:00Z').getTime() + index),
            durationMs: 0,
            content: { toolName: spawnToolName, toolInput: { description: id } },
            context: 'main',
          })
        ),
        ...processes.map(
          (process): SemanticStep => ({
            id: `subagent-${process.id}`,
            type: 'subagent',
            startTime: process.startTime,
            durationMs: process.durationMs,
            content: { subagentId: process.id },
            context: 'main',
          })
        ),
      ];

      const items = buildDisplayItems(steps, null, processes);

      expect(items.filter((item) => item.type === 'tool')).toHaveLength(0);
      expect(
        items
          .filter((item) => item.type === 'subagent')
          .map((item) => (item.type === 'subagent' ? item.subagent.id : null))
      ).toEqual(['process-1', 'process-2', 'process-3']);
    }
  );
});
