import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SwimlaneSurface } from '../../../../src/renderer/components/chat/SwimlaneSurface';

import type {
  SessionMetrics,
  SwimlaneModel,
  SwimlaneNavigationTarget,
} from '../../../../src/main/types';

const BASE_TIME = new Date('2026-08-16T12:00:00.000Z').getTime();
const FAMILY = '👨‍👩‍👧‍👦';
const LONG_LABEL = `${'x'.repeat(59)}${FAMILY}suffix after sixty graphemes`;
let mountedRoot: Root | undefined;
let clockWidth = 720;
let tooltipWidth = 260;
let tooltipHeight = 180;
let triggerLeft = 200;
let triggerTop = 100;

class MeasuredResizeObserver {
  static instances: MeasuredResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MeasuredResizeObserver.instances.push(this);
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}

  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

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
      { id: 'ask-start', type: 'ask', timestamp: at(4), source: 'explicit-ask' },
      { id: 'ask-answer', type: 'answer', timestamp: at(6), source: 'explicit-ask' },
      { id: 'resume-start', type: 'resume-start', timestamp: at(7), source: 'inferred-resume' },
      { id: 'resume-end', type: 'resume', timestamp: at(9), source: 'inferred-resume' },
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

function percentageWidth(styleWidth: string): number {
  return styleWidth.endsWith('%') ? (Number.parseFloat(styleWidth) / 100) * clockWidth : 2;
}

async function render(
  model: SwimlaneModel,
  onTarget?: (target: SwimlaneNavigationTarget) => void
): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  mountedRoot = createRoot(host);
  await act(async () => {
    mountedRoot?.render(React.createElement(SwimlaneSurface, { swimlane: model, onTarget }));
    await Promise.resolve();
  });
  return host;
}

async function rerender(
  model: SwimlaneModel,
  onTarget?: (target: SwimlaneNavigationTarget) => void
): Promise<void> {
  await act(async () => {
    mountedRoot?.render(React.createElement(SwimlaneSurface, { swimlane: model, onTarget }));
    await Promise.resolve();
  });
}

function element(host: ParentNode, testId: string): HTMLElement {
  const match = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!match) throw new Error(`Missing ${testId}`);
  return match;
}

