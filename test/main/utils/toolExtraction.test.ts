import { describe, expect, it } from 'vitest';

import { extractToolCalls } from '../../../src/main/utils/toolExtraction';

describe('extractToolCalls', () => {
  it.each(['Task', 'Agent'])('classifies %s as a child spawn and retains metadata', (name) => {
    const [toolCall] = extractToolCalls([
      {
        type: 'tool_use',
        id: `${name.toLowerCase()}-1`,
        name,
        input: {
          description: 'Inspect the parser',
          subagent_type: 'Explore',
          prompt: 'Find the relevant code',
        },
      },
    ]);

    expect(toolCall).toMatchObject({
      name,
      isTask: true,
      taskDescription: 'Inspect the parser',
      taskSubagentType: 'Explore',
    });
  });

  it('keeps ordinary and coordination tools classified as regular tools', () => {
    const toolCalls = extractToolCalls([
      { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_use', id: 'task-create-1', name: 'TaskCreate', input: {} },
    ]);

    expect(toolCalls.map(({ name, isTask }) => ({ name, isTask }))).toEqual([
      { name: 'Read', isTask: false },
      { name: 'TaskCreate', isTask: false },
    ]);
    expect(toolCalls[0]).not.toHaveProperty('taskDescription');
    expect(toolCalls[1]).not.toHaveProperty('taskSubagentType');
  });
});
