import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SwimlaneSurface } from '../../../../src/renderer/components/chat/SwimlaneSurface';

import type { SessionMetrics, SwimlaneModel } from '../../../../src/main/types';

const BASE_TIME = new Date('2026-08-16T12:00:00.000Z').getTime();
const LONG_LABEL = `${'x'.repeat(59)}😀suffix after the first sixty code points`;
let mountedRoot: Root | undefined;

function at(seconds: number, serialized = false): Date {
  const value = new Date(BASE_TIME + seconds * 1000);
  return (serialized ? value.toISOString() : value) as Date;
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

function mixedModel(): SwimlaneModel {
  const workMetrics = metrics({
    durationMs: 2000,
    totalTokens: 2000,
    inputTokens: 1200,
    cacheReadTokens: 500,
    cacheCreationTokens: 200,
    outputTokens: 100,
  });
  const childMetrics = metrics({
    durationMs: 2000,
    totalTokens: 32,
    inputTokens: 10,
    cacheReadTokens: 11,
    cacheCreationTokens: 7,
    outputTokens: 4,
  });
  return {
    startTime: at(0, true),
    endTime: at(10, true),
    durationMs: 10_000,
    parentSegments: [
      {
        id: 'work',
        type: 'work',
        startTime: at(0, true),
        endTime: at(2, true),
        durationMs: 2000,
        metrics: workMetrics,
      },
      {
        id: 'child-wait',
        type: 'child-wait',
        startTime: at(2),
        endTime: at(4),
        durationMs: 2000,
      },
      {
        id: 'hitl-wait',
        type: 'HITL-wait',
        startTime: at(4),
        endTime: at(6),
        durationMs: 2000,
      },
      {
        id: 'idle',
        type: 'idle',
        startTime: at(6),
        endTime: at(10),
        durationMs: 4000,
      },
    ],
    hitlMarks: [
      {
        id: 'ask-start',
        type: 'ask',
        timestamp: at(4),
        source: 'explicit-ask',
      },
      {
        id: 'ask-answer',
        type: 'answer',
        timestamp: at(6),
        source: 'explicit-ask',
      },
      {
        id: 'resume-start',
        type: 'resume-start',
        timestamp: at(7),
        source: 'inferred-resume',
      },
      {
        id: 'resume-end',
        type: 'resume',
        timestamp: at(9),
        source: 'inferred-resume',
      },
    ],
    childRows: [
      {
        id: 'child',
        label: 'Child agent',
        parentRowId: null,
        depth: 0,
        activations: [
          {
            id: 'child-first',
            processId: 'process-first',
            startTime: at(1),
            endTime: at(3),
            durationMs: 2000,
            metrics: childMetrics,
          },
          {
            id: 'child-continuation',
            processId: 'process-continuation',
            startTime: at(8),
            endTime: at(9),
            durationMs: 1000,
            metrics: metrics({ inputTokens: 3, outputTokens: 5, totalTokens: 8 }),
          },
        ],
      },
      {
        id: 'nested',
        label: LONG_LABEL,
        parentRowId: 'child',
        depth: 1,
        activations: [
          {
            id: 'nested-activation',
            processId: 'nested-process',
            startTime: at(2),
            endTime: at(5),
            durationMs: 3000,
            metrics: childMetrics,
          },
        ],
      },
    ],
  };
}

async function render(model: SwimlaneModel): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  mountedRoot = createRoot(host);
  await act(async () => {
    mountedRoot?.render(React.createElement(SwimlaneSurface, { swimlane: model }));
    await Promise.resolve();
  });
  return host;
}

function element(host: HTMLElement, testId: string): HTMLElement {
  const match = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!match) throw new Error(`Missing ${testId}`);
  return match;
}