async function mouseOver(target: HTMLElement): Promise<void> {
  await act(async () => target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
}

async function mouseOut(target: HTMLElement): Promise<void> {
  await act(async () => target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
}

async function focus(target: HTMLElement): Promise<void> {
  await act(async () => target.focus());
}

async function blur(target: HTMLElement): Promise<void> {
  await act(async () => target.blur());
}

async function triggerResizeObservers(): Promise<void> {
  await act(async () => MeasuredResizeObserver.instances.forEach((observer) => observer.trigger()));
}

beforeEach(() => {
  clockWidth = 720;
  tooltipWidth = 260;
  tooltipHeight = 180;
  triggerLeft = 200;
  triggerTop = 100;
  MeasuredResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', MeasuredResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.dataset.testid === 'swimlane-tooltip') {
      return new DOMRect(0, 0, tooltipWidth, tooltipHeight);
    }
    if (this.dataset.clockWidth !== undefined) {
      return new DOMRect(184, 80, clockWidth, 34);
    }
    if (this.dataset.testid?.endsWith('-duration')) {
      return new DOMRect(0, 0, (this.textContent?.length ?? 0) * 6, 12);
    }
    if (
      this.dataset.testid?.startsWith('swimlane-parent-segment-') ||
      this.dataset.testid?.startsWith('swimlane-activation-')
    ) {
      const width = percentageWidth(this.style.width);
      return new DOMRect(triggerLeft, triggerTop, width, 22);
    }
    return new DOMRect(0, 0, 0, 0);
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
});

afterEach(() => {
  act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SwimlaneSurface', () => {
  it('renders compact, strongly differentiated lanes on one shared clock', async () => {
    const host = await render(mixedModel());

    expect(element(host, 'swimlane-horizontal-scroll').style.overflowX).toBe('auto');
    expect(element(host, 'swimlane-clock-canvas').style.minWidth).toBe('904px');
    expect(element(host, 'swimlane-parent-row').style.height).toBe('34px');
    expect(element(host, 'swimlane-child-row-child').style.height).toBe('34px');

    const work = element(host, 'swimlane-parent-segment-work');
    const childWait = element(host, 'swimlane-parent-segment-child-wait');
    const hitlWait = element(host, 'swimlane-parent-segment-hitl-wait');
    const idle = element(host, 'swimlane-parent-segment-idle');
    expect(work.style.left).toBe('0%');
    expect(work.style.width).toBe('20%');
    expect(work.style.overflow).toBe('hidden');
    expect(work.style.backgroundColor).toBe('var(--context-btn-active-bg)');
    expect(childWait.style.backgroundImage).toContain('repeating-linear-gradient');
    expect(childWait.style.backgroundColor).toBe('transparent');
    expect(hitlWait.style.backgroundColor).toBe('var(--warning-bg)');
    expect(idle.style.backgroundColor).toBe('transparent');
    expect(element(host, 'swimlane-parent-segment-work-duration').textContent).toBe('2.0s');
    expect(host.textContent).not.toContain('1.2k in');

    const firstActivation = element(host, 'swimlane-activation-child-first');
    const continuation = element(host, 'swimlane-activation-child-continuation');
    expect(firstActivation.style.left).toBe('10%');
    expect(firstActivation.style.width).toBe('20%');
    expect(firstActivation.style.backgroundColor).toBe('var(--card-header-hover)');
    expect(firstActivation.style.borderColor).toBe('var(--card-separator)');
    expect(continuation.style.left).toBe('80%');
    expect(continuation.style.width).toBe('10%');
    expect(
      host.querySelectorAll(
        '[data-testid^="swimlane-activation-child-"]:not([data-testid$="-duration"])'
      )
    ).toHaveLength(2);

    const nestedRow = element(host, 'swimlane-child-row-nested');
    const nestedLabel = nestedRow.firstElementChild as HTMLElement;
    expect(nestedRow.dataset.depth).toBe('1');
    expect(nestedRow.dataset.parentRowId).toBe('child');
    expect(nestedLabel.style.paddingLeft).toBe('28px');
    expect(nestedLabel.textContent).toContain(`${'x'.repeat(59)}${FAMILY}…`);
    expect(nestedLabel.title).toBe(LONG_LABEL);
    expect(nestedLabel.getAttribute('aria-label')).toBe(LONG_LABEL);
    expect(element(host, 'swimlane-guide-nested-0')).toBeTruthy();

    for (const [id, percentage] of [
      ['ask-start', '40'],
      ['ask-answer', '60'],
      ['resume-start', '70'],
      ['resume-end', '90'],
    ]) {
      const mark = element(host, `swimlane-mark-${id}`);
      expect(mark.getAttribute('role')).toBe('img');
      expect(mark.dataset.clockPercentage).toBe(percentage);
      expect(mark.style.left).toBe(`calc(${percentage}% + 0px)`);
    }
  });

  it('suppresses duration labels by rendered width and reveals them after a real clock resize', async () => {
    const model = mixedModel();
    model.parentSegments = [
      {
        id: 'short-work',
        type: 'work',
        startTime: at(0),
        endTime: at(0.3),
        durationMs: 300,
        metrics: metrics({ inputTokens: 9 }),
      },
    ];
    const host = await render(model);
    const duration = element(host, 'swimlane-parent-segment-short-work-duration');

    expect(MeasuredResizeObserver.instances).toHaveLength(1);
    expect(duration.dataset.labelVisible).toBe('false');
    expect(duration.style.visibility).toBe('hidden');

    clockWidth = 1566;
    await triggerResizeObservers();
    expect(element(host, 'swimlane-parent-segment-short-work-duration').dataset.labelVisible).toBe(
      'false'
    );

    clockWidth = 1600;
    await triggerResizeObservers();

    expect(element(host, 'swimlane-parent-segment-short-work-duration').dataset.labelVisible).toBe(
      'true'
    );
    expect(element(host, 'swimlane-parent-segment-short-work-duration').style.visibility).toBe(
      'visible'
    );
  });

  it('uses exact target-only buttons while pointer details remain informational', async () => {
    const model = mixedModel();
    const parentTarget = { kind: 'turn', groupId: 'ai-work' } as const;
    const childTarget = {
      kind: 'subagent',
      groupId: 'ai-work',
      processId: 'process-first',
      spawnId: 'spawn-first',
    } as const;
    model.parentSegments[0].target = parentTarget;
    model.childRows[0].activations[0].target = childTarget;
    const onTarget = vi.fn();
    const host = await render(model, onTarget);
    const work = element(host, 'swimlane-parent-segment-work');
    const child = element(host, 'swimlane-activation-child-first');
    const silent = element(host, 'swimlane-parent-segment-idle');
    const untargetedChild = element(host, 'swimlane-activation-nested-activation');

    expect(work.tagName).toBe('BUTTON');
    expect(child.tagName).toBe('BUTTON');
    expect(silent.tagName).toBe('DIV');
    expect(untargetedChild.tagName).toBe('DIV');
    expect(work.getAttribute('aria-label')).toBe('Parent work');

    await mouseOver(work);
    const tooltip = element(document, 'swimlane-tooltip');
    expect(tooltip.textContent).toContain('Duration2.0s');
    expect(tooltip.textContent).toContain('Input1,200');
    expect(tooltip.textContent).toContain('Cache read500');
    expect(tooltip.textContent).toContain('Cache write200');
    expect(tooltip.textContent).toContain('Output100');
    expect(work.getAttribute('aria-label')).toBe('Parent work');
    expect(work.getAttribute('aria-describedby')).toBe(tooltip.id);
    await mouseOut(work);

    await focus(work);
    expect(work.getAttribute('aria-label')).toBe('Parent work');
    expect(work.getAttribute('aria-describedby')).toBe(
      element(document, 'swimlane-tooltip').id
    );
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Input1,200');
    await blur(work);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => {
      work.click();
      child.click();
    });
    expect(onTarget.mock.calls).toEqual([[parentTarget], [childTarget]]);

    expect(onTarget).toHaveBeenCalledTimes(2);
  });

  it('lets the most recently activated modality win and falls back to the other', async () => {
    const host = await render(mixedModel());
    const work = element(host, 'swimlane-parent-segment-work');
    const child = element(host, 'swimlane-activation-child-first');

    await focus(work);
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Input1,200');

    await mouseOver(child);
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Input10');

    await mouseOut(child);
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Input1,200');

    await mouseOver(work);
    await focus(child);
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Input10');
    await blur(child);
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Input1,200');
    await mouseOut(work);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('keeps active details attached to stable identities across interval insertion', async () => {
    const model = mixedModel();
    const host = await render(model);
    const work = element(host, 'swimlane-parent-segment-work');
    await mouseOver(work);

    model.parentSegments = [
      {
        id: 'inserted-idle',
        type: 'idle',
        startTime: at(0),
        endTime: at(0),
        durationMs: 0,
      },
      ...model.parentSegments,
    ];
    await rerender(model);

    const retainedWork = element(host, 'swimlane-parent-segment-work');
    expect(retainedWork.getAttribute('aria-describedby')).toBe(
      element(document, 'swimlane-tooltip').id
    );
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Input1,200');
    expect(element(host, 'swimlane-parent-segment-inserted-idle').getAttribute('aria-describedby')).toBeNull();
  });

  it('gives narrow silent intervals keyboard duration details without navigation semantics', async () => {
    const host = await render(mixedModel());
    const silent = element(host, 'swimlane-parent-segment-child-wait');

    expect(silent.tagName).toBe('DIV');
    expect(silent.tabIndex).toBe(0);
    expect(silent.getAttribute('aria-label')).toBe('Parent child-wait');
    await focus(silent);

    const tooltip = element(document, 'swimlane-tooltip');
    expect(tooltip.textContent).toContain('Duration2.0s');
    expect(tooltip.textContent).not.toContain('Input');
  });

  it('clamps the measured tooltip inside a very narrow and short viewport', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 100 });
    tooltipWidth = 184;
    tooltipHeight = 84;
    triggerLeft = 190;
    triggerTop = 92;
    const host = await render(mixedModel());

    await mouseOver(element(host, 'swimlane-parent-segment-work'));
    const tooltip = element(document, 'swimlane-tooltip');
    expect(Number.parseFloat(tooltip.style.left)).toBeGreaterThanOrEqual(0);
    expect(Number.parseFloat(tooltip.style.top)).toBeGreaterThanOrEqual(0);
    expect(tooltip.style.left).toBe('8px');
    expect(tooltip.style.top).toBe('8px');
    expect(tooltip.style.width).toBe('184px');
    expect(tooltip.style.maxHeight).toBe('calc(100vh - 16px)');
  });

  it('clamps the tooltip to the viewport left edge', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 });
    triggerLeft = -24;
    triggerTop = 120;
    const host = await render(mixedModel());

    await mouseOver(element(host, 'swimlane-parent-segment-work'));
    const tooltip = element(document, 'swimlane-tooltip');
    expect(tooltip.style.left).toBe('8px');
    expect(Number.parseFloat(tooltip.style.top)).toBeGreaterThanOrEqual(8);
  });

  it('cleans up tooltip state on scroll, resize, Escape, model replacement, and unmount', async () => {
    const model = mixedModel();
    const host = await render(model);
    const work = element(host, 'swimlane-parent-segment-work');

    for (const dismiss of [
      () =>
        element(host, 'swimlane-horizontal-scroll').dispatchEvent(
          new Event('scroll', { bubbles: false })
        ),
      () => window.dispatchEvent(new Event('resize')),
      () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    ]) {
      await mouseOver(work);
      expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
      await act(async () => dismiss());
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    }

    await focus(work);
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    await rerender({ ...model, parentSegments: [...model.parentSegments] });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    const replacementWork = element(host, 'swimlane-parent-segment-work');
    await mouseOver(replacementWork);
    replacementWork.remove();
    await act(async () => Promise.resolve());
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await mouseOver(element(host, 'swimlane-activation-child-first'));
    act(() => mountedRoot?.unmount());
    mountedRoot = undefined;
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('keeps zero-duration intervals and coincident HITL marks separately perceivable', async () => {
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
      hitlMarks: [
        { id: 'same-ask', type: 'ask', timestamp: at(0), source: 'explicit-ask' },
        { id: 'same-resume', type: 'resume', timestamp: at(0), source: 'inferred-resume' },
      ],
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
    expect(work.style.width).toBe('2px');
    expect(activation.style.width).toBe('2px');
    expect(work.style.overflow).toBe('hidden');
    expect(element(host, 'swimlane-parent-segment-instant-work-duration').style.visibility).toBe(
      'hidden'
    );
    await focus(work);
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Cache write3');

    const ask = element(host, 'swimlane-mark-same-ask');
    const resume = element(host, 'swimlane-mark-same-resume');
    expect(ask.style.left).not.toBe(resume.style.left);
    expect(ask.dataset.labelVisible).toBe('true');
    expect(resume.dataset.labelVisible).toBe('true');
    expect(ask.getAttribute('aria-label')).toBe('ask boundary');
    expect(resume.getAttribute('aria-label')).toBe('resume boundary');
    expect(ask.getAttribute('role')).toBe('img');
    expect(resume.getAttribute('role')).toBe('img');
  });

  it('reserves in-bounds pixels for close distinct marks and recomputes after clock resize', async () => {
    const model = mixedModel();
    model.hitlMarks = [
      { id: 'close-first', type: 'ask', timestamp: at(5), source: 'explicit-ask' },
      {
        id: 'close-second',
        type: 'resume',
        timestamp: at(5.01),
        source: 'inferred-resume',
      },
    ];
    const host = await render(model);
    const initialFirst = Number(element(host, 'swimlane-mark-close-first').dataset.clockPixel);
    const initialSecond = Number(element(host, 'swimlane-mark-close-second').dataset.clockPixel);

    expect(initialFirst).toBeGreaterThanOrEqual(0);
    expect(initialSecond).toBeLessThanOrEqual(clockWidth);
    expect(initialSecond - initialFirst).toBeGreaterThanOrEqual(3);

    clockWidth = 1440;
    await triggerResizeObservers();
    const resizedFirst = Number(element(host, 'swimlane-mark-close-first').dataset.clockPixel);
    const resizedSecond = Number(element(host, 'swimlane-mark-close-second').dataset.clockPixel);
    expect(resizedFirst).not.toBe(initialFirst);
    expect(resizedSecond).not.toBe(initialSecond);
    expect(resizedFirst).toBeGreaterThanOrEqual(0);
    expect(resizedSecond).toBeLessThanOrEqual(clockWidth);
    expect(resizedSecond - resizedFirst).toBeGreaterThanOrEqual(3);
  });

  it('bounds deep hierarchy indentation while retaining ancestor guides and full text', async () => {
    const model = mixedModel();
    model.childRows[1] = { ...model.childRows[1], depth: 50 };
    const host = await render(model);
    const row = element(host, 'swimlane-child-row-nested');
    const label = row.firstElementChild as HTMLElement;

    expect(label.style.paddingLeft).toBe('100px');
    expect(row.querySelectorAll('[data-testid^="swimlane-guide-nested-"]')).toHaveLength(7);
    expect(label.getAttribute('aria-label')).toBe(LONG_LABEL);
    expect(label.textContent).toContain(FAMILY);
  });

  it('shows inherited metrics on split work parts through the same details layer', async () => {
    const model = mixedModel();
    model.parentSegments = [
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
    ];
    const host = await render(model);
    const split = element(host, 'swimlane-parent-segment-logical-work-part-2');

    expect(split.getAttribute('aria-label')).toBe('Parent work');
    await focus(split);
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Cache write30');
  });

  it('renders a useful parent-only clock with boundaries and no empty-state substitution', async () => {
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
