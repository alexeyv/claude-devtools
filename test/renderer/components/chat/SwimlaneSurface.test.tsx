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
let viewportClientHeightOverride: number | undefined;
let viewportLeft = 0;
let viewportTop = 0;
let forceNullHitTest = false;
let nextAnimationFrameId = 1;
let animationFrameCallbacks = new Map<number, FrameRequestCallback>();

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

async function mouseMove(target: HTMLElement, clientX: number, clientY: number): Promise<void> {
  await act(async () =>
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX, clientY }))
  );
}

async function pointerMove(
  target: HTMLElement,
  clientX: number,
  clientY: number,
  pointerType = 'mouse'
): Promise<void> {
  const event = new PointerEvent('pointermove', { bubbles: true, clientX, clientY });
  Object.defineProperty(event, 'pointerType', { configurable: true, value: pointerType });
  await act(async () => target.dispatchEvent(event));
  await flushAnimationFrames();
}

async function pointerLeave(target: HTMLElement): Promise<void> {
  await act(async () =>
    target.dispatchEvent(
      new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body })
    )
  );
}

async function pointerCancel(target: HTMLElement, pointerType = 'mouse'): Promise<void> {
  const event = new PointerEvent('pointercancel', { bubbles: true });
  Object.defineProperty(event, 'pointerType', { configurable: true, value: pointerType });
  await act(async () => target.dispatchEvent(event));
}

async function flushAnimationFrames(): Promise<void> {
  const callbacks = [...animationFrameCallbacks.values()];
  animationFrameCallbacks.clear();
  await act(async () => {
    callbacks.forEach((callback) => callback(performance.now()));
    await Promise.resolve();
  });
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

function rulerTicks(host: ParentNode): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('[data-testid="swimlane-ruler-tick"]'));
}