afterEach(() => {
  act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('SwimlaneSurface', () => {
  it('draws the mixed orchestration matrix on one axis without merging continuations', async () => {
    const host = await render(mixedModel());

    expect(element(host, 'swimlane-horizontal-scroll').style.overflowX).toBe('auto');
    expect(element(host, 'swimlane-clock-canvas').style.minWidth).toBe('904px');

    const work = element(host, 'swimlane-parent-segment-work');
    const childWait = element(host, 'swimlane-parent-segment-child-wait');
    const hitlWait = element(host, 'swimlane-parent-segment-hitl-wait');
    const idle = element(host, 'swimlane-parent-segment-idle');
    expect(work.style.left).toBe('0%');
    expect(work.style.width).toBe('20%');
    expect(work.style.backgroundColor).toBe('var(--color-surface-raised)');
    expect(childWait.style.left).toBe('20%');
    expect(childWait.style.backgroundImage).toContain('repeating-linear-gradient');
    expect(hitlWait.style.left).toBe('40%');
    expect(hitlWait.style.backgroundColor).toBe('var(--warning-bg)');
    expect(idle.style.left).toBe('60%');
    expect(idle.style.backgroundColor).toBe('transparent');

    expect(element(host, 'swimlane-metrics-work').textContent).toBe(
      '2.0s · 1.2k in · 500 cache · 200 write · 100 out'
    );

    const firstActivation = element(host, 'swimlane-activation-child-first');
    const continuation = element(host, 'swimlane-activation-child-continuation');
    const nestedActivation = element(host, 'swimlane-activation-nested-activation');
    expect(firstActivation.style.left).toBe('10%');
    expect(firstActivation.style.width).toBe('20%');
    expect(continuation.style.left).toBe('80%');
    expect(continuation.style.width).toBe('10%');
    expect(nestedActivation.style.left).toBe(childWait.style.left);
    expect(nestedActivation.style.width).toBe('30%');
    expect(host.querySelectorAll('[data-testid^="swimlane-activation-child-"]')).toHaveLength(2);
    expect(element(host, 'swimlane-metrics-child-first').textContent).toBe(
      '2.0s · 10 in · 11 cache · 7 write · 4 out'
    );

    const nestedRow = element(host, 'swimlane-child-row-nested');
    const nestedLabel = nestedRow.firstElementChild as HTMLElement;
    expect(nestedRow.dataset.depth).toBe('1');
    expect(nestedRow.dataset.parentRowId).toBe('child');
    expect(nestedLabel.style.paddingLeft).toBe('28px');
    expect(nestedLabel.textContent).toBe(`${'x'.repeat(59)}😀…`);
    expect(Array.from(nestedLabel.textContent ?? '')).toHaveLength(61);
    expect(nestedLabel.title).toBe(LONG_LABEL);
    expect(element(host, 'swimlane-activation-nested-activation').getAttribute('aria-label')).toBe(
      `${LONG_LABEL} activation: 3.0s · 10 in · 11 cache · 7 write · 4 out`
    );

    for (const [id, left, label] of [
      ['ask-start', '40%', 'ask'],
      ['ask-answer', '60%', 'ask'],
      ['resume-start', '70%', 'resume'],
      ['resume-end', '90%', 'resume'],
    ]) {
      const mark = element(host, `swimlane-mark-${id}`);
      expect(mark.style.left).toBe(left);
      expect(mark.style.backgroundColor).toBe('var(--warning-border)');
      expect(mark.dataset.markLabel).toBe(label);
      expect(mark.textContent).toBe(label);
    }
  });

  it('keeps instant intervals and their complete metrics visible on a zero-length axis', async () => {
    const instantMetrics = metrics({
      inputTokens: 1,
      cacheReadTokens: 2,
      cacheCreationTokens: 3,
      outputTokens: 4,
      totalTokens: 10,
    });
    const model: SwimlaneModel = {
      startTime: at(0),
      endTime: at(0),
      durationMs: 0,
      parentSegments: [
        {
          id: 'instant-work',
          type: 'work',
          startTime: at(0),
          endTime: at(0),
          durationMs: 0,
          metrics: instantMetrics,
        },
      ],
      hitlMarks: [],
      childRows: [
        {
          id: 'instant-child',
          label: 'Instant child',
          parentRowId: null,
          depth: 0,
          activations: [
            {
              id: 'instant-activation',
              processId: 'instant-process',
              startTime: at(0),
              endTime: at(0),
              durationMs: 0,
              metrics: instantMetrics,
            },
          ],
        },
      ],
    };
    const host = await render(model);

    const work = element(host, 'swimlane-parent-segment-instant-work');
    const activation = element(host, 'swimlane-activation-instant-activation');
    const workMetrics = element(host, 'swimlane-metrics-instant-work');
    const activationMetrics = element(host, 'swimlane-metrics-instant-activation');
    expect(work.style.width).toBe('2px');
    expect(activation.style.width).toBe('2px');
    expect(work.style.overflow).toBe('visible');
    expect(activation.style.overflow).toBe('visible');
    expect(workMetrics.style.whiteSpace).toBe('nowrap');
    expect(activationMetrics.style.whiteSpace).toBe('nowrap');
    expect(workMetrics.textContent).toBe('0ms · 1 in · 2 cache · 3 write · 4 out');
    expect(activationMetrics.textContent).toBe('0ms · 1 in · 2 cache · 3 write · 4 out');
    expect(element(host, 'swimlane-axis').textContent).toContain('0ms');
  });

  it('shows the owning token metrics on every split part of a logical work range', async () => {
    const model: SwimlaneModel = {
      startTime: at(0),
      endTime: at(4),
      durationMs: 4000,
      parentSegments: [
        {
          id: 'logical-work',
          type: 'work',
          startTime: at(0),
          endTime: at(2),
          durationMs: 2000,
          metrics: metrics({
            inputTokens: 10,
            cacheReadTokens: 20,
            cacheCreationTokens: 30,
            outputTokens: 40,
            totalTokens: 100,
          }),
        },
        {
          id: 'logical-work-part-2',
          type: 'work',
          startTime: at(2),
          endTime: at(3),
          durationMs: 1000,
        },
        {
          id: 'idle-after-work',
          type: 'idle',
          startTime: at(3),
          endTime: at(4),
          durationMs: 1000,
        },
      ],
      hitlMarks: [],
      childRows: [],
    };
    const host = await render(model);

    expect(element(host, 'swimlane-metrics-logical-work').textContent).toBe(
      '2.0s · 10 in · 20 cache · 30 write · 40 out'
    );
    expect(element(host, 'swimlane-metrics-logical-work-part-2').textContent).toBe(
      '1.0s · 10 in · 20 cache · 30 write · 40 out'
    );
  });

  it('renders a parent-only clock with supplied HITL boundaries and no empty state', async () => {
    const model = mixedModel();
    model.childRows = [];
    const host = await render(model);

    expect(element(host, 'swimlane-axis')).toBeTruthy();
    expect(element(host, 'swimlane-parent-row')).toBeTruthy();
    expect(element(host, 'swimlane-mark-ask-start')).toBeTruthy();
    expect(host.querySelector('[data-testid^="swimlane-child-row-"]')).toBeNull();
    expect(host.querySelector('img, svg')).toBeNull();
    expect(host.textContent).not.toContain('No children');
  });
});
