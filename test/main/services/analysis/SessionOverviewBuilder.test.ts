/**
 * Tests for SessionOverviewBuilder.
 *
 * The overview answers "what am I looking at" for a session from any
 * supported platform: model, directory, start time, duration.
 */

import { describe, expect, it } from 'vitest';

import { buildSessionOverview } from '../../../../src/main/services/analysis/SessionOverviewBuilder';
import type { ParsedMessage } from '../../../../src/main/types';

function message(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    uuid: 'm1',
    parentUuid: null,
    type: 'assistant',
    timestamp: new Date('2026-08-19T10:00:00.000Z'),
    content: [],
    isSidechain: false,
    isMeta: false,
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

describe('buildSessionOverview - identity', () => {
  it('labels the platform it was recorded by', () => {
    const overview = buildSessionOverview([message()], {
      platform: 'codex',
      sessionId: 'thread-1',
    });

    expect(overview.platform).toBe('codex');
    expect(overview.platformLabel).toBe('Codex');
    expect(overview.sessionId).toBe('thread-1');
  });

  it('formats the model for display without losing the raw identifier', () => {
    const overview = buildSessionOverview([message()], {
      platform: 'codex',
      sessionId: 'thread-1',
      model: 'gpt-5.6-sol',
    });

    expect(overview.model).toBe('gpt-5.6-sol');
    expect(overview.modelDisplay).toBe('GPT-5.6-sol');
  });

  it('takes the model from messages when the source does not record one', () => {
    const overview = buildSessionOverview([message({ model: 'claude-opus-4-5-20260101' })], {
      platform: 'claude',
      sessionId: 's1',
    });

    expect(overview.model).toBe('claude-opus-4-5-20260101');
    expect(overview.modelDisplay).toBe('opus4.5');
  });

  it('collects every model used, in order of first use', () => {
    const overview = buildSessionOverview(
      [
        message({ model: 'claude-sonnet-4-5-20250929' }),
        message({ uuid: 'm2', model: 'claude-opus-4-5-20260101' }),
      ],
      { platform: 'claude', sessionId: 's1' }
    );

    expect(overview.modelsUsed).toEqual(['claude-sonnet-4-5-20250929', 'claude-opus-4-5-20260101']);
    // The session-level model still reports the one in effect at the end.
    expect(overview.model).toBe('claude-opus-4-5-20260101');
  });

  it('ignores synthetic placeholder models', () => {
    const overview = buildSessionOverview([message({ model: '<synthetic>' })], {
      platform: 'claude',
      sessionId: 's1',
    });

    expect(overview.model).toBeUndefined();
    expect(overview.modelsUsed).toEqual([]);
  });
});

describe('buildSessionOverview - directory and timing', () => {
  it('recovers cwd and branch from messages when not supplied', () => {
    const overview = buildSessionOverview(
      [message({ cwd: '/Users/alex/src/demo', gitBranch: 'main' })],
      { platform: 'claude', sessionId: 's1' }
    );

    expect(overview.cwd).toBe('/Users/alex/src/demo');
    expect(overview.gitBranch).toBe('main');
  });

  it('prefers the session-level cwd over per-message values', () => {
    const overview = buildSessionOverview([message({ cwd: '/stale/path' })], {
      platform: 'codex',
      sessionId: 'thread-1',
      cwd: '/Users/alex/src/demo',
    });

    expect(overview.cwd).toBe('/Users/alex/src/demo');
  });

  it('spans start to end across the messages', () => {
    const overview = buildSessionOverview(
      [
        message({ timestamp: new Date('2026-08-19T10:00:00.000Z') }),
        message({ uuid: 'm2', timestamp: new Date('2026-08-19T10:05:30.000Z') }),
      ],
      { platform: 'codex', sessionId: 'thread-1' }
    );

    expect(overview.startedAt).toBe('2026-08-19T10:00:00.000Z');
    expect(overview.endedAt).toBe('2026-08-19T10:05:30.000Z');
    expect(overview.durationMs).toBe(330_000);
  });

  it('honours a recorded start earlier than the first message', () => {
    const overview = buildSessionOverview(
      [message({ timestamp: new Date('2026-08-19T10:00:10.000Z') })],
      {
        platform: 'codex',
        sessionId: 'thread-1',
        startedAt: new Date('2026-08-19T10:00:00.000Z'),
      }
    );

    expect(overview.startedAt).toBe('2026-08-19T10:00:00.000Z');
    expect(overview.durationMs).toBe(10_000);
  });

  it('leaves timing undefined for an empty session', () => {
    const overview = buildSessionOverview([], { platform: 'codex', sessionId: 'thread-1' });

    expect(overview.startedAt).toBeUndefined();
    expect(overview.durationMs).toBeUndefined();
    expect(overview.messageCount).toBe(0);
  });
});

describe('buildSessionOverview - subagents', () => {
  it('marks subagent logs and names their parent', () => {
    const overview = buildSessionOverview([message()], {
      platform: 'codex',
      sessionId: 'child-1',
      isSubagent: true,
      agentNickname: 'Mendel',
      parentSessionId: 'thread-1',
    });

    expect(overview.isSubagent).toBe(true);
    expect(overview.agentNickname).toBe('Mendel');
    expect(overview.parentSessionId).toBe('thread-1');
  });

  it('defaults to a main session', () => {
    const overview = buildSessionOverview([message()], {
      platform: 'claude',
      sessionId: 's1',
    });

    expect(overview.isSubagent).toBe(false);
  });
});

describe('buildSessionOverview - totals', () => {
  it('reports total tokens when the session has usage', () => {
    const overview = buildSessionOverview(
      [message({ usage: { input_tokens: 100, output_tokens: 20 } })],
      { platform: 'codex', sessionId: 'thread-1' }
    );

    expect(overview.totalTokens).toBe(120);
  });

  it('omits totals when nothing reported usage', () => {
    const overview = buildSessionOverview([message()], {
      platform: 'codex',
      sessionId: 'thread-1',
    });

    expect(overview.totalTokens).toBeUndefined();
  });
});