beforeEach(() => {
  clockWidth = 720;
  tooltipWidth = 260;
  tooltipHeight = 180;
  triggerLeft = 200;
  triggerTop = 100;
  viewportClientWidthOverride = undefined;
  viewportClientHeightOverride = undefined;
  viewportLeft = 0;
  viewportTop = 0;
  forceNullHitTest = false;
  nextAnimationFrameId = 1;
  animationFrameCallbacks = new Map();
  MeasuredResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', MeasuredResizeObserver);
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextAnimationFrameId++;
    animationFrameCallbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => animationFrameCallbacks.delete(id));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.dataset.testid === 'swimlane-tooltip') {
      return new DOMRect(
        Number.parseFloat(this.style.left) || 0,
        Number.parseFloat(this.style.top) || 0,
        tooltipWidth,
        tooltipHeight
      );
    }
    if (this.dataset.testid === 'swimlane-horizontal-scroll') {
      return new DOMRect(
        viewportLeft,
        viewportTop,
        viewportClientWidthOverride ?? clockWidth + 184 + 32,
        viewportClientHeightOverride ?? 300
      );
    }
    if (this.dataset.testid === 'swimlane-clock-canvas') {
      const viewport = this.parentElement;
      return new DOMRect(
        viewportLeft - (viewport?.scrollLeft ?? 0),
        viewportTop - (viewport?.scrollTop ?? 0),
        Number.parseFloat(this.style.width) || clockWidth + 184 + 32,
        138
      );
    }
    if (this.dataset.clockWidth !== undefined) {
      const viewport = this.closest<HTMLElement>('[data-testid="swimlane-horizontal-scroll"]');
      const left = viewportLeft + 184 + 16 - (viewport?.scrollLeft ?? 0);
      const scrollTop = viewport?.scrollTop ?? 0;
      if (this.dataset.testid === 'swimlane-time-ruler') {
        return new DOMRect(left, viewportTop + 8 - scrollTop, Number(this.dataset.clockWidth), 28);
      }
      if (this.dataset.testid === 'swimlane-parent-clock') {
        return new DOMRect(left, viewportTop + 36 - scrollTop, Number(this.dataset.clockWidth), 34);
      }
      if (this.dataset.testid?.startsWith('swimlane-child-clock-')) {
        const clocks = Array.from(
          this.closest('[data-testid="swimlane-clock-canvas"]')?.querySelectorAll(
            '[data-testid^="swimlane-child-clock-"]'
          ) ?? []
        );
        return new DOMRect(
          left,
          viewportTop + 70 + clocks.indexOf(this) * 34 - scrollTop,
          Number(this.dataset.clockWidth),
          34
        );
      }
      return new DOMRect(left, 36 - scrollTop, Number(this.dataset.clockWidth), 34);
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
  vi.spyOn(document, 'elementFromPoint').mockImplementation((clientX, clientY) => {
    if (forceNullHitTest) return null;
    const regions = Array.from(
      document.querySelectorAll<HTMLElement>('[data-swimlane-clock-region="true"]')
    );
    return (
      regions.find((region) => {
        const rect = region.getBoundingClientRect();
        return (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        );
      }) ?? null
    );
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () {
    if (this.dataset.testid === 'swimlane-horizontal-scroll') {
      return viewportClientWidthOverride ?? clockWidth + 184 + 32;
    }
    return 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () {
    if (this.dataset.testid === 'swimlane-horizontal-scroll') {
      return viewportClientHeightOverride ?? 300;
    }
    return 0;
  });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
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
    const tickLabels = rulerTicks(host).map((tick) => tick.textContent);
    expect(tickLabels).toEqual([
      '0ms',
      '1s',
      '2s',
      '3s',
      '4s',
      '5s',
      '6s',
      '7s',
      '8s',
      '9s',
      '10s',
    ]);
    expect(new Set(tickLabels).size).toBe(tickLabels.length);

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

  it('maps ruler, interval, and empty-track pointer positions to one red elapsed cursor', async () => {
    const host = await render(mixedModel());
    const ruler = element(host, 'swimlane-time-ruler');

    await mouseMove(ruler, 380, 20);
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).toBeNull();

    await pointerMove(ruler, 200, 20, 'pen');
    expect(element(host, 'swimlane-hover-guide').style.left).toBe('0px');
    expect(element(host, 'swimlane-hover-label').textContent).toBe('0ms');

    await pointerMove(ruler, 380, 20, 'pen');

    const cursor = element(host, 'swimlane-hover-cursor');
    const guide = element(host, 'swimlane-hover-guide');
    const label = element(host, 'swimlane-hover-label');
    expect(cursor.getAttribute('aria-hidden')).toBe('true');
    expect(cursor.style.pointerEvents).toBe('none');
    expect(cursor.style.left).toBe('200px');
    expect(cursor.style.top).toBe('8px');
    expect(cursor.style.height).toBe('130px');
    expect(guide.style.left).toBe('180px');
    expect(guide.style.backgroundColor).toBe('var(--error-highlight-ring)');
    expect(guide.style.pointerEvents).toBe('none');
    expect(label.textContent).toBe('2.50s');
    expect(label.getAttribute('role')).toBeNull();

    await pointerMove(element(host, 'swimlane-parent-segment-idle'), 560, 50);
    expect(element(host, 'swimlane-hover-guide').style.left).toBe('360px');
    expect(element(host, 'swimlane-hover-label').textContent).toBe('5.00s');

    await pointerMove(element(host, 'swimlane-child-clock-child'), 920, 80);
    expect(element(host, 'swimlane-hover-guide').style.left).toBe('719px');
    expect(element(host, 'swimlane-hover-label').textContent).toBe('10.00s');
    expect(
      Number.parseFloat(cursor.style.left) +
        Number.parseFloat(element(host, 'swimlane-hover-guide').style.left)
    ).toBe(919);
  });

  it('ignores touch, clears cancelled pointers, and coalesces pointer movement per frame', async () => {
    const host = await render(mixedModel());
    const ruler = element(host, 'swimlane-time-ruler');
    const hitTest = vi.mocked(document.elementFromPoint);

    await pointerMove(ruler, 300, 20);
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).not.toBeNull();

    await pointerMove(ruler, 320, 20, 'touch');
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).toBeNull();

    hitTest.mockClear();
    await act(async () => {
      for (const clientX of [300, 400, 560]) {
        const event = new PointerEvent('pointermove', { bubbles: true, clientX, clientY: 20 });
        Object.defineProperty(event, 'pointerType', { configurable: true, value: 'pen' });
        ruler.dispatchEvent(event);
      }
    });
    expect(animationFrameCallbacks.size).toBe(1);
    expect(hitTest).not.toHaveBeenCalled();
    await flushAnimationFrames();
    expect(hitTest).toHaveBeenCalledTimes(1);
    expect(element(host, 'swimlane-hover-label').textContent).toBe('5.00s');

    await pointerCancel(ruler, 'pen');
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).toBeNull();
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).toBeNull();
  });

  it('hides the elapsed cursor immediately over labels, padding, and outside the viewport', async () => {
    const model = mixedModel();
    model.evidence = [
      {
        id: 'suppressed-hover-evidence',
        type: 'tool-execution',
        startTime: at(1),
        endTime: at(1.001),
        durationMs: 1,
      },
    ];
    const host = await render(model);
    const viewport = element(host, 'swimlane-horizontal-scroll');
    const parentClock = element(host, 'swimlane-parent-clock');

    await pointerMove(parentClock, 400, 50);
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).not.toBeNull();

    const parentLabel = element(host, 'swimlane-parent-row').firstElementChild as HTMLElement;
    await pointerMove(parentLabel, 100, 50);
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).toBeNull();

    await pointerMove(parentClock, 400, 50);
    await pointerMove(element(host, 'swimlane-clock-canvas'), 8, 120);
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).toBeNull();

    await pointerMove(parentClock, 400, 50);
    await pointerMove(element(host, 'swimlane-suppressed-activity'), 400, 155);
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).toBeNull();

    await pointerMove(parentClock, 400, 50);
    await pointerLeave(viewport);
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).toBeNull();
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).toBeNull();
  });

  it('recomputes the elapsed cursor while zooming, scrolling, resizing, and ruler-panning', async () => {
    const model = mixedModel();
    const host = await render(model);
    const viewport = element(host, 'swimlane-horizontal-scroll');
    const range = element(host, 'swimlane-zoom-range') as HTMLInputElement;
    const parentClock = element(host, 'swimlane-parent-clock');

    await setRangeValue(range, 1);
    await pointerMove(parentClock, 400, 50);
    expect(element(host, 'swimlane-hover-guide').style.left).toBe('560px');
    expect(element(host, 'swimlane-hover-label').textContent).toBe('3.889s');

    viewport.scrollLeft = 460;
    const hitTest = vi.mocked(document.elementFromPoint);
    hitTest.mockClear();
    await act(async () => viewport.dispatchEvent(new Event('scroll')));
    expect(hitTest).toHaveBeenCalledTimes(1);
    expect(element(host, 'swimlane-hover-guide').style.left).toBe('660px');
    expect(element(host, 'swimlane-hover-label').textContent).toBe('4.583s');

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 420 });
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(element(host, 'swimlane-hover-label').style.left).toBe('343px');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(element(host, 'swimlane-hover-label').style.left).toBe('408px');

    clockWidth = 1000;
    await triggerResizeObservers();
    const resizedGuide = Number.parseFloat(element(host, 'swimlane-hover-guide').style.left);
    const resizedCanvas = element(host, 'swimlane-clock-canvas').getBoundingClientRect();
    const resizedCursor = element(host, 'swimlane-hover-cursor');
    expect(
      resizedCanvas.left + Number.parseFloat(resizedCursor.style.left) + resizedGuide
    ).toBeCloseTo(400);

    const ruler = element(host, 'swimlane-time-ruler');
    await pointerMove(ruler, 400, 20);
    const beforePan = viewport.scrollLeft;
    await act(async () => {
      ruler.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 400 }));
      window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: 350, clientY: 20 }));
    });
    expect(viewport.scrollLeft).toBe(beforePan + 50);
    expect(Number.parseFloat(element(host, 'swimlane-hover-guide').style.left)).toBeCloseTo(
      838.888889
    );
    expect(element(host, 'swimlane-hover-label').textContent).toBe('4.194s');

    await click(element(host, 'swimlane-zoom-fit'));
    expect(range.value).toBe('0');
    expect(element(host, 'swimlane-hover-guide').style.left).toBe('150px');
    expect(element(host, 'swimlane-hover-label').textContent).toBe('1.50s');

    viewportClientHeightOverride = 40;
    await triggerResizeObservers();
    expect(element(host, 'swimlane-hover-label').style.top).toBe('20px');
    viewportClientHeightOverride = 300;
    await triggerResizeObservers();

    viewportLeft = 20;
    viewportTop = 10;
    hitTest.mockClear();
    await act(async () => document.body.dispatchEvent(new Event('scroll')));
    expect(hitTest).toHaveBeenCalledTimes(1);
    expect(element(host, 'swimlane-hover-guide').style.left).toBe('130px');
    expect(element(host, 'swimlane-hover-label').textContent).toBe('1.30s');
    viewportLeft = 0;
    viewportTop = 0;
    await act(async () => window.dispatchEvent(new Event('scroll')));

    viewport.scrollTop = 140;
    await act(async () => viewport.dispatchEvent(new Event('scroll')));
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).toBeNull();
  });

  it('keeps zero-duration feedback finite and clamps its label inside a narrow viewport', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 240 });
    const model = mixedModel();
    model.endTime = model.startTime;
    model.durationMs = 0;
    model.parentSegments = [];
    model.hitlMarks = [];
    model.childRows = [];
    const host = await render(model);

    await pointerMove(element(host, 'swimlane-time-ruler'), 238, 20);

    const label = element(host, 'swimlane-hover-label');
    expect(label.textContent).toBe('0ms');
    expect(label.textContent).not.toMatch(/NaN|Infinity/);
    expect(label.style.left).toBe('200px');
    expect(label.style.width).toBe('36px');
    expect(Number.parseFloat(label.style.width)).toBeGreaterThan(
      label.textContent!.length * 6 + 12
    );
    expect(Number.parseFloat(label.style.left)).toBeGreaterThanOrEqual(0);
  });

  it('carries rounded elapsed labels cleanly across minute and hour boundaries', async () => {
    const minuteModel = mixedModel();
    minuteModel.endTime = at(59.999);
    minuteModel.durationMs = 59_999;
    minuteModel.parentSegments = [];
    minuteModel.childRows = [];
    const minuteHost = await render(minuteModel);

    await pointerMove(element(minuteHost, 'swimlane-time-ruler'), 920, 20);
    expect(element(minuteHost, 'swimlane-hover-label').textContent).toBe('1m');

    const hourModel = { ...minuteModel, endTime: at(3599.999), durationMs: 3_599_999 };
    await rerender(hourModel);
    await pointerMove(element(minuteHost, 'swimlane-time-ruler'), 920, 20);
    expect(element(minuteHost, 'swimlane-hover-label').textContent).toBe('1h');
  });

  it('uses the client box around sticky labels and scrollbar gutters for label placement', async () => {
    viewportClientWidthOverride = 800;
    viewportClientHeightOverride = 100;
    const host = await render(mixedModel());
    const ruler = element(host, 'swimlane-time-ruler');

    await pointerMove(ruler, 205, 10);
    const topLabel = element(host, 'swimlane-hover-label');
    expect(Number.parseFloat(topLabel.style.left)).toBeGreaterThanOrEqual(200);
    expect(Number.parseFloat(topLabel.style.top)).toBe(18);

    await pointerMove(ruler, 780, 20);
    const gutterLabel = element(host, 'swimlane-hover-label');
    expect(
      Number.parseFloat(gutterLabel.style.left) + Number.parseFloat(gutterLabel.style.width)
    ).toBeLessThanOrEqual(784);

    await pointerMove(element(host, 'swimlane-child-clock-child'), 400, 95);
    const bottomLabel = element(host, 'swimlane-hover-label');
    expect(bottomLabel.style.top).toBe('67px');
    expect(
      Number.parseFloat(bottomLabel.style.top) + Number.parseFloat(bottomLabel.style.height)
    ).toBeLessThanOrEqual(100);
  });

  it('clears stale pointer state on null hit tests, blur, visibility loss, and replacement', async () => {
    const model = mixedModel();
    const host = await render(model);
    const parentClock = element(host, 'swimlane-parent-clock');

    await pointerMove(parentClock, 400, 50);
    forceNullHitTest = true;
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).toBeNull();

    forceNullHitTest = false;
    await act(async () => window.dispatchEvent(new Event('scroll')));
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).toBeNull();

    await pointerMove(parentClock, 400, 50);
    await act(async () => window.dispatchEvent(new Event('blur')));
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).toBeNull();
    await act(async () => window.dispatchEvent(new Event('scroll')));
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).toBeNull();

    await pointerMove(parentClock, 400, 50);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).toBeNull();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await pointerMove(parentClock, 400, 50);
    await rerender({ ...model, parentSegments: [...model.parentSegments] });
    expect(host.querySelector('[data-testid="swimlane-hover-cursor"]')).toBeNull();
  });

  it('keeps the hover cursor supplemental to interval details and target clicks', async () => {
    triggerTop = 36;
    const model = mixedModel();
    const target = { kind: 'turn', groupId: 'hover-target' } as const;
    model.parentSegments[0].target = target;
    const onTarget = vi.fn();
    const host = await render(model, onTarget);
    const work = element(host, 'swimlane-parent-segment-work');

    await pointerMove(work, 300, 50);
    await mouseOver(work);
    await flushAnimationFrames();

    expect(element(host, 'swimlane-hover-cursor')).toBeTruthy();
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    const tooltip = element(document, 'swimlane-tooltip');
    const hoverLabel = element(host, 'swimlane-hover-label');
    expect(tooltip.textContent).toContain('Duration2.0s');
    expect(Number(hoverLabel.style.zIndex)).toBeLessThan(Number(tooltip.style.zIndex));
    expect(hoverLabel.style.pointerEvents).toBe('none');
    const tooltipRect = tooltip.getBoundingClientRect();
    const labelRect = new DOMRect(
      Number.parseFloat(hoverLabel.style.left),
      Number.parseFloat(hoverLabel.style.top),
      Number.parseFloat(hoverLabel.style.width),
      Number.parseFloat(hoverLabel.style.height)
    );
    expect(
      labelRect.left < tooltipRect.right &&
        labelRect.right > tooltipRect.left &&
        labelRect.top < tooltipRect.bottom &&
        labelRect.bottom > tooltipRect.top
    ).toBe(false);

    await click(work);
    expect(onTarget).toHaveBeenCalledWith(target);
  });

  it('fits the complete clock at 100% with accessible percentage feedback and two-axis overflow', async () => {
    const host = await render(mixedModel());
    const viewport = element(host, 'swimlane-horizontal-scroll');
    const canvas = element(host, 'swimlane-clock-canvas');
    const range = element(host, 'swimlane-zoom-range') as HTMLInputElement;
    const output = element(host, 'swimlane-zoom-output');
    const parentRow = element(host, 'swimlane-parent-row');
    const parentLabel = parentRow.firstElementChild as HTMLElement;

    expect(range.type).toBe('range');
    expect(range.min).toBe('0');
    expect(range.max).toBe('6');
    expect(range.step).toBe('1');
    expect(range.value).toBe('0');
    expect(range.getAttribute('aria-valuetext')).toBe('100%');
    expect(range.getAttribute('aria-describedby')).toBe(output.id);
    expect(output.getAttribute('aria-live')).toBe('polite');
    expect(output.getAttribute('aria-atomic')).toBe('true');
    expect(output.textContent).toBe('100%');
    expect(output.textContent).not.toContain('s/px');
    expect(output.dataset.secondsPerPixel).toBeUndefined();
    expect(Number.parseFloat(canvas.style.width)).toBe(viewport.getBoundingClientRect().width);
    expect(viewport.style.overflowX).toBe('auto');
    expect(viewport.style.overflowY).toBe('auto');
    expect(viewport.getAttribute('role')).toBe('region');
    expect(viewport.getAttribute('aria-label')).toBe('Swimlane timeline viewport');
    const rulerDescriptionId = viewport.getAttribute('aria-describedby');
    expect(rulerDescriptionId).toBeTruthy();
    expect(document.getElementById(rulerDescriptionId ?? '')?.textContent).toContain(
      'Drag the elapsed-time ruler horizontally for precise panning.'
    );
    expect(element(host, 'swimlane-time-ruler').getAttribute('aria-label')).toBeNull();
    expect(viewport.tabIndex).toBe(0);
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

  it('steps through powers of two, preserves center while zooming out, and clamps controls', async () => {
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

    expect(range.value).toBe('1');
    expect(range.getAttribute('aria-valuetext')).toBe('200%');
    expect(element(host, 'swimlane-zoom-output').textContent).toBe('200%');
    expect(parentRow.style.gridTemplateColumns).toBe('184px 1440px');
    expect(canvas.style.width).toBe('1656px');
    expect(viewport.scrollLeft).toBe(360);
    expect(interval.style.width).toBe('20%');
    expect(interval.getBoundingClientRect().width).toBe(288);
    expect(parentRow.style.height).toBe(initialHeight);
    expect(parentLabel.style.fontSize).toBe(initialLabelFontSize);
    expect(parentLabel.style.position).toBe('sticky');

    await click(zoomIn);
    expect(range.value).toBe('2');
    expect(range.getAttribute('aria-valuetext')).toBe('400%');
    expect(canvas.style.width).toBe('3096px');
    expect(viewport.scrollLeft).toBe(1080);

    viewport.scrollLeft = 1270;
    await click(zoomOut);
    expect(range.value).toBe('1');
    expect(canvas.style.width).toBe('1656px');
    expect(viewport.scrollLeft).toBe(455);

    await click(zoomOut);
    expect(range.value).toBe('0');
    expect(viewport.scrollLeft).toBe(0);
    expect(zoomOut.disabled).toBe(true);

    for (let step = 0; step < 12; step++) await click(zoomIn);
    expect(range.value).toBe('6');
    expect(range.getAttribute('aria-valuetext')).toBe('6400%');
    expect(canvas.style.width).toBe('46296px');
    expect(zoomIn.disabled).toBe(true);
    expect((element(host, 'swimlane-zoom-fit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('derives the final zoom level from duration without crossing the 100ms bound', async () => {
    const model = mixedModel();
    const host = await render(model);
    const range = element(host, 'swimlane-zoom-range') as HTMLInputElement;

    expect(Number(range.max)).toBe(6);
    expect(model.durationMs / 2 ** Number(range.max)).toBe(156.25);

    for (const [durationMs, expectedMax] of [
      [0, 0],
      [100, 0],
      [199, 0],
      [200, 1],
      [399, 1],
      [400, 2],
    ]) {
      const boundedModel = mixedModel();
      boundedModel.endTime = new Date(BASE_TIME + durationMs);
      boundedModel.durationMs = durationMs;
      boundedModel.parentSegments = [];
      boundedModel.hitlMarks = [];
      boundedModel.childRows = [];
      await rerender(boundedModel);
      const boundedRange = element(host, 'swimlane-zoom-range') as HTMLInputElement;
      expect(Number(boundedRange.max)).toBe(expectedMax);
      if (expectedMax > 0) {
        const visibleDuration = durationMs / 2 ** expectedMax;
        expect(visibleDuration).toBeGreaterThanOrEqual(100);
        expect(visibleDuration).toBeLessThan(200);
      } else {
        expect(boundedRange.disabled).toBe(true);
      }
    }
  });

  it('uses globally anchored nice ticks and mounts only non-overlapping visible labels', async () => {
    const longModel = mixedModel();
    longModel.endTime = at(900);
    longModel.durationMs = 900_000;
    longModel.parentSegments = [];
    longModel.hitlMarks = [];
    longModel.childRows = [];
    const host = await render(longModel);

    expect(rulerTicks(host).map((tick) => tick.textContent)).toEqual([
      '0ms',
      '2m',
      '4m',
      '6m',
      '8m',
      '10m',
      '12m',
      '14m',
    ]);

    const range = element(host, 'swimlane-zoom-range') as HTMLInputElement;
    const viewport = element(host, 'swimlane-horizontal-scroll');
    await setRangeValue(range, Number(range.max));
    viewport.scrollLeft = 4_000_000;
    await act(async () => viewport.dispatchEvent(new Event('scroll')));

    const ticks = rulerTicks(host);
    const elapsedValues = ticks.map((tick) => Number(tick.dataset.elapsedMs));
    const clock = Number(
      element(host, 'swimlane-parent-row').style.gridTemplateColumns.split(' ')[1].replace('px', '')
    );
    const visibleStart = (viewport.scrollLeft / clock) * longModel.durationMs;
    const visibleEnd = ((viewport.scrollLeft + clockWidth) / clock) * longModel.durationMs;
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThanOrEqual(20);
    expect(elapsedValues.every((value) => value >= visibleStart && value <= visibleEnd)).toBe(true);
    expect(elapsedValues.every((value) => value % 20 === 0)).toBe(true);
    expect(ticks.every((tick) => tick.textContent !== '0ms')).toBe(true);
    expect(new Set(ticks.map((tick) => tick.textContent)).size).toBe(ticks.length);

    viewportClientWidthOverride = 336;
    await triggerResizeObservers();
    expect(rulerTicks(host).length).toBeLessThanOrEqual(ticks.length);
  });

  it('coarsens ticks at an exact narrow width and keeps estimated labels inside the clock', async () => {
    viewportClientWidthOverride = 336;
    const host = await render(mixedModel());
    const ticks = rulerTicks(host);

    expect(ticks.map((tick) => tick.textContent)).toEqual(['0ms', '5s', '10s']);
    expect(
      ticks.every(
        (tick) =>
          Number(tick.dataset.estimatedLabelStartPixel) >= 0 &&
          Number(tick.dataset.estimatedLabelEndPixel) <= 120
      )
    ).toBe(true);
    for (let index = 1; index < ticks.length; index++) {
      expect(
        Number(ticks[index].dataset.estimatedLabelStartPixel) -
          Number(ticks[index - 1].dataset.estimatedLabelEndPixel)
      ).toBeGreaterThanOrEqual(8);
    }
  });

  it('retains a globally anchored tick in a positive-duration extreme-narrow panned viewport', async () => {
    viewportClientWidthOverride = 256;
    const host = await render(mixedModel());
    const range = element(host, 'swimlane-zoom-range') as HTMLInputElement;
    const viewport = element(host, 'swimlane-horizontal-scroll');
    await setRangeValue(range, Number(range.max));
    const renderedClockWidth = 40 * 2 ** Number(range.max);
    viewport.scrollLeft = (5010 / 10_000) * renderedClockWidth;
    await act(async () => viewport.dispatchEvent(new Event('scroll')));

    const ticks = rulerTicks(host);
    expect(ticks.map((tick) => Number(tick.dataset.elapsedMs))).toEqual([5100]);
    expect(Number(ticks[0].dataset.elapsedMs) % 100).toBe(0);
    expect(Number(ticks[0].dataset.estimatedLabelStartPixel)).toBeGreaterThanOrEqual(
      viewport.scrollLeft
    );
    expect(Number(ticks[0].dataset.estimatedLabelEndPixel)).toBeLessThanOrEqual(
      viewport.scrollLeft + 40
    );
  });

  it('uses readable millisecond ticks at maximum detail', async () => {
    const millisecondModel = mixedModel();
    millisecondModel.endTime = new Date(BASE_TIME + 400);
    millisecondModel.durationMs = 400;
    millisecondModel.parentSegments = [];
    millisecondModel.hitlMarks = [];
    millisecondModel.childRows = [];
    const host = await render(millisecondModel);
    const range = element(host, 'swimlane-zoom-range') as HTMLInputElement;

    await setRangeValue(range, Number(range.max));

    expect(range.getAttribute('aria-valuetext')).toBe('400%');
    expect(rulerTicks(host).map((tick) => tick.textContent)).toEqual([
      '150ms',
      '160ms',
      '170ms',
      '180ms',
      '190ms',
      '200ms',
      '210ms',
      '220ms',
      '230ms',
      '240ms',
      '250ms',
    ]);
  });

  it('formats exact hours and later exact-minute ticks uniquely', async () => {
    const hourModel = mixedModel();
    hourModel.endTime = at(4 * 60 * 60);
    hourModel.durationMs = 4 * 60 * 60 * 1000;
    hourModel.parentSegments = [];
    hourModel.hitlMarks = [];
    hourModel.childRows = [];
    const host = await render(hourModel);
    const labels = rulerTicks(host).map((tick) => tick.textContent);

    expect(labels).toEqual(['0ms', '30m', '1h', '1h 30m', '2h', '2h 30m', '3h', '3h 30m', '4h']);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('keeps native coarse scrolling and pans the long-run ruler one-to-one', async () => {
    const longModel = mixedModel();
    longModel.endTime = at(900);
    longModel.durationMs = 900_000;
    longModel.parentSegments = [];
    longModel.hitlMarks = [];
    longModel.childRows = [];
    const host = await render(longModel);
    const viewport = element(host, 'swimlane-horizontal-scroll');
    const range = element(host, 'swimlane-zoom-range') as HTMLInputElement;
    const ruler = element(host, 'swimlane-time-ruler');

    expect(viewport.style.overflowX).toBe('auto');
    expect(range.max).toBe('13');
    await setRangeValue(range, 13);
    const initialScrollLeft = viewport.scrollLeft;
    await act(async () => {
      ruler.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 300 }));
      window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: 250 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
    });

    expect(viewport.scrollLeft).toBe(initialScrollLeft + 50);
    const stoppedScrollLeft = viewport.scrollLeft;
    await act(async () =>
      window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: 200 }))
    );
    expect(viewport.scrollLeft).toBe(stoppedScrollLeft);

    await act(async () => {
      ruler.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 300 }));
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: 200 }));
    });
    expect(viewport.scrollLeft).toBe(stoppedScrollLeft);

    await act(async () => {
      ruler.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 300 }));
      window.dispatchEvent(new MouseEvent('mousemove', { buttons: 0, clientX: 250 }));
      window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: 200 }));
    });
    expect(viewport.scrollLeft).toBe(stoppedScrollLeft);
    expect(rulerTicks(host).length).toBeLessThanOrEqual(20);
  });

  it('returns to Fit after panning, removes stale scroll, and dismisses active details', async () => {
    const host = await render(mixedModel());
    const viewport = element(host, 'swimlane-horizontal-scroll');
    const range = element(host, 'swimlane-zoom-range') as HTMLInputElement;
    const work = element(host, 'swimlane-parent-segment-work');

    await setRangeValue(range, 1);
    viewport.scrollLeft = 500;
    await mouseOver(work);
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    await act(async () => element(host, 'swimlane-zoom-fit').click());

    expect(range.value).toBe('0');
    expect(viewport.scrollLeft).toBe(0);
    expect(element(host, 'swimlane-clock-canvas').style.width).toBe('936px');
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('resets zoom and horizontal scroll to Fit when the model is replaced', async () => {
    const model = mixedModel();
    const host = await render(model);
    const initialViewport = element(host, 'swimlane-horizontal-scroll');

    await setRangeValue(element(host, 'swimlane-zoom-range') as HTMLInputElement, 1);
    initialViewport.scrollLeft = 500;
    await rerender({ ...model, parentSegments: [...model.parentSegments] });

    const replacementViewport = element(host, 'swimlane-horizontal-scroll');
    expect(replacementViewport).not.toBe(initialViewport);
    expect((element(host, 'swimlane-zoom-range') as HTMLInputElement).value).toBe('0');
    expect(replacementViewport.scrollLeft).toBe(0);
    expect(element(host, 'swimlane-clock-canvas').style.width).toBe('936px');
  });

  it('refits from measured viewport width and preserves center while zoomed', async () => {
    const host = await render(mixedModel());
    const viewport = element(host, 'swimlane-horizontal-scroll');
    const range = element(host, 'swimlane-zoom-range') as HTMLInputElement;

    await setRangeValue(range, 1);
    expect(viewport.scrollLeft).toBe(360);

    clockWidth = 1000;
    await triggerResizeObservers();

    expect(element(host, 'swimlane-parent-row').style.gridTemplateColumns).toBe('184px 2000px');
    expect(element(host, 'swimlane-clock-canvas').style.width).toBe('2216px');
    expect(viewport.scrollLeft).toBe(500);
    expect(element(host, 'swimlane-zoom-output').textContent).toBe('200%');

    await setRangeValue(range, 0);
    clockWidth = 480;
    await triggerResizeObservers();
    expect(viewport.scrollLeft).toBe(0);
    expect(element(host, 'swimlane-clock-canvas').style.width).toBe('696px');
  });

  it('keeps zero-duration ruler state stable and reveals real sub-pixel detail when zoomed', async () => {
    const pointModel = mixedModel();
    pointModel.endTime = pointModel.startTime;
    pointModel.durationMs = 0;
    pointModel.parentSegments = [];
    pointModel.hitlMarks = [];
    pointModel.childRows = [];
    const host = await render(pointModel);

    const zeroScaleOutput = element(host, 'swimlane-zoom-output');
    expect(zeroScaleOutput.textContent).toBe('100%');
    expect(zeroScaleOutput.textContent).not.toMatch(/NaN|Infinity/);
    expect((element(host, 'swimlane-zoom-range') as HTMLInputElement).disabled).toBe(true);
    expect(rulerTicks(host)).toHaveLength(1);
    expect(rulerTicks(host)[0].textContent).toBe('0ms');

    viewportClientWidthOverride = 217;
    await triggerResizeObservers();
    expect(element(host, 'swimlane-clock-canvas').style.width).toBe('217px');
    expect(rulerTicks(host).map((tick) => tick.textContent)).toEqual(['0ms']);
    viewportClientWidthOverride = undefined;
    await triggerResizeObservers();

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
    expect(
      host.querySelector('[data-testid="swimlane-parent-segment-five-millisecond-detail"]')
    ).toBeNull();
    expect(
      host.querySelector('[data-testid="swimlane-activation-five-millisecond-child-detail"]')
    ).toBeNull();
    expect(element(host, 'swimlane-suppressed-activity').dataset.suppressedCount).toBe('2');
    expect(
      element(host, 'swimlane-child-row-dense-child').lastElementChild?.getAttribute(
        'data-clock-width'
      )
    ).toBe('720');

    await setRangeValue(element(host, 'swimlane-zoom-range') as HTMLInputElement, 6);
    expect(element(host, 'swimlane-parent-segment-five-millisecond-detail')).toBeTruthy();
    expect(element(host, 'swimlane-activation-five-millisecond-child-detail')).toBeTruthy();
    expect(
      element(host, 'swimlane-child-row-dense-child').lastElementChild?.getAttribute(
        'data-clock-width'
      )
    ).toBe('46080');
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
    expect(rulerTicks(host).map((tick) => tick.textContent)).toEqual(['0ms']);

    for (const primitive of [42, 'stale', false]) {
      await rerender(primitive as unknown as SwimlaneModel);
      expect(rulerTicks(host).map((tick) => tick.textContent)).toEqual(['0ms']);
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
      expect(rulerTicks(host).map((tick) => tick.textContent)).toEqual(['0ms']);
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

  it('renders classified child segments as siblings and preserves one activation target', async () => {
    const model = mixedModel();
    const target = {
      kind: 'subagent',
      groupId: 'child-owner',
      processId: 'process-first',
      spawnId: 'spawn-first',
    } as const;
    model.childRows = [
      {
        id: 'classified-row',
        label: 'Classified child',
        parentRowId: null,
        depth: 0,
        activations: [
          {
            id: 'classified-activation',
            processId: 'process-first',
            startTime: at(1),
            endTime: at(4),
            durationMs: 3000,
            metrics: metrics({ inputTokens: 30, outputTokens: 10 }),
            target,
            evidence: [
              {
                id: 'child-output-evidence',
                type: 'assistant-output',
                startTime: at(1),
                endTime: at(2),
                durationMs: 1000,
                requestId: 'child-request',
                metrics: metrics({ inputTokens: 8, outputTokens: 2 }),
              },
              {
                id: 'child-tool-evidence',
                type: 'tool-execution',
                startTime: at(2),
                endTime: at(2.005),
                durationMs: 5,
                toolUseId: 'child-read',
                label: 'Read',
              },
            ],
            segments: [
              {
                id: 'child-output-metric-owner',
                type: 'assistant-output',
                startTime: at(1),
                endTime: at(1.005),
                durationMs: 5,
                evidenceId: 'child-output-evidence',
                requestId: 'child-request',
                metrics: metrics({ inputTokens: 8, outputTokens: 2 }),
              },
              {
                id: 'child-output-segment',
                type: 'assistant-output',
                startTime: at(1.005),
                endTime: at(2),
                durationMs: 995,
                evidenceId: 'child-output-evidence',
                requestId: 'child-request',
              },
              {
                id: 'child-tool-segment',
                type: 'tool-execution',
                startTime: at(2),
                endTime: at(2.005),
                durationMs: 5,
                evidenceId: 'child-tool-evidence',
              },
              {
                id: 'invalid-child-segment',
                type: 'future-child-segment',
                startTime: at(2),
                endTime: at(3),
                durationMs: 1000,
              },
              {
                id: 'clipped-child-segment',
                type: 'unattributed',
                startTime: at(0),
                endTime: at(1.5),
                durationMs: 1500,
              },
            ],
          },
        ],
      },
    ] as unknown as SwimlaneModel['childRows'];
    const onTarget = vi.fn();
    const host = await render(model, onTarget);
    const envelope = element(host, 'swimlane-activation-classified-activation');
    const output = element(
      host,
      'swimlane-child-segment-classified-activation-child-output-segment'
    );

    expect(envelope.tagName).toBe('DIV');
    expect(envelope.getAttribute('aria-hidden')).toBe('true');
    expect(output.tagName).toBe('BUTTON');
    expect(output.dataset.segmentType).toBe('assistant-output');
    expect(
      element(host, 'swimlane-child-segment-classified-activation-clipped-child-segment').style
        .width
    ).toBe('5%');
    expect(host.querySelector('[data-testid*="invalid-child-segment"]')).toBeNull();
    expect(element(host, 'swimlane-suppressed-activity').textContent).toContain(
      'Classified child tool execution (Read) — 5ms'
    );

    await mouseOver(output);
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Input8');
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Output2');
    expect(element(document, 'swimlane-tooltip').textContent).not.toContain('Input30');
    await mouseOut(output);
    await focus(output);
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Input8');
    expect(element(document, 'swimlane-tooltip').textContent).not.toContain('Output10');
    await blur(output);

    await act(async () => output.click());
    expect(onTarget.mock.calls).toEqual([[target]]);

    await setRangeValue(element(host, 'swimlane-zoom-range') as HTMLInputElement, 6);
    const tool = element(host, 'swimlane-child-segment-classified-activation-child-tool-segment');
    expect(host.querySelector('[data-testid="swimlane-suppressed-activity"]')).toBeNull();
    await act(async () => tool.click());
    expect(onTarget.mock.calls).toEqual([[target], [target]]);
  });

  it('falls back to aggregate child bars when supplied segments normalize empty', async () => {
    const model = mixedModel();
    const target = {
      kind: 'subagent',
      groupId: 'fallback-owner',
      processId: 'fallback-process',
    } as const;
    model.childRows = [
      {
        id: 'fallback-row',
        label: 'Fallback child',
        parentRowId: null,
        depth: 0,
        activations: [
          {
            id: 'all-invalid-segments',
            processId: 'fallback-process',
            startTime: at(1),
            endTime: at(2),
            durationMs: 1000,
            metrics: metrics({ inputTokens: 7 }),
            target,
            segments: [
              {
                id: 'invalid-type',
                type: 'future-segment',
                startTime: at(1),
                endTime: at(2),
                durationMs: 1000,
              },
            ],
          },
          {
            id: 'empty-segments',
            processId: 'empty-process',
            startTime: at(3),
            endTime: at(4),
            durationMs: 1000,
            target: { ...target, processId: 'empty-process' },
            segments: [],
          },
        ],
      },
    ] as unknown as SwimlaneModel['childRows'];
    const onTarget = vi.fn();
    const host = await render(model, onTarget);
    const invalid = element(host, 'swimlane-activation-all-invalid-segments');
    const empty = element(host, 'swimlane-activation-empty-segments');

    expect(invalid.tagName).toBe('BUTTON');
    expect(empty.tagName).toBe('BUTTON');
    await mouseOver(invalid);
    expect(element(document, 'swimlane-tooltip').textContent).toContain('Input7');
    await mouseOut(invalid);
    await act(async () => {
      invalid.click();
      empty.click();
    });
    expect(onTarget).toHaveBeenCalledTimes(2);
  });

  it('discloses a sub-pixel unattributed segmented activation exactly once', async () => {
    const model = mixedModel();
    const target = {
      kind: 'subagent',
      groupId: 'tiny-owner',
      processId: 'tiny-process',
    } as const;
    model.childRows = [
      {
        id: 'tiny-row',
        label: 'Tiny child',
        parentRowId: null,
        depth: 0,
        activations: [
          {
            id: 'tiny-unattributed',
            processId: 'tiny-process',
            startTime: at(2),
            endTime: at(2.005),
            durationMs: 5,
            metrics: metrics({ inputTokens: 7, outputTokens: 3 }),
            target,
            evidence: [],
            segments: [
              {
                id: 'tiny-unattributed-segment',
                type: 'unattributed',
                startTime: at(2),
                endTime: at(2.005),
                durationMs: 5,
              },
            ],
          },
        ],
      },
    ];
    const onTarget = vi.fn();
    const host = await render(model, onTarget);
    const suppressed = element(host, 'swimlane-suppressed-activity');

    expect(suppressed.dataset.suppressedCount).toBe('1');
    expect(suppressed.textContent).toContain('Tiny child activation — 5ms');
    expect(suppressed.textContent).toContain('input 7');
    await act(async () => suppressed.querySelector('button')?.click());
    expect(onTarget).toHaveBeenCalledOnce();

    await setRangeValue(element(host, 'swimlane-zoom-range') as HTMLInputElement, 6);
    expect(
      element(host, 'swimlane-child-segment-tiny-unattributed-tiny-unattributed-segment')
    ).toBeTruthy();
    expect(host.querySelector('[data-testid="swimlane-suppressed-activity"]')).toBeNull();
  });

  it('remaps duplicate child evidence ids independently for each activation', async () => {
    const model = mixedModel();
    const activation = (id: string, start: number, end: number) => ({
      id,
      processId: `${id}-process`,
      startTime: at(start),
      endTime: at(end),
      durationMs: (end - start) * 1000,
      evidence: [
        {
          id: 'reused-evidence',
          type: 'assistant-output' as const,
          startTime: at(start),
          endTime: at(end),
          durationMs: (end - start) * 1000,
          metrics: metrics({ inputTokens: start }),
        },
      ],
      segments: [
        {
          id: `${id}-segment`,
          type: 'assistant-output' as const,
          startTime: at(start),
          endTime: at(end),
          durationMs: (end - start) * 1000,
          evidenceId: 'reused-evidence',
        },
      ],
    });
    model.childRows = [
      {
        id: 'duplicate-evidence-row',
        label: 'Duplicate evidence child',
        parentRowId: null,
        depth: 0,
        activations: [activation('duplicate-first', 1, 2), activation('duplicate-second', 3, 4)],
      },
    ];
    const host = await render(model);

    expect(
      element(host, 'swimlane-child-segment-duplicate-first-duplicate-first-segment')
    ).toBeTruthy();
    expect(
      element(host, 'swimlane-child-segment-duplicate-second-duplicate-second-segment')
    ).toBeTruthy();
    expect(host.querySelector('[data-testid="swimlane-suppressed-activity"]')).toBeNull();
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
