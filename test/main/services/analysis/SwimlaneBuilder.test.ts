import { describe, expect, it } from 'vitest';

import { buildSwimlane } from '../../../../src/main/services/analysis/SwimlaneBuilder';
import { SWIMLANE_SCHEMA_VERSION } from '../../../../src/main/types';
import type {
  Chunk,
  ParsedMessage,
  Process,
  SessionMetrics,
  ToolCall,
} from '../../../../src/main/types';

const baseTime = new Date('2026-08-16T10:00:00.000Z').getTime();

function at(seconds: number): Date {
  return new Date(baseTime + seconds * 1000);
}

function metrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    durationMs: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    messageCount: 0,
    ...overrides,
  };
}

function message(
  uuid: string,
  seconds: number,
  overrides: Partial<ParsedMessage> = {}
): ParsedMessage {
  return {
    uuid,
    parentUuid: null,
    type: 'assistant',
    timestamp: at(seconds),
    content: [{ type: 'text', text: uuid }],
    isSidechain: false,
    isMeta: false,
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

function process(
  id: string,
  start: number,
  end: number,
  overrides: Partial<Process> = {}
): Process {
  return {
    id,
    filePath: `/tmp/${id}.jsonl`,
    messages: [],
    startTime: at(start),
    endTime: at(end),
    durationMs: (end - start) * 1000,
    metrics: metrics(),
    isParallel: false,
    ...overrides,
  };
}

function spawnCall(id: string): ToolCall {
  return {
    id,
    name: 'Agent',
    input: { description: id, subagent_type: 'general-purpose' },
    isTask: true,
    taskDescription: id,
    taskSubagentType: 'general-purpose',
  };
}

function segmentTypes(model: ReturnType<typeof buildSwimlane>): string[] {
  return model.parentSegments.map((segment) => segment.type);
}

describe('buildSwimlane', () => {
  it('stamps the projection and keeps every serialized parent interval inside its axis', () => {
    const model = buildSwimlane(
      [],
      [process('axis-child', -2, 6)],
      [message('axis-start', 0), message('axis-end', 4, { type: 'system' })]
    );
    const serialized = JSON.parse(JSON.stringify(model)) as typeof model;
    const axisStart = new Date(serialized.startTime).getTime();
    const axisEnd = new Date(serialized.endTime).getTime();

    expect(model.schemaVersion).toBe(SWIMLANE_SCHEMA_VERSION);
    expect(serialized.schemaVersion).toBe(SWIMLANE_SCHEMA_VERSION);
    expect(serialized.durationMs).toBe(axisEnd - axisStart);
    for (const segment of serialized.parentSegments) {
      const start = new Date(segment.startTime).getTime();
      const end = new Date(segment.endTime).getTime();
      expect(start).toBeGreaterThanOrEqual(axisStart);
      expect(end).toBeLessThanOrEqual(axisEnd);
      expect(segment.durationMs).toBe(end - start);
    }
  });

  it('projects exact parent and existing-card child targets without timing fallbacks', () => {
    const parentMessage = message('owned-work', 0, {
      requestId: 'owned-request',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const root = process('root-card', 1, 3, { parentTaskId: 'spawn-root' });
    const nestedWithCard = process('nested-card', 2, 4, { parentTaskId: 'spawn-nested' });
    const noCard = process('no-card', 4, 5);
    const chunk: Chunk = {
      id: 'ai-owned-work',
      chunkType: 'ai',
      responses: [parentMessage],
      processes: [root, nestedWithCard],
      sidechainMessages: [],
      toolExecutions: [],
      startTime: at(0),
      endTime: at(4),
      durationMs: 4000,
      metrics: metrics(),
    };

    const model = buildSwimlane([chunk], [root, nestedWithCard, noCard], [parentMessage]);

    expect(
      model.parentSegments.find((segment) => segment.type === 'assistant-output')?.target
    ).toEqual({ kind: 'turn', groupId: chunk.id });
    expect(model.childRows.find((row) => row.id === root.id)?.activations[0].target).toEqual({
      kind: 'subagent',
      groupId: chunk.id,
      processId: root.id,
      spawnId: 'spawn-root',
    });
    expect(
      model.childRows.find((row) => row.id === nestedWithCard.id)?.activations[0].target
    ).toEqual({
      kind: 'subagent',
      groupId: chunk.id,
      processId: nestedWithCard.id,
      spawnId: 'spawn-nested',
    });
    expect(
      model.childRows.find((row) => row.id === noCard.id)?.activations[0].target
    ).toBeUndefined();
  });

  it('projects a timing-linked orphan process to its rendered empty-spawn card identity', () => {
    const orphan = process('timing-linked-card', 2, 4);
    const chunk: Chunk = {
      id: 'ai-timing-owner',
      chunkType: 'ai',
      responses: [message('timing-owner-work', 1)],
      processes: [orphan],
      sidechainMessages: [],
      toolExecutions: [],
      startTime: at(1),
      endTime: at(5),
      durationMs: 4000,
      metrics: metrics(),
    };

    const model = buildSwimlane([chunk], [orphan], chunk.responses);

    expect(model.childRows[0].activations[0].target).toEqual({
      kind: 'subagent',
      groupId: chunk.id,
      processId: orphan.id,
      spawnId: '',
    });
  });

  it('keeps clicked continuation identity and drops ambiguous ownership candidates', () => {
    const first = process('continued-first', 1, 2, {
      parentTaskId: 'spawn-first',
      messages: [message('continued-link', 1, { isSidechain: true })],
    });
    const continuation = process('continued-next', 3, 4, {
      parentTaskId: 'spawn-next',
      messages: [
        message('continued-next-message', 3, {
          isSidechain: true,
          parentUuid: 'continued-link',
        }),
      ],
    });
    const ambiguous = process('ambiguous-card', 5, 6, { parentTaskId: 'spawn-ambiguous' });
    const makeChunk = (id: string, ownedProcesses: Process[]): Chunk => ({
      id,
      chunkType: 'ai',
      responses: [],
      processes: ownedProcesses,
      sidechainMessages: [],
      toolExecutions: [],
      startTime: at(0),
      endTime: at(6),
      durationMs: 6000,
      metrics: metrics(),
    });

    const model = buildSwimlane(
      [
        makeChunk('ai-owner', [first, continuation, ambiguous, ambiguous]),
        makeChunk('ai-other-owner', [ambiguous]),
      ],
      [first, continuation, ambiguous],
      []
    );
    const continuedRow = model.childRows.find((row) => row.id === first.id);

    expect(continuedRow?.activations.map((activation) => activation.target)).toEqual([
      {
        kind: 'subagent',
        groupId: 'ai-owner',
        processId: first.id,
        spawnId: 'spawn-first',
      },
      {
        kind: 'subagent',
        groupId: 'ai-owner',
        processId: continuation.id,
        spawnId: 'spawn-next',
      },
    ]);
    expect(
      model.childRows.find((row) => row.id === ambiguous.id)?.activations[0].target
    ).toBeUndefined();
  });

  it('keeps assistant output at request-group time and leaves unlinked child silence unattributed', () => {
    const parent = [
      message('work-1-stream', 0, {
        requestId: 'request-1',
        usage: { input_tokens: 2, output_tokens: 1 },
      }),
      message('work-1-final', 1, {
        requestId: 'request-1',
        usage: {
          input_tokens: 7,
          output_tokens: 5,
          cache_read_input_tokens: 11,
          cache_creation_input_tokens: 13,
        },
      }),
      message('work-2', 6, { usage: { input_tokens: 3, output_tokens: 2 } }),
    ];
    const child = process('child-1', 2, 5);

    const model = buildSwimlane([], [child], parent);

    expect(model.startTime).toEqual(at(0));
    expect(model.endTime).toEqual(at(6));
    expect(segmentTypes(model)).toEqual(['assistant-output', 'unattributed']);
    const requestOutput = model.parentSegments.find((segment) => segment.requestId === 'request-1');
    expect(requestOutput).toMatchObject({
      startTime: at(0),
      endTime: at(1),
      durationMs: 1000,
      metrics: {
        inputTokens: 7,
        outputTokens: 5,
        cacheReadTokens: 11,
        cacheCreationTokens: 13,
      },
    });
  });

  it('derives observed model response and exact tool execution from causal message links', () => {
    const toolCall: ToolCall = {
      id: 'read-1',
      name: 'Read',
      input: { file_path: '/tmp/example' },
      isTask: false,
    };
    const messages = [
      message('submission', 0, { type: 'user', content: 'start' }),
      message('request-one-first', 2, {
        parentUuid: 'submission',
        requestId: 'request-one',
      }),
      message('request-one-last', 4, {
        parentUuid: 'submission',
        requestId: 'request-one',
        toolCalls: [toolCall],
      }),
      message('read-result', 4.005, {
        type: 'user',
        isMeta: true,
        parentUuid: 'request-one-last',
        toolResults: [{ toolUseId: toolCall.id, content: 'done', isError: false }],
      }),
      message('request-two-first', 6, {
        parentUuid: 'read-result',
        requestId: 'request-two',
      }),
    ];

    const model = buildSwimlane([], [], messages);

    expect(
      model.evidence.map((evidence) => [evidence.type, evidence.startTime, evidence.endTime])
    ).toEqual([
      ['model-response', at(0), at(2)],
      ['assistant-output', at(2), at(4)],
      ['tool-execution', at(4), at(4.005)],
      ['model-response', at(4.005), at(6)],
      ['assistant-output', at(6), at(6)],
    ]);
    expect(model.evidence.find((evidence) => evidence.toolUseId === toolCall.id)).toMatchObject({
      durationMs: 5,
      startMessageId: 'request-one-last',
      endMessageId: 'read-result',
    });
    expect(
      model.parentSegments.map((segment) => [segment.type, segment.startTime, segment.endTime])
    ).toEqual([
      ['model-response', at(0), at(2)],
      ['assistant-output', at(2), at(4)],
      ['tool-execution', at(4), at(4.005)],
      ['model-response', at(4.005), at(6)],
      ['assistant-output', at(6), at(6)],
    ]);
  });

  it('attributes linked child activity once while retaining the exact enclosing tool span', () => {
    const spawn = spawnCall('linked-child');
    const child = process('linked-process', 1, 3, { parentTaskId: spawn.id });
    const model = buildSwimlane(
      [],
      [child],
      [
        message('spawn-call', 0, { requestId: 'spawn-request', toolCalls: [spawn] }),
        message('spawn-result', 4, {
          type: 'user',
          isMeta: true,
          sourceToolUseID: spawn.id,
          toolResults: [{ toolUseId: spawn.id, content: 'done', isError: false }],
        }),
      ]
    );

    expect(
      model.parentSegments
        .filter((segment) => segment.durationMs > 0)
        .map((segment) => [segment.type, segment.startTime, segment.endTime])
    ).toEqual([
      ['tool-execution', at(0), at(1)],
      ['child-wait', at(1), at(3)],
      ['tool-execution', at(3), at(4)],
    ]);
    expect(model.evidence.find((evidence) => evidence.toolUseId === spawn.id)).toMatchObject({
      type: 'tool-execution',
      durationMs: 4000,
    });
    expect(model.parentSegments.reduce((sum, segment) => sum + segment.durationMs, 0)).toBe(4000);
  });

  it('requires a matched task span, clamps child bounds, and rejects disconnected nesting', () => {
    const matched = spawnCall('matched-spawn');
    const identitySpawn = spawnCall('identity-spawn');
    const unmatched = spawnCall('unmatched-spawn');
    const nestedSpawn = spawnCall('disconnected-nested-spawn');
    const clamped = process('clamped-child', -2, 6, { parentTaskId: matched.id });
    const identityChild = process('identity-child', 1, 2);
    const unmatchedChild = process('unmatched-child', 5, 7, { parentTaskId: unmatched.id });
    const invalidChild = process('invalid-linked-child', 0, 0, {
      parentTaskId: matched.id,
      startTime: new Date(Number.NaN),
      endTime: new Date(Number.NaN),
    });
    const disconnectedOwner = process('disconnected-owner', 0, 3, {
      messages: [
        message('disconnected-call', 0, {
          isSidechain: true,
          toolCalls: [nestedSpawn],
        }),
        message('disconnected-result', 3, {
          type: 'user',
          isMeta: true,
          isSidechain: true,
          sourceToolUseID: nestedSpawn.id,
          toolResults: [{ toolUseId: nestedSpawn.id, content: 'done', isError: false }],
        }),
      ],
    });
    const disconnectedNested = process('disconnected-nested', 1, 2, {
      parentTaskId: nestedSpawn.id,
    });
    const model = buildSwimlane(
      [],
      [clamped, identityChild, unmatchedChild, invalidChild, disconnectedOwner, disconnectedNested],
      [
        message('matched-call', 0, { toolCalls: [matched, identitySpawn] }),
        message('matched-result', 4, {
          type: 'user',
          isMeta: true,
          sourceToolUseID: matched.id,
          toolResults: [{ toolUseId: matched.id, content: 'done', isError: false }],
        }),
        message('identity-result', 4, {
          type: 'user',
          isMeta: true,
          sourceToolUseID: identitySpawn.id,
          toolUseResult: { agentId: identityChild.id, toolUseId: identitySpawn.id },
        }),
        message('unmatched-call', 5, { toolCalls: [unmatched] }),
      ]
    );

    expect(model.evidence.filter((evidence) => evidence.type === 'child-wait')).toEqual([
      expect.objectContaining({
        processId: clamped.id,
        toolUseId: matched.id,
        startTime: at(0),
        endTime: at(4),
        durationMs: 4000,
      }),
      expect.objectContaining({
        processId: identityChild.id,
        toolUseId: identitySpawn.id,
        startTime: at(1),
        endTime: at(2),
        durationMs: 1000,
      }),
    ]);
  });

  it('does not treat parent-linked command output as a human resume or model submission', () => {
    const model = buildSwimlane(
      [],
      [],
      [
        message('prior-assistant', 0, { requestId: 'prior' }),
        message('command-output', 5, {
          type: 'user',
          content: '<local-command-stdout>done</local-command-stdout>',
          parentUuid: 'prior-assistant',
        }),
        message('after-command', 7, {
          requestId: 'after-command',
          parentUuid: 'command-output',
        }),
      ]
    );

    expect(
      model.evidence.filter(
        (evidence) => evidence.type === 'human-wait' || evidence.type === 'model-response'
      )
    ).toEqual([]);
  });

  it('does not stretch unmatched tools or manufacture response latency without a parent link', () => {
    const unmatched: ToolCall = {
      id: 'unmatched',
      name: 'Read',
      input: {},
      isTask: false,
    };
    const model = buildSwimlane(
      [],
      [],
      [
        message('orphan-request', 1, {
          requestId: 'orphan',
          toolCalls: [unmatched],
        }),
        message('axis-end', 5, { type: 'system' }),
      ]
    );

    expect(model.evidence.map((evidence) => evidence.type)).toEqual(['assistant-output']);
    expect(
      model.parentSegments.some(
        (segment) =>
          segment.type === 'unattributed' &&
          segment.startTime.getTime() === at(1).getTime() &&
          segment.endTime.getTime() === at(5).getTime()
      )
    ).toBe(true);
  });

  it('targets the exact owner for nonzero ranged work with same-request responses', () => {
    const responses = [
      message('ranged-stream', 3, {
        requestId: 'request-ranged',
        usage: { input_tokens: 2, output_tokens: 1 },
      }),
      message('ranged-final', 7, {
        requestId: 'request-ranged',
        usage: { input_tokens: 8, output_tokens: 5 },
      }),
    ];
    const chunk: Chunk = {
      id: 'ai-ranged-owner',
      chunkType: 'ai',
      responses,
      processes: [],
      sidechainMessages: [],
      toolExecutions: [],
      startTime: at(3),
      endTime: at(7),
      durationMs: 4000,
      metrics: metrics(),
    };

    const model = buildSwimlane([chunk], [], responses);
    const rangedWork = model.parentSegments.find(
      (segment) => segment.requestId === 'request-ranged'
    );

    expect(rangedWork).toMatchObject({
      startTime: at(3),
      endTime: at(7),
      durationMs: 4000,
      target: { kind: 'turn', groupId: chunk.id },
    });
  });

  it('pairs explicit AskUserQuestion marks without stretching an unanswered ask', () => {
    const askCall = {
      id: 'ask-1',
      name: 'AskUserQuestion',
      input: { questions: [] },
      isTask: false,
    };
    const paired = buildSwimlane(
      [],
      [],
      [
        message('ask-message', 0, { toolCalls: [askCall] }),
        message('answer-message', 5, {
          type: 'user',
          isMeta: true,
          content: [{ type: 'tool_result', tool_use_id: 'ask-1', content: 'answer' }],
          toolResults: [{ toolUseId: 'ask-1', content: 'answer', isError: false }],
        }),
        message('after-answer', 7),
      ]
    );

    expect(paired.hitlMarks.map((mark) => mark.type)).toEqual(['ask', 'answer']);
    expect(
      paired.parentSegments.find(
        (segment) =>
          segment.type === 'human-wait' &&
          segment.startTime.getTime() === at(0).getTime() &&
          segment.endTime.getTime() === at(5).getTime()
      )
    ).toBeDefined();

    const unanswered = buildSwimlane(
      [],
      [],
      [
        message('open-ask', 0, { toolCalls: [{ ...askCall, id: 'ask-open' }] }),
        message('axis-end', 9, { type: 'system' }),
      ]
    );
    expect(unanswered.hitlMarks).toHaveLength(1);
    expect(unanswered.parentSegments.some((segment) => segment.type === 'human-wait')).toBe(false);
    expect(unanswered.parentSegments.some((segment) => segment.type === 'unattributed')).toBe(true);
    expect(unanswered.endTime).toEqual(at(9));
  });

  it('uses human wait before child wait, then resumes child wait after the answer', () => {
    const ask = {
      id: 'ask-overlap',
      name: 'AskUserQuestion',
      input: {},
      isTask: false,
    };
    const childSpawn = spawnCall('child-spawn');
    const model = buildSwimlane(
      [],
      [process('child-overlap', 1, 4, { parentTaskId: childSpawn.id })],
      [
        message('ask', 0, { toolCalls: [ask, childSpawn] }),
        message('answer', 3, {
          type: 'user',
          isMeta: true,
          content: [{ type: 'tool_result', tool_use_id: ask.id, content: 'done' }],
          toolResults: [{ toolUseId: ask.id, content: 'done', isError: false }],
        }),
        message('child-result', 4, {
          type: 'user',
          isMeta: true,
          sourceToolUseID: childSpawn.id,
          toolResults: [{ toolUseId: childSpawn.id, content: 'done', isError: false }],
        }),
        message('later-work', 5),
      ]
    );

    const waitSegments = model.parentSegments.filter(
      (segment) => segment.type !== 'assistant-output'
    );
    expect(
      waitSegments.map((segment) => [segment.type, segment.startTime, segment.endTime])
    ).toEqual([
      ['human-wait', at(0), at(3)],
      ['child-wait', at(3), at(4)],
      ['unattributed', at(4), at(5)],
    ]);
  });

  it('classifies only parent-linked later user resumes as human wait', () => {
    const model = buildSwimlane(
      [],
      [],
      [
        message('initial-user', -1, { type: 'user', content: 'start' }),
        message('prior-work', 0),
        message('resume', 5, { type: 'user', content: 'continue', parentUuid: 'prior-work' }),
        message('next-work', 7),
        message('final-axis', 10, { type: 'system' }),
      ]
    );

    expect(model.hitlMarks.map((mark) => mark.type)).toEqual(['resume-start', 'resume']);
    expect(
      model.parentSegments.some(
        (segment) =>
          segment.type === 'human-wait' &&
          segment.startTime.getTime() === at(0).getTime() &&
          segment.endTime.getTime() === at(5).getTime()
      )
    ).toBe(true);
    expect(
      model.parentSegments.some(
        (segment) =>
          segment.type === 'unattributed' &&
          segment.startTime.getTime() === at(5).getTime() &&
          segment.endTime.getTime() === at(10).getTime()
      )
    ).toBe(true);
  });

  it('nests by spawn result identity and collapses continuation activations with own metrics', () => {
    const rootSpawn = spawnCall('spawn-child');
    const parallelSpawn = spawnCall('spawn-parallel');
    const nestedSpawn = spawnCall('spawn-grandchild');
    const rootMessages = [
      message('root-spawn', 0, { toolCalls: [rootSpawn, parallelSpawn] }),
      message('root-result', 1, {
        type: 'user',
        isMeta: true,
        sourceToolUseID: rootSpawn.id,
        toolUseResult: { agentId: 'child-a' },
      }),
      message('root-parallel-result', 1.1, {
        type: 'user',
        isMeta: true,
        sourceToolUseID: parallelSpawn.id,
        toolUseResult: { agentId: 'child-b' },
      }),
    ];
    const firstActivationMessages = [
      message('child-first', 2, { isSidechain: true, type: 'user' }),
      message('child-spawn', 3, { isSidechain: true, toolCalls: [nestedSpawn] }),
      message('child-last', 4, {
        isSidechain: true,
        type: 'user',
        sourceToolUseID: nestedSpawn.id,
        toolUseResult: { agentId: 'grandchild' },
      }),
    ];
    const childMetrics = metrics({
      totalTokens: 34,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 12,
      cacheCreationTokens: 8,
    });
    const continuationMetrics = metrics({ totalTokens: 8, inputTokens: 3, outputTokens: 5 });
    const childFirst = process('child-a', 2, 4, {
      parentTaskId: rootSpawn.id,
      messages: firstActivationMessages,
      metrics: childMetrics,
      mainSessionImpact: { callTokens: 999, resultTokens: 999, totalTokens: 1998 },
    });
    const childContinuation = process('child-a-continuation', 8, 9, {
      messages: [
        message('child-continuation', 8, {
          isSidechain: true,
          type: 'user',
          parentUuid: 'child-last',
        }),
      ],
      metrics: continuationMetrics,
    });
    const grandchild = process('grandchild', 3.5, 6, {
      // Resolver enrichment is deliberately misleading; identity evidence above wins.
      parentTaskId: rootSpawn.id,
      messages: [message('grandchild-message', 3.5, { isSidechain: true, type: 'user' })],
    });
    const parallelChild = process('child-b', 2.5, 5, {
      isParallel: true,
      messages: [message('parallel-message', 2.5, { isSidechain: true, type: 'user' })],
    });

    const model = buildSwimlane(
      [],
      [childFirst, grandchild, parallelChild, childContinuation],
      rootMessages
    );

    expect(model.childRows).toHaveLength(3);
    const childRow = model.childRows[0];
    const grandchildRow = model.childRows[1];
    const parallelRow = model.childRows[2];
    expect(childRow).toMatchObject({ id: 'child-a', parentRowId: null, depth: 0 });
    expect(childRow.activations.map((activation) => activation.processId)).toEqual([
      'child-a',
      'child-a-continuation',
    ]);
    expect(childRow.activations[0].metrics).toEqual(childMetrics);
    expect(childRow.activations[1].metrics).toEqual(continuationMetrics);
    expect(grandchildRow).toMatchObject({
      id: 'grandchild',
      parentRowId: 'child-a',
      depth: 1,
    });
    expect(parallelRow).toMatchObject({ id: 'child-b', parentRowId: null, depth: 0 });
    expect(
      model.parentSegments.some(
        (segment) =>
          segment.type === 'unattributed' &&
          segment.startTime.getTime() === at(1.1).getTime() &&
          segment.endTime.getTime() === at(9).getTime()
      )
    ).toBe(true);
    expect(JSON.parse(JSON.stringify(model))).not.toHaveProperty('childRows.0.messages');
  });

  it('uses the closest owning spawn as a nesting fallback when result identity is absent', () => {
    const rootSpawn = spawnCall('root-spawn-fallback');
    const nestedSpawn = spawnCall('nested-spawn-fallback');
    const rootMessages = [
      message('root-spawn-message', 0, { toolCalls: [rootSpawn] }),
      message('root-spawn-result', 1, {
        type: 'user',
        isMeta: true,
        sourceToolUseID: rootSpawn.id,
        toolUseResult: { agentId: 'fallback-parent' },
      }),
    ];
    const parent = process('fallback-parent', 2, 4, {
      messages: [
        message('fallback-parent-start', 2, { isSidechain: true, type: 'user' }),
        message('fallback-nested-spawn', 3, {
          isSidechain: true,
          toolCalls: [nestedSpawn],
        }),
      ],
    });
    const nested = process('fallback-nested', 3.5, 5, {
      parentTaskId: rootSpawn.id,
      messages: [message('fallback-nested-start', 3.5, { isSidechain: true, type: 'user' })],
    });

    const model = buildSwimlane([], [parent, nested], rootMessages);

    expect(model.childRows.map((row) => [row.id, row.parentRowId, row.depth])).toEqual([
      ['fallback-parent', null, 0],
      ['fallback-nested', 'fallback-parent', 1],
    ]);
  });

  it('consumes each competing fallback spawn at most once across unmatched children', () => {
    const ownerSpawn = spawnCall('spawn-owner');
    const rootFallback = spawnCall('root-fallback');
    const nestedFallback = spawnCall('nested-fallback');
    const rootMessages = [
      message('spawn-owner-message', 0, { toolCalls: [ownerSpawn] }),
      message('spawn-owner-result', 1, {
        type: 'user',
        isMeta: true,
        sourceToolUseID: ownerSpawn.id,
        toolUseResult: { agentId: 'fallback-owner' },
      }),
      message('root-fallback-message', 3.8, { toolCalls: [rootFallback] }),
    ];
    const owner = process('fallback-owner', 2, 6, {
      messages: [
        message('nested-fallback-message', 3, {
          isSidechain: true,
          toolCalls: [nestedFallback],
        }),
      ],
    });
    const first = process('first-unmatched', 4, 4.5);
    const second = process('second-unmatched', 5, 5.5);

    const model = buildSwimlane([], [owner, first, second], rootMessages);
    const rows = new Map(model.childRows.map((row) => [row.id, row]));

    expect(rows.get('first-unmatched')?.parentRowId).toBeNull();
    expect(rows.get('second-unmatched')?.parentRowId).toBe('fallback-owner');
  });

  it('correlates all result-id shapes and preserves identity over competing timing', () => {
    const ownerSpawn = spawnCall('team-owner-spawn');
    const teamSpawn = spawnCall('team-spawn');
    const competingRootSpawn = spawnCall('competing-root-spawn');
    const rootMessages = [
      message('team-owner-call', 0, { toolCalls: [ownerSpawn] }),
      message('team-owner-result', 1, {
        type: 'user',
        isMeta: true,
        toolUseResult: { agentId: 'team-owner', toolUseId: ownerSpawn.id },
      }),
      message('competing-root-call', 3.5, { toolCalls: [competingRootSpawn] }),
    ];
    const owner = process('team-owner', 2, 5, {
      messages: [
        message('team-call', 3, { isSidechain: true, toolCalls: [teamSpawn] }),
        message('team-result', 4, {
          type: 'user',
          isMeta: true,
          isSidechain: true,
          toolResults: [
            { toolUseId: 'unrelated-result', content: '', isError: false },
            { toolUseId: teamSpawn.id, content: '', isError: false },
          ],
          toolUseResult: { agent_id: 'researcher@alpha' },
        }),
      ],
    });
    const teamMember = process('team-file', 4.5, 6, {
      team: { teamName: 'alpha', memberName: 'researcher', memberColor: 'blue' },
    });

    const model = buildSwimlane([], [owner, teamMember], rootMessages);
    const teamRow = model.childRows.find((row) => row.id === 'team-file');

    expect(teamRow).toMatchObject({ parentRowId: 'team-owner', depth: 1, label: 'researcher' });
  });

  it('deduplicates streamed Ask and spawn calls and respects same-time message order', () => {
    const ask = {
      id: 'streamed-ask',
      name: 'AskUserQuestion',
      input: {},
      isTask: false,
    };
    const ownerSpawn = spawnCall('stream-owner');
    const duplicateNestedSpawn = spawnCall('duplicate-nested');
    const rootMessages = [
      message('answer-before-ask', 0, {
        type: 'user',
        isMeta: true,
        toolUseResult: { toolUseId: ask.id },
      }),
      message('ask-stream-1', 0, { toolCalls: [ask] }),
      message('ask-stream-2', 1, { toolCalls: [ask] }),
      message('ask-answer', 5, {
        type: 'user',
        isMeta: true,
        toolUseResult: { toolUseId: ask.id },
      }),
      message('stream-owner-call', 0, { toolCalls: [ownerSpawn] }),
      message('stream-owner-result', 1, {
        type: 'user',
        isMeta: true,
        sourceToolUseID: ownerSpawn.id,
        toolUseResult: { agentId: 'stream-owner' },
      }),
    ];
    const owner = process('stream-owner', 2, 4, {
      messages: [
        message('nested-stream-1', 3, {
          isSidechain: true,
          toolCalls: [duplicateNestedSpawn],
        }),
        message('nested-stream-2', 3.2, {
          isSidechain: true,
          toolCalls: [duplicateNestedSpawn],
        }),
      ],
    });
    const nested = process('stream-nested', 3.5, 4.5);
    const unmatched = process('stream-unmatched', 4.8, 5);

    const model = buildSwimlane([], [owner, nested, unmatched], rootMessages);
    const askMarks = model.hitlMarks.filter((mark) => mark.toolUseId === ask.id);
    const rows = new Map(model.childRows.map((row) => [row.id, row]));

    expect(askMarks.map((mark) => [mark.type, mark.timestamp])).toEqual([
      ['ask', at(0)],
      ['answer', at(5)],
    ]);
    expect(new Set(model.hitlMarks.map((mark) => mark.id)).size).toBe(model.hitlMarks.length);
    expect(rows.get('stream-nested')?.parentRowId).toBe('stream-owner');
    expect(rows.get('stream-unmatched')?.parentRowId).toBeNull();
  });

  it('matches Ask answers across every normalized result and toolUseResult-only id', () => {
    const firstAsk = {
      id: 'ask-normalized-list',
      name: 'AskUserQuestion',
      input: {},
      isTask: false,
    };
    const secondAsk = { ...firstAsk, id: 'ask-tool-use-result' };
    const model = buildSwimlane(
      [],
      [],
      [
        message('first-ask', 0, { toolCalls: [firstAsk] }),
        message('first-answer', 2, {
          type: 'user',
          isMeta: true,
          toolResults: [
            { toolUseId: 'unrelated', content: '', isError: false },
            { toolUseId: firstAsk.id, content: '', isError: false },
          ],
        }),
        message('second-ask', 3, { toolCalls: [secondAsk] }),
        message('second-answer', 6, {
          type: 'user',
          isMeta: true,
          toolUseResult: { toolUseId: secondAsk.id },
        }),
      ]
    );

    expect(model.hitlMarks.map((mark) => [mark.toolUseId, mark.type, mark.timestamp])).toEqual([
      [firstAsk.id, 'ask', at(0)],
      [firstAsk.id, 'answer', at(2)],
      [secondAsk.id, 'ask', at(3)],
      [secondAsk.id, 'answer', at(6)],
    ]);
  });

  it('requires a parent link for later resumes and keeps overlapping human evidence exact', () => {
    const askOne = { id: 'cover-one', name: 'AskUserQuestion', input: {}, isTask: false };
    const askTwo = { id: 'cover-two', name: 'AskUserQuestion', input: {}, isTask: false };
    const covered = buildSwimlane(
      [],
      [],
      [
        message('prior-work', 0),
        message('first-ask', 0, { type: 'system', toolCalls: [askOne] }),
        message('first-answer', 2, {
          type: 'user',
          isMeta: true,
          sourceToolUseID: askOne.id,
        }),
        message('second-ask', 2, { type: 'system', toolCalls: [askTwo] }),
        message('second-answer', 5, {
          type: 'user',
          isMeta: true,
          sourceToolUseID: askTwo.id,
        }),
        message('resume', 5, { type: 'user', content: 'continue' }),
      ]
    );
    expect(covered.hitlMarks.filter((mark) => mark.source === 'linked-resume')).toEqual([]);

    const partialAsk = { id: 'partial', name: 'AskUserQuestion', input: {}, isTask: false };
    const partial = buildSwimlane(
      [],
      [],
      [
        message('partial-work', 0),
        message('partial-ask', 2, { type: 'system', toolCalls: [partialAsk] }),
        message('partial-answer', 4, {
          type: 'user',
          isMeta: true,
          sourceToolUseID: partialAsk.id,
        }),
        message('partial-resume', 5, {
          type: 'user',
          content: 'continue',
          parentUuid: 'partial-work',
        }),
      ]
    );
    expect(
      partial.hitlMarks
        .filter((mark) => mark.source === 'linked-resume')
        .map((mark) => [mark.type, mark.timestamp])
    ).toEqual([
      ['resume-start', at(0)],
      ['resume', at(5)],
    ]);
    expect(
      partial.evidence.find(
        (evidence) => evidence.id === 'human-resume-partial-work-partial-resume'
      )
    ).toMatchObject({ type: 'human-wait', durationMs: 5000 });
  });

  it('uses linked output boundaries and emits unique split-output metrics once', () => {
    const model = buildSwimlane(
      [],
      [],
      [
        message('outer-start', 0, {
          requestId: 'outer',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        message('inner-start', 5, {
          requestId: 'inner',
          usage: { input_tokens: 2, output_tokens: 2 },
        }),
        message('inner-end', 6, {
          requestId: 'inner',
          usage: { input_tokens: 3, output_tokens: 3 },
        }),
        message('outer-end', 7, {
          requestId: 'outer',
          usage: { input_tokens: 4, output_tokens: 4 },
        }),
        message('resume-after-overlap', 8, {
          type: 'user',
          content: 'resume',
          parentUuid: 'outer-end',
        }),
        message('point-one', 9, {
          requestId: 'point-one',
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
        message('point-two', 9, {
          requestId: 'point-two',
          usage: { input_tokens: 2, output_tokens: 0 },
        }),
      ]
    );
    const outputSegments = model.parentSegments.filter(
      (segment) => segment.type === 'assistant-output'
    );
    const inferredStart = model.hitlMarks.find((mark) => mark.type === 'resume-start');

    expect(inferredStart?.timestamp).toEqual(at(7));
    expect(new Set(model.parentSegments.map((segment) => segment.id)).size).toBe(
      model.parentSegments.length
    );
    expect(
      outputSegments.filter((segment) => segment.requestId === 'outer' && segment.metrics)
    ).toHaveLength(1);
    expect(
      outputSegments.filter((segment) => segment.requestId === 'inner' && segment.metrics)
    ).toHaveLength(1);
    const points = outputSegments.filter(
      (segment) => segment.startTime.getTime() === at(9).getTime() && segment.durationMs === 0
    );
    expect(points).toHaveLength(2);
    expect(points.every((segment) => segment.metrics !== undefined)).toBe(true);
  });

  it('expands partial and stale process bounds with valid message timestamps', () => {
    const missingEnd = process('missing-end', 2, 2, {
      endTime: new Date(Number.NaN),
      messages: [message('missing-end-message', 5, { isSidechain: true })],
    });
    const missingStart = process('missing-start', 7, 7, {
      startTime: new Date(Number.NaN),
      messages: [message('missing-start-message', 4, { isSidechain: true })],
    });
    const stale = process('stale-bounds', 3, 4, {
      messages: [message('outside-stale-bounds', 8, { isSidechain: true })],
    });
    const singleEndpoint = process('single-endpoint', 6, 6, {
      endTime: new Date(Number.NaN),
    });

    const model = buildSwimlane([], [missingEnd, missingStart, stale, singleEndpoint], []);
    const rows = new Map(model.childRows.map((row) => [row.id, row]));

    expect(model.startTime).toEqual(at(2));
    expect(model.endTime).toEqual(at(8));
    expect(rows.get('missing-end')?.activations[0]).toMatchObject({
      startTime: at(2),
      endTime: at(5),
    });
    expect(rows.get('missing-start')?.activations[0]).toMatchObject({
      startTime: at(4),
      endTime: at(7),
    });
    expect(rows.get('stale-bounds')?.activations[0].endTime).toEqual(at(8));
    expect(rows.get('single-endpoint')?.activations[0]).toMatchObject({
      startTime: at(6),
      endTime: at(6),
    });
  });

  it('uses ordered continuation endpoints while preserving the chain-root row identity', () => {
    const primary = process('primary-file', 5, 6, {
      messages: [
        message('primary-last', 6, { isSidechain: true }),
        message('primary-first', 5, { isSidechain: true }),
      ],
    });
    const continuation = process('continuation-file', 1, 2, {
      description: 'Continued child',
      messages: [
        message('continuation-first', 1, {
          isSidechain: true,
          parentUuid: 'primary-last',
        }),
      ],
    });

    const model = buildSwimlane([], [continuation, primary], []);
    const row = model.childRows[0];

    expect(model.childRows).toHaveLength(1);
    expect(row).toMatchObject({ id: 'primary-file', label: 'Continued child' });
    expect(row.activations.map((activation) => activation.processId)).toEqual([
      'continuation-file',
      'primary-file',
    ]);
    expect(
      model.parentSegments.some(
        (segment) =>
          segment.type === 'unattributed' &&
          segment.startTime.getTime() === at(1).getTime() &&
          segment.endTime.getTime() === at(6).getTime()
      )
    ).toBe(true);
  });

  it('uses deterministic epoch bounds for empty or wholly invalid input', () => {
    const empty = buildSwimlane([], [], []);
    expect(empty).toMatchObject({
      startTime: new Date(0),
      endTime: new Date(0),
      durationMs: 0,
      parentSegments: [],
      hitlMarks: [],
      childRows: [],
    });

    const invalid = buildSwimlane(
      [],
      [],
      [message('invalid', 0, { timestamp: new Date(Number.NaN), type: 'system' })]
    );
    expect(invalid.startTime).toEqual(new Date(0));
    expect(invalid.endTime).toEqual(new Date(0));

    const validParentWithInvalidChild = buildSwimlane(
      [],
      [
        process('invalid-child', 0, 0, {
          startTime: new Date(Number.NaN),
          endTime: new Date(Number.NaN),
        }),
      ],
      [message('valid-parent', 4)]
    );
    expect(validParentWithInvalidChild.startTime).toEqual(at(4));
    expect(validParentWithInvalidChild.endTime).toEqual(at(4));
    expect(validParentWithInvalidChild.childRows[0].activations[0]).toMatchObject({
      startTime: at(4),
      endTime: at(4),
    });
  });
});
