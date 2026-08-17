import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SwimlaneSurface } from '../../../../src/renderer/components/chat/SwimlaneSurface';
import { SWIMLANE_SCHEMA_VERSION } from '../../../../src/main/types';

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
let viewportClientWidthOverride: number | undefined;

class MeasuredResizeObserver {
  static instances: MeasuredResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;
  private active = true;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MeasuredResizeObserver.instances.push(this);
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    this.active = false;
  }

  trigger(): void {
    if (this.active) this.callback([], this as unknown as ResizeObserver);
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
    schemaVersion: SWIMLANE_SCHEMA_VERSION,
    startTime: at(0, true),
    endTime: at(10, true),
    durationMs: 10_000,
    evidence: [],
    parentSegments: [
      {
        id: 'work',
        type: 'assistant-output',
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
        type: 'human-wait',
        startTime: at(4),
        endTime: at(6),
        durationMs: 2000,
      },
      {
        id: 'model-response',
        type: 'model-response',
        startTime: at(6),
        endTime: at(7),
        durationMs: 1000,
      },
      {
        id: 'tool-execution',
        type: 'tool-execution',
        startTime: at(7),
        endTime: at(8),
        durationMs: 1000,
      },
      {
        id: 'idle',
        type: 'unattributed',
        startTime: at(8),
        endTime: at(10),
        durationMs: 2000,
      },
    ],
    hitlMarks: [
      { id: 'ask-start', type: 'ask', timestamp: at(4), source: 'explicit-ask' },
      { id: 'ask-answer', type: 'answer', timestamp: at(6), source: 'explicit-ask' },
      { id: 'resume-start', type: 'resume-start', timestamp: at(7), source: 'linked-resume' },
      { id: 'resume-end', type: 'resume', timestamp: at(9), source: 'linked-resume' },
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

async function setRangeValue(target: HTMLInputElement, value: number): Promise<void> {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setValue?.call(target, String(value));
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => target.click());
}

beforeEach(() => {
  clockWidth = 720;
  tooltipWidth = 260;
  tooltipHeight = 180;
  triggerLeft = 200;
  triggerTop = 100;
  viewportClientWidthOverride = undefined;
  MeasuredResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', MeasuredResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.dataset.testid === 'swimlane-tooltip') {
      return new DOMRect(0, 0, tooltipWidth, tooltipHeight);
    }
    if (this.dataset.testid === 'swimlane-horizontal-scroll') {
      return new DOMRect(0, 0, clockWidth + 184 + 32, 300);
    }
    if (this.dataset.clockWidth !== undefined) {
      return new DOMRect(184, 80, Number(this.dataset.clockWidth), 34);
    }
    if (this.dataset.testid?.endsWith('-duration')) {
      return new DOMRect(0, 0, (this.textContent?.length ?? 0) * 6, 12);
    }
    if (
      this.dataset.testid?.startsWith('swimlane-parent-segment-') ||
      this.dataset.testid?.startsWith('swimlane-activation-')
    ) {
      const renderedClockWidth = Number(this.parentElement?.dataset.clockWidth) || clockWidth;
      const width = this.style.width.endsWith('%')
        ? (Number.parseFloat(this.style.width) / 100) * renderedClockWidth
        : 0;
      return new DOMRect(triggerLeft, triggerTop, width, 22);
    }
    return new DOMRect(0, 0, 0, 0);
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () {
    if (this.dataset.testid === 'swimlane-horizontal-scroll') {
      return viewportClientWidthOverride ?? clockWidth + 184 + 32;
    }
    return 0;
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
    expect(element(host, 'swimlane-horizontal-scroll').style.overflowY).toBe('auto');
    expect(element(host, 'swimlane-clock-canvas').style.width).toBe('936px');
    expect(element(host, 'swimlane-parent-row').style.height).toBe('34px');
    expect(element(host, 'swimlane-child-row-child').style.height).toBe('34px');
    expect(element(host, 'swimlane-axis-midpoint').textContent).toBe('5.0s');
    expect(element(host, 'swimlane-axis-midpoint').getAttribute('aria-label')).toBe(
      'Elapsed midpoint 5.0s'
    );
    expect(element(host, 'swimlane-axis-endpoint').textContent).toBe('10.0s');
    expect(element(host, 'swimlane-axis-endpoint').getAttribute('aria-label')).toBe(
      'Elapsed endpoint 10.0s'
    );

    const work = element(host, 'swimlane-parent-segment-work');
    const childWait = element(host, 'swimlane-parent-segment-child-wait');
    const hitlWait = element(host, 'swimlane-parent-segment-hitl-wait');
    const modelResponse = element(host, 'swimlane-parent-segment-model-response');
    const toolExecution = element(host, 'swimlane-parent-segment-tool-execution');
    const idle = element(host, 'swimlane-parent-segment-idle');
    expect(work.style.left).toBe('0%');
    expect(work.style.width).toBe('20%');
    expect(work.style.overflow).toBe('hidden');
    expect(work.style.backgroundColor).toBe('var(--context-btn-active-bg)');
    expect(childWait.style.backgroundImage).toContain('repeating-linear-gradient');
    expect(childWait.style.backgroundColor).toBe('transparent');
    expect(hitlWait.style.backgroundColor).toBe('var(--warning-bg)');
    expect(modelResponse.style.backgroundColor).toBe('var(--card-header-hover)');
    expect(modelResponse.getAttribute('aria-label')).toBe('Parent model response');
    expect(toolExecution.style.backgroundColor).toBe('var(--color-surface-raised)');
    expect(toolExecution.getAttribute('aria-label')).toBe('Parent tool execution');
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

  it('fits the complete clock at 100% with accessible scale feedback and two-axis overflow', async () => {
    const host = await render(mixedModel());
    const viewport = element(host, 'swimlane-horizontal-scroll');
    const canvas = element(host, 'swimlane-clock-canvas');
    const range = element(host, 'swimlane-zoom-range') as HTMLInputElement;
    const output = element(host, 'swimlane-zoom-output');
    const parentRow = element(host, 'swimlane-parent-row');
    const parentLabel = parentRow.firstElementChild as HTMLElement;

    expect(range.type).toBe('range');
    expect(range.min).toBe('100');
    expect(range.max).toBe('400');
    expect(range.step).toBe('25');
    expect(range.value).toBe('100');
    expect(range.getAttribute('aria-valuetext')).toBeNull();
    expect(range.getAttribute('aria-describedby')).toBe(output.id);
    expect(output.getAttribute('aria-live')).toBeNull();
    expect(output.textContent).toContain('100%');
    expect(output.textContent).toContain('s/px');
    expect(Number(output.dataset.secondsPerPixel)).toBeCloseTo(10 / 720);
    expect(Number.parseFloat(canvas.style.width)).toBe(
      viewport.getBoundingClientRect().width
    );
    expect(viewport.style.overflowX).toBe('auto');
    expect(viewport.style.overflowY).toBe('auto');
    expect(viewport.getAttribute('role')).toBe('region');
    expect(viewport.getAttribute('aria-label')).toBe('Swimlane timeline viewport');
    expect(parentRow.style.gridTemplateColumns).toBe('184px 720px');
    expect(parentRow.style.height).toBe('34px');
    expect(parentLabel.style.position).toBe('sticky');
    expect(parentLabel.style.width).toBe('');
    expect(parentLabel.style.fontSize).toBe('12px');
    const controls = element(host, 'swimlane-zoom-controls');
    const fit = element(host, 'swimlane-zoom-fit') as HTMLButtonElement;
    const zoomOut = element(host, 'swimlane-zoom-out') as HTMLButtonElement;
    expect(controls.style.boxSizing).toBe('border-box');
    expect(controls.style.flexWrap).toBe('wrap');
    expect(controls.style.minWidth).toBe('0');
    expect(range.style.flex).toBe('1 1 140px');
    expect(fit.style.minWidth).toBe('44px');
    expect(zoomOut.style.minWidth).toBe('32px');
    expect(fit.className).toContain('bg-surface-raised');
    expect(fit.className).toContain('focus-visible:ring-2');
    expect(fit.disabled).toBe(true);
    expect(zoomOut.disabled).toBe(true);
  });

  it('fits to the inner viewport width when vertical scrolling consumes a gutter', async () => {
    const host = await render(mixedModel());
    const viewport = element(host, 'swimlane-horizontal-scroll');

    viewportClientWidthOverride = viewport.getBoundingClientRect().width - 8;
    await triggerResizeObservers();

    expect(element(host, 'swimlane-clock-canvas').style.width).toBe('928px');
    expect(element(host, 'swimlane-parent-row').style.gridTemplateColumns).toBe('184px 712px');
    expect(Number.parseFloat(element(host, 'swimlane-clock-canvas').style.width)).toBe(
      viewport.clientWidth
    );
  });

  it('steps with both zoom buttons, preserves center while zooming out, and clamps controls', async () => {
    const host = await render(mixedModel());
    const viewport = element(host, 'swimlane-horizontal-scroll');
    const canvas = element(host, 'swimlane-clock-canvas');
    const range = element(host, 'swimlane-zoom-range') as HTMLInputElement;
    const zoomIn = element(host, 'swimlane-zoom-in') as HTMLButtonElement;
    const zoomOut = element(host, 'swimlane-zoom-out') as HTMLButtonElement;
    const parentRow = element(host, 'swimlane-parent-row');
    const parentLabel = parentRow.firstElementChild as HTMLElement;
    const initialHeight = parentRow.style.height;
    const initialLabelFontSize = parentLabel.style.fontSize;
    const interval = element(host, 'swimlane-parent-segment-work');

    await click(zoomIn);

    expect(range.value).toBe('125');
    expect(parentRow.style.gridTemplateColumns).toBe('184px 900px');
    expect(canvas.style.width).toBe('1116px');
    expect(viewport.scrollLeft).toBe(90);
    expect(Number(element(host, 'swimlane-zoom-output').dataset.secondsPerPixel)).toBeCloseTo(
      10 / 900
    );
    expect(interval.style.width).toBe('20%');
    expect(interval.getBoundingClientRect().width).toBe(180);
    expect(parentRow.style.height).toBe(initialHeight);
    expect(parentLabel.style.fontSize).toBe(initialLabelFontSize);
    expect(parentLabel.style.position).toBe('sticky');

    await click(zoomIn);
    expect(range.value).toBe('150');
    expect(canvas.style.width).toBe('1296px');
    expect(viewport.scrollLeft).toBe(180);

    viewport.scrollLeft = 270;
    await click(zoomOut);
    expect(range.value).toBe('125');
    expect(canvas.style.width).toBe('1116px');
    expect(viewport.scrollLeft).toBe(165);

    await click(zoomOut);
    expect(range.value).toBe('100');
    expect(viewport.scrollLeft).toBe(0);
    expect(zoomOut.disabled).toBe(true);

    for (let step = 0; step < 12; step++) await click(zoomIn);
    expect(range.value).toBe('400');
    expect(canvas.style.width).toBe('3096px');
    expect(zoomIn.disabled).toBe(true);
    expect((element(host, 'swimlane-zoom-fit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('returns to Fit after panning, removes stale scroll, and dismisses active details', async () => {
    const host = await render(mixedModel());
    const viewport = element(host, 'swimlane-horizontal-scroll');
    const range = element(host, 'swimlane-zoom-range') as HTMLInputElement;
    const work = element(host, 'swimlane-parent-segment-work');

    await setRangeValue(range, 200);
    viewport.scrollLeft = 500;
    await mouseOver(work);
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    await act(async () => element(host, 'swimlane-zoom-fit').click());

    expect(range.value).toBe('100');
    expect(viewport.scrollLeft).toBe(0);
    expect(element(host, 'swimlane-clock-canvas').style.width).toBe('936px');
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('resets zoom and horizontal scroll to Fit when the model is replaced', async () => {
    const model = mixedModel();
    const host = await render(model);
    const initialViewport = element(host, 'swimlane-horizontal-scroll');

    await setRangeValue(element(host, 'swimlane-zoom-range') as HTMLInputElement, 200);
    initialViewport.scrollLeft = 500;
    await rerender({ ...model, parentSegments: [...model.parentSegments] });

    const replacementViewport = element(host, 'swimlane-horizontal-scroll');
    expect(replacementViewport).not.toBe(initialViewport);
    expect((element(host, 'swimlane-zoom-range') as HTMLInputElement).value).toBe('100');
    expect(replacementViewport.scrollLeft).toBe(0);
    expect(element(host, 'swimlane-clock-canvas').style.width).toBe('936px');
  });

  it('refits from measured viewport width and preserves center while zoomed', async () => {
    const host = await render(mixedModel());
    const viewport = element(host, 'swimlane-horizontal-scroll');
    const range = element(host, 'swimlane-zoom-range') as HTMLInputElement;

    await setRangeValue(range, 200);
    expect(viewport.scrollLeft).toBe(360);
    const oldScale = Number(element(host, 'swimlane-zoom-output').dataset.secondsPerPixel);

    clockWidth = 1000;
    await triggerResizeObservers();

    expect(element(host, 'swimlane-parent-row').style.gridTemplateColumns).toBe('184px 2000px');
    expect(element(host, 'swimlane-clock-canvas').style.width).toBe('2216px');
    expect(viewport.scrollLeft).toBe(500);
    expect(Number(element(host, 'swimlane-zoom-output').dataset.secondsPerPixel)).toBeLessThan(
      oldScale
    );

    await setRangeValue(range, 100);
    clockWidth = 480;
    await triggerResizeObservers();
    expect(viewport.scrollLeft).toBe(0);
    expect(element(host, 'swimlane-clock-canvas').style.width).toBe('696px');
  });

  it('keeps zero-duration scale output stable and reveals real sub-pixel detail when zoomed', async () => {
    const pointModel = mixedModel();
    pointModel.endTime = pointModel.startTime;
    pointModel.durationMs = 0;
    pointModel.parentSegments = [];
    pointModel.hitlMarks = [];
    pointModel.childRows = [];
    const host = await render(pointModel);

    const zeroScaleOutput = element(host, 'swimlane-zoom-output');
    expect(zeroScaleOutput.textContent).toContain('100%');
    expect(zeroScaleOutput.textContent).toContain('0 s/px');
    expect(zeroScaleOutput.textContent).not.toMatch(/NaN|Infinity/);
    expect(Number(zeroScaleOutput.dataset.secondsPerPixel)).toBe(0);

    const denseModel = mixedModel();
    denseModel.parentSegments = [
      {
        id: 'five-millisecond-detail',
        type: 'assistant-output',
        startTime: at(1),
        endTime: at(1.005),
        durationMs: 5,
      },
    ];
    denseModel.childRows = [
      {
        id: 'dense-child',
        label: 'Dense child',
        parentRowId: null,
        depth: 0,
        activations: [
          {
            id: 'five-millisecond-child-detail',
            processId: 'dense-process',
            startTime: at(2),
            endTime: at(2.005),
            durationMs: 5,
            metrics: metrics(),
          },
        ],
      },
    ];
    denseModel.hitlMarks = [];
    await rerender(denseModel);
    expect(host.querySelector('[data-testid="swimlane-parent-segment-five-millisecond-detail"]'))
      .toBeNull();
    expect(host.querySelector('[data-testid="swimlane-activation-five-millisecond-child-detail"]'))
      .toBeNull();
    expect(element(host, 'swimlane-suppressed-activity').dataset.suppressedCount).toBe('2');
    expect(
      element(host, 'swimlane-child-row-dense-child').lastElementChild?.getAttribute(
        'data-clock-width'
      )
    ).toBe('720');

    await setRangeValue(element(host, 'swimlane-zoom-range') as HTMLInputElement, 400);
    expect(element(host, 'swimlane-parent-segment-five-millisecond-detail')).toBeTruthy();
    expect(element(host, 'swimlane-activation-five-millisecond-child-detail')).toBeTruthy();
    expect(
      element(host, 'swimlane-child-row-dense-child').lastElementChild?.getAttribute(
        'data-clock-width'
      )
    ).toBe('2880');
    expect(host.querySelector('[data-testid="swimlane-suppressed-activity"]')).toBeNull();
  });

  it('migrates an unversioned legacy projection without trusting legacy wait categories', async () => {
    const legacyMetrics = metrics({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
    const target = { kind: 'turn', groupId: 'legacy-work' } as const;
    const legacyModel = {
      startTime: at(0, true),
      endTime: at(10, true),
      durationMs: 10_000,
      parentSegments: [
        {
          id: 'legacy-work',
          type: 'work',
          startTime: at(0, true),
          endTime: at(2, true),
          durationMs: 60_000,
          metrics: legacyMetrics,
          chunkId: target.groupId,
        },
        {
          id: 'legacy-hitl',
          type: 'HITL-wait',
          startTime: at(2),
          endTime: at(4),
          durationMs: 2000,
        },
        {
          id: 'legacy-child',
          type: 'child-wait',
          startTime: at(4),
          endTime: at(6),
          durationMs: 2000,
        },
        {
          id: 'legacy-idle',
          type: 'idle',
          startTime: at(6),
          endTime: at(10),
          durationMs: 4000,
        },
        {
          id: 'legacy-zero-work',
          type: 'work',
          startTime: at(9),
          endTime: at(9),
          durationMs: 50_000,
          metrics: metrics({ inputTokens: 99 }),
          chunkId: 'legacy-zero-target',
        },
      ],
    } as unknown as SwimlaneModel;
    const onTarget = vi.fn();
    const host = await render(legacyModel, onTarget);

    const work = element(host, 'swimlane-parent-segment-legacy-work');
    expect(work.dataset.segmentType).toBe('assistant-output');
    expect(work.getAttribute('aria-label')).toBe('Parent assistant output');
    expect(work.style.width).toBe('20%');
    expect(element(host, 'swimlane-parent-segment-legacy-work-duration').textContent).toBe('2.0s');
    for (const id of ['legacy-hitl', 'legacy-child', 'legacy-idle']) {
      const segment = element(host, `swimlane-parent-segment-${id}`);
      expect(segment.dataset.segmentType).toBe('unattributed');
      expect(segment.getAttribute('aria-label')).toBe('Parent unattributed');
    }

    await mouseOver(work);
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Duration2.0s');
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Input12');
    await act(async () => work.click());
    expect(onTarget).toHaveBeenCalledWith(target);
    const suppressed = element(host, 'swimlane-suppressed-activity');
    expect(suppressed.textContent).toContain('assistant output — 0ms');
    expect(suppressed.textContent).toContain('input 99');
    const suppressedButton = suppressed.querySelector('button');
    await act(async () => suppressedButton?.click());
    expect(onTarget).toHaveBeenCalledWith({ kind: 'turn', groupId: 'legacy-zero-target' });
    expect(document.body.textContent).not.toContain('undefined');
  });

  it('retains legacy point work metadata on a zero-length axis', async () => {
    const pointTime = at(5);
    const legacyModel = {
      startTime: pointTime,
      endTime: pointTime,
      durationMs: 0,
      parentSegments: [
        {
          id: 'legacy-axis-point',
          type: 'work',
          startTime: pointTime,
          endTime: pointTime,
          durationMs: 60_000,
          metrics: metrics({ inputTokens: 17 }),
          chunkId: 'legacy-axis-point-owner',
        },
      ],
    } as unknown as SwimlaneModel;
    const onTarget = vi.fn();
    const host = await render(legacyModel, onTarget);

    expect(
      host.querySelector('[data-testid="swimlane-parent-segment-legacy-axis-point"]')
    ).toBeNull();
    const suppressed = element(host, 'swimlane-suppressed-activity');
    expect(suppressed.textContent).toContain('assistant output — 0ms');
    expect(suppressed.textContent).toContain('input 17');
    await act(async () => suppressed.querySelector('button')?.click());
    expect(onTarget).toHaveBeenCalledWith({
      kind: 'turn',
      groupId: 'legacy-axis-point-owner',
    });
  });

  it('fails closed for primitive models and missing or invalid axis bounds', async () => {
    const host = await render(null as unknown as SwimlaneModel);
    expect(element(host, 'swimlane-axis-endpoint').textContent).toBe('0ms');

    for (const primitive of [42, 'stale', false]) {
      await rerender(primitive as unknown as SwimlaneModel);
      expect(element(host, 'swimlane-axis-endpoint').textContent).toBe('0ms');
    }

    for (const partialAxis of [
      { startTime: at(0) },
      { endTime: at(10) },
      { startTime: 'invalid', endTime: at(10) },
      { startTime: at(0), endTime: 'invalid' },
      { startTime: at(10), endTime: at(0) },
    ]) {
      await rerender({
        schemaVersion: 1,
        ...partialAxis,
        parentSegments: [],
      } as unknown as SwimlaneModel);
      expect(element(host, 'swimlane-axis-midpoint').textContent).toBe('0ms');
      expect(element(host, 'swimlane-axis-endpoint').textContent).toBe('0ms');
    }
  });

  it('treats only positive integer schema versions as current-compatible', async () => {
    const modelForVersion = (schemaVersion: unknown): SwimlaneModel =>
      ({
        schemaVersion,
        startTime: at(0),
        endTime: at(10),
        parentSegments: [{ id: 'versioned-work', type: 'work', startTime: at(0), endTime: at(2) }],
      }) as unknown as SwimlaneModel;
    const host = await render(modelForVersion(undefined));

    for (const legacyVersion of [undefined, null, '1', Number.NaN, 1.5, 0, -1]) {
      await rerender(modelForVersion(legacyVersion));
      expect(element(host, 'swimlane-parent-segment-versioned-work').dataset.segmentType).toBe(
        'assistant-output'
      );
    }

    await rerender({
      ...modelForVersion(2),
      parentSegments: [
        { id: 'future-child-wait', type: 'child-wait', startTime: at(0), endTime: at(2) },
      ],
    } as unknown as SwimlaneModel);
    expect(element(host, 'swimlane-parent-segment-future-child-wait').dataset.segmentType).toBe(
      'child-wait'
    );
  });

  it('clips parent timestamps to the axis and drops invalid intervals', async () => {
    const model = mixedModel();
    model.parentSegments = [
      {
        id: 'stale-duration',
        type: 'assistant-output',
        startTime: at(1),
        endTime: at(3),
        durationMs: 60_000,
      },
      {
        id: 'outside-axis',
        type: 'tool-execution',
        startTime: at(-5),
        endTime: at(15),
        durationMs: 20_000,
      },
      {
        id: 'reversed',
        type: 'human-wait',
        startTime: at(8),
        endTime: at(7),
        durationMs: 1000,
      },
      {
        id: 'outside-point',
        type: 'assistant-output',
        startTime: at(15),
        endTime: at(15),
        durationMs: 0,
      },
      {
        id: 'touching-before-axis',
        type: 'assistant-output',
        startTime: at(-5),
        endTime: at(0),
        durationMs: 5000,
      },
    ];
    const host = await render(model);
    const stale = element(host, 'swimlane-parent-segment-stale-duration');
    const outside = element(host, 'swimlane-parent-segment-outside-axis');

    expect(stale.style.left).toBe('10%');
    expect(stale.style.width).toBe('20%');
    expect(element(host, 'swimlane-parent-segment-stale-duration-duration').textContent).toBe(
      '2.0s'
    );
    await mouseOver(stale);
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Duration2.0s');
    await mouseOut(stale);

    expect(outside.style.left).toBe('0%');
    expect(outside.style.width).toBe('100%');
    expect(element(host, 'swimlane-parent-segment-outside-axis-duration').textContent).toBe(
      '10.0s'
    );
    await mouseOver(outside);
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Duration10.0s');
    expect(host.querySelector('[data-testid="swimlane-parent-segment-reversed"]')).toBeNull();
    expect(host.querySelector('[data-testid="swimlane-parent-segment-outside-point"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="swimlane-parent-segment-touching-before-axis"]')
    ).toBeNull();
  });

  it('clips child activations, derives durations, and retains zero-duration metadata honestly', async () => {
    const model = mixedModel();
    model.childRows = [
      {
        id: 'runtime-child',
        label: 'Runtime child',
        parentRowId: null,
        depth: 0,
        activations: [
          {
            id: 'clipped-child',
            processId: 'clipped-process',
            startTime: at(1),
            endTime: at(3),
            durationMs: 60_000,
          },
          {
            id: 'outside-child',
            processId: 'outside-process',
            startTime: at(-5),
            endTime: at(15),
            durationMs: 60_000,
            metrics: metrics({ inputTokens: 8 }),
          },
          {
            id: 'reversed-child',
            processId: 'reversed-process',
            startTime: at(8),
            endTime: at(7),
            durationMs: 1000,
          },
          {
            id: 'zero-child',
            processId: 'zero-process',
            startTime: at(9),
            endTime: at(9),
            durationMs: 50_000,
            metrics: metrics({ inputTokens: 9 }),
            target: {
              kind: 'subagent',
              groupId: 'zero-owner',
              processId: 'zero-process',
            },
          },
        ],
      },
    ];
    const onTarget = vi.fn();
    const host = await render(model, onTarget);
    const clipped = element(host, 'swimlane-activation-clipped-child');
    const outside = element(host, 'swimlane-activation-outside-child');

    expect(clipped.style.left).toBe('10%');
    expect(clipped.style.width).toBe('20%');
    expect(element(host, 'swimlane-activation-clipped-child-duration').textContent).toBe('2.0s');
    await mouseOver(clipped);
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Duration2.0s');
    expect(element(document, 'swimlane-tooltip').textContent).not.toContain('Input');
    await mouseOut(clipped);

    expect(outside.style.width).toBe('100%');
    expect(element(host, 'swimlane-activation-outside-child-duration').textContent).toBe('10.0s');
    expect(host.querySelector('[data-testid="swimlane-activation-reversed-child"]')).toBeNull();
    const suppressed = element(host, 'swimlane-suppressed-activity');
    expect(suppressed.textContent).toContain('Runtime child activation — 0ms');
    expect(suppressed.textContent).toContain('input 9');
    await act(async () => suppressed.querySelector('button')?.click());
    expect(onTarget).toHaveBeenCalledWith({
      kind: 'subagent',
      groupId: 'zero-owner',
      processId: 'zero-process',
    });
  });

  it('keeps only valid in-axis HITL type and source pairs', async () => {
    const model = mixedModel();
    model.hitlMarks = [
      { id: 'valid', type: 'ask', timestamp: at(5), source: 'explicit-ask' },
      { id: 'wrong-source', type: 'ask', timestamp: at(5), source: 'linked-resume' },
      { id: 'wrong-resume-source', type: 'resume', timestamp: at(5), source: 'explicit-ask' },
      {
        id: 'object-type',
        type: { toString: () => 'ask' },
        timestamp: at(5),
        source: 'explicit-ask',
      } as unknown as SwimlaneModel['hitlMarks'][number],
      { id: 'before-axis', type: 'answer', timestamp: at(-1), source: 'explicit-ask' },
      { id: 'after-axis', type: 'resume', timestamp: at(11), source: 'linked-resume' },
    ];
    const host = await render(model);

    expect(element(host, 'swimlane-mark-valid')).toBeTruthy();
    expect(host.querySelectorAll('[data-testid^="swimlane-mark-"]')).toHaveLength(1);
  });

  it('omits invalid metrics and blank navigation identifiers', async () => {
    const model = mixedModel();
    model.parentSegments = [
      {
        id: 'invalid-details',
        type: 'assistant-output',
        startTime: at(0),
        endTime: at(2),
        durationMs: 2000,
        metrics: { ...metrics(), inputTokens: 1.5, cacheReadTokens: -1 },
        target: { kind: 'turn', groupId: '   ' },
      },
    ];
    const onTarget = vi.fn();
    const host = await render(model, onTarget);
    const segment = element(host, 'swimlane-parent-segment-invalid-details');

    expect(segment.tagName).toBe('DIV');
    await mouseOver(segment);
    expect(element(document, 'swimlane-tooltip').textContent).not.toContain('Input');
    expect(onTarget).not.toHaveBeenCalled();
  });

  it('renders future and partial projections with deterministic fallbacks', async () => {
    const partialModel = {
      schemaVersion: 99,
      startTime: at(0),
      endTime: at(10),
      parentSegments: [
        {
          id: 'future',
          type: 'future-activity',
          startTime: at(1),
          endTime: at(3),
          evidenceId: 'exact-evidence',
        },
        { id: 'missing-type', startTime: at(3), endTime: at(5) },
        { id: 'invalid', type: 'assistant-output', startTime: 'invalid', endTime: at(7) },
      ],
      evidence: [
        {
          id: 'exact-evidence',
          type: 'tool-execution',
          startTime: at(1),
          endTime: at(1.005),
          durationMs: 60_000,
          label: 'Exact evidence',
          metrics: metrics({
            inputTokens: 1,
            cacheReadTokens: 2,
            cacheCreationTokens: 3,
            outputTokens: 4,
          }),
        },
        {
          id: 'invalid-evidence',
          type: 'future-evidence',
          startTime: at(1),
          endTime: at(2),
          durationMs: 1000,
        },
        {
          id: 'object-evidence',
          type: { toString: () => 'tool-execution' },
          startTime: at(2),
          endTime: at(2.005),
          durationMs: 5,
        },
      ],
    } as unknown as SwimlaneModel;
    const host = await render(partialModel);

    expect(element(host, 'swimlane-parent-segment-future').getAttribute('aria-label')).toBe(
      'Parent unattributed'
    );
    expect(element(host, 'swimlane-parent-segment-missing-type').dataset.segmentType).toBe(
      'unattributed'
    );
    expect(host.querySelector('[data-testid="swimlane-parent-segment-invalid"]')).toBeNull();
    const suppressed = element(host, 'swimlane-suppressed-activity');
    expect(suppressed.textContent).toContain('tool execution (Exact evidence) — 5ms');
    expect(suppressed.textContent).toContain('input 1, cache read 2, cache write 3, output 4');
    expect(document.body.textContent).not.toContain('undefined');
  });

  it('deduplicates runtime identities deterministically in every rendered collection', async () => {
    const model = mixedModel();
    model.parentSegments = [
      {
        id: 'duplicate-parent',
        type: 'assistant-output',
        startTime: at(0),
        endTime: at(2),
        durationMs: 2000,
      },
      {
        id: 'duplicate-parent',
        type: 'tool-execution',
        startTime: at(2),
        endTime: at(4),
        durationMs: 2000,
      },
    ];
    model.evidence = [
      {
        id: 'duplicate-evidence',
        type: 'tool-execution',
        startTime: at(5),
        endTime: at(5.005),
        durationMs: 5,
        label: 'Evidence one',
      },
      {
        id: 'duplicate-evidence',
        type: 'model-response',
        startTime: at(6),
        endTime: at(6.005),
        durationMs: 5,
        label: 'Evidence two',
      },
    ];
    model.hitlMarks = [
      { id: 'duplicate-mark', type: 'ask', timestamp: at(4), source: 'explicit-ask' },
      { id: 'duplicate-mark', type: 'resume', timestamp: at(4), source: 'linked-resume' },
    ];
    model.childRows = [
      {
        id: 'duplicate-row',
        label: 'Row one',
        parentRowId: null,
        depth: 0,
        activations: [
          {
            id: 'duplicate-activation',
            processId: 'process-one',
            startTime: at(0),
            endTime: at(2),
            durationMs: 2000,
            metrics: metrics(),
          },
        ],
      },
      {
        id: 'duplicate-row',
        label: 'Row two',
        parentRowId: null,
        depth: 0,
        activations: [
          {
            id: 'duplicate-activation',
            processId: 'process-two',
            startTime: at(2),
            endTime: at(4),
            durationMs: 2000,
            metrics: metrics(),
          },
        ],
      },
    ];
    const host = await render(model);

    expect(element(host, 'swimlane-parent-segment-duplicate-parent')).toBeTruthy();
    expect(element(host, 'swimlane-parent-segment-duplicate-parent-2')).toBeTruthy();
    expect(element(host, 'swimlane-mark-duplicate-mark')).toBeTruthy();
    expect(element(host, 'swimlane-mark-duplicate-mark-2')).toBeTruthy();
    expect(element(host, 'swimlane-child-row-duplicate-row')).toBeTruthy();
    expect(element(host, 'swimlane-child-row-duplicate-row-2')).toBeTruthy();
    expect(element(host, 'swimlane-activation-duplicate-activation')).toBeTruthy();
    expect(element(host, 'swimlane-activation-duplicate-activation-2')).toBeTruthy();
    const suppressed = element(host, 'swimlane-suppressed-activity');
    expect(suppressed.textContent).toContain('Evidence one');
    expect(suppressed.textContent).toContain('Evidence two');
  });

  it('suppresses duration labels by rendered width and reveals them after a real clock resize', async () => {
    const model = mixedModel();
    model.parentSegments = [
      {
        id: 'short-work',
        type: 'assistant-output',
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
    expect(work.getAttribute('aria-label')).toBe('Parent assistant output');

    await mouseOver(work);
    const tooltip = element(document, 'swimlane-tooltip');
    expect(tooltip.textContent).toContain('Duration2.0s');
    expect(tooltip.textContent).toContain('Input1,200');
    expect(tooltip.textContent).toContain('Cache read500');
    expect(tooltip.textContent).toContain('Cache write200');
    expect(tooltip.textContent).toContain('Output100');
    expect(work.getAttribute('aria-label')).toBe('Parent assistant output');
    expect(work.getAttribute('aria-describedby')).toBe(tooltip.id);
    await mouseOut(work);

    await focus(work);
    expect(work.getAttribute('aria-label')).toBe('Parent assistant output');
    expect(work.getAttribute('aria-describedby')).toBe(element(document, 'swimlane-tooltip').id);
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
        type: 'unattributed',
        startTime: at(0),
        endTime: at(0.1),
        durationMs: 100,
      },
      ...model.parentSegments,
    ];
    await rerender(model);

    const retainedWork = element(host, 'swimlane-parent-segment-work');
    expect(retainedWork.getAttribute('aria-describedby')).toBe(
      element(document, 'swimlane-tooltip').id
    );
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Input1,200');
    expect(
      element(host, 'swimlane-parent-segment-inserted-idle').getAttribute('aria-describedby')
    ).toBeNull();
  });

  it('gives narrow silent intervals keyboard duration details without navigation semantics', async () => {
    const host = await render(mixedModel());
    const silent = element(host, 'swimlane-parent-segment-child-wait');

    expect(silent.tagName).toBe('DIV');
    expect(silent.tabIndex).toBe(0);
    expect(silent.getAttribute('aria-label')).toBe('Parent child wait');
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

  it('keeps sub-pixel activity as aggregate metadata without painting false-width bars', async () => {
    const instantMetrics = metrics({
      inputTokens: 1,
      cacheReadTokens: 2,
      cacheCreationTokens: 3,
      outputTokens: 4,
      totalTokens: 10,
    });
    const model: SwimlaneModel = {
      schemaVersion: SWIMLANE_SCHEMA_VERSION,
      startTime: at(0),
      endTime: at(10),
      durationMs: 10_000,
      evidence: [
        {
          id: 'instant-tool',
          type: 'tool-execution',
          startTime: at(0),
          endTime: at(0.005),
          durationMs: 60_000,
          toolUseId: 'tool-5ms',
          label: 'Read',
          metrics: instantMetrics,
          target: { kind: 'turn', groupId: 'tool-owner' },
        },
        {
          id: 'invalid-current-evidence',
          type: 'model-response',
          startTime: new Date(Number.NaN),
          endTime: at(1),
          durationMs: 1000,
        },
      ],
      parentSegments: [],
      hitlMarks: [
        { id: 'same-ask', type: 'ask', timestamp: at(0), source: 'explicit-ask' },
        { id: 'same-resume', type: 'resume', timestamp: at(0), source: 'linked-resume' },
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
              endTime: at(0.005),
              durationMs: 5,
              metrics: instantMetrics,
            },
          ],
        },
      ],
    };
    const onTarget = vi.fn();
    const host = await render(model, onTarget);

    expect(host.querySelector('[data-testid="swimlane-parent-segment-instant-tool"]')).toBeNull();
    expect(host.querySelector('[data-testid="swimlane-activation-instant-activation"]')).toBeNull();
    const suppressed = element(host, 'swimlane-suppressed-activity');
    expect(suppressed.dataset.suppressedCount).toBe('2');
    expect(suppressed.querySelector('summary')?.getAttribute('aria-label')).toBe(
      '2 hidden evidence intervals'
    );
    expect(suppressed.textContent).toContain('tool execution (Read) — 5ms');
    expect(suppressed.textContent).toContain('input 1, cache read 2, cache write 3, output 4');
    expect(suppressed.textContent).toContain('Instant child activation — 5ms');
    await act(async () => {
      suppressed.querySelector('summary')?.click();
      suppressed.querySelector('button')?.click();
    });
    expect(onTarget).toHaveBeenCalledWith({ kind: 'turn', groupId: 'tool-owner' });

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
        source: 'linked-resume',
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

  it('shows inherited metrics on split assistant-output parts through the same details layer', async () => {
    const model = mixedModel();
    model.parentSegments = [
      {
        id: 'logical-work',
        type: 'assistant-output',
        requestId: 'logical',
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
        type: 'assistant-output',
        requestId: 'logical',
        startTime: at(2),
        endTime: at(3),
        durationMs: 1000,
      },
    ];
    const host = await render(model);
    const split = element(host, 'swimlane-parent-segment-logical-work-part-2');

    expect(split.getAttribute('aria-label')).toBe('Parent assistant output');
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
