import { describe, expect, it } from 'vitest';

import { buildGroups } from '../../../../src/main/services/analysis/ConversationGroupBuilder';
import { extractToolCalls, extractToolResults } from '../../../../src/main/utils/toolExtraction';
import type { ContentBlock, ParsedMessage, Process } from '../../../../src/main/types';

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

function createProcess(id: string, parentTaskId: string, offsetMs: number): Process {
  const startTime = new Date(new Date('2026-08-16T10:00:01Z').getTime() + offsetMs);
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

describe('buildGroups', () => {
  it.each(['Agent', 'Task'])(
    'groups parallel %s spawns as distinct task executions while retaining ordinary tools',
    (spawnToolName) => {
      const spawnIds = ['spawn-1', 'spawn-2', 'spawn-3'];
      const toolBlocks: ContentBlock[] = [
        ...spawnIds.map((id) => ({
          type: 'tool_use' as const,
          id,
          name: spawnToolName,
          input: { description: id, subagent_type: 'general-purpose' },
        })),
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'src/a.ts' } },
      ];
      const assistant = createMessage({
        uuid: 'assistant',
        type: 'assistant',
        timestamp: new Date('2026-08-16T10:00:01Z'),
        content: toolBlocks,
        toolCalls: extractToolCalls(toolBlocks),
      });
      const resultMessages = [...spawnIds, 'read-1'].map((toolUseId, index) => {
        const content: ContentBlock[] = [
          { type: 'tool_result', tool_use_id: toolUseId, content: `${toolUseId} done` },
        ];
        return createMessage({
          uuid: `result-${toolUseId}`,
          type: 'user',
          timestamp: new Date(`2026-08-16T10:00:0${index + 2}Z`),
          content,
          isMeta: true,
          sourceToolUseID: toolUseId,
          toolResults: extractToolResults(content),
        });
      });
      const processes = spawnIds.map((id, index) =>
        createProcess(`process-${index + 1}`, id, index)
      );
      const messages = [
        createMessage({
          uuid: 'user',
          type: 'user',
          timestamp: new Date('2026-08-16T10:00:00Z'),
          content: 'Run the children',
        }),
        assistant,
        ...resultMessages,
      ];

      const [group] = buildGroups(messages, processes);

      expect(group.taskExecutions.map((execution) => execution.taskCall.id)).toEqual(spawnIds);
      expect(group.taskExecutions.map((execution) => execution.taskCall.name)).toEqual([
        spawnToolName,
        spawnToolName,
        spawnToolName,
      ]);
      expect(group.taskExecutions.map((execution) => execution.subagent.id)).toEqual([
        'process-1',
        'process-2',
        'process-3',
      ]);
      expect(group.toolExecutions.map((execution) => execution.toolCall.name)).toEqual(['Read']);
    }
  );
});
