import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { formatDuration } from '@renderer/utils/formatters';

import type {
  SessionMetrics,
  SwimlaneHitlMark,
  SwimlaneModel,
  SwimlaneNavigationTarget,
  SwimlaneParentSegment,
} from '@shared/types';
import type { CSSProperties, FocusEvent, MouseEvent, RefObject } from 'react';

const LABEL_COLUMN_WIDTH = 184;
const MIN_CLOCK_WIDTH = 720;
const MIN_INTERVAL_WIDTH = 2;
const ROW_HEIGHT = 34;
const TRACK_INSET = 6;
const LABEL_HORIZONTAL_PADDING = 8;
const MAX_VISIBLE_DEPTH = 7;
const DEPTH_INDENT = 12;
const TOOLTIP_MARGIN = 8;
const TOOLTIP_GAP = 6;
const MIN_HITL_TICK_GAP = 3;

interface SwimlaneSurfaceProps {
  swimlane: SwimlaneModel;
  onTarget?: (target: SwimlaneNavigationTarget) => void;
}

interface IntervalDetails {
  durationMs: number;
  metrics?: SessionMetrics;
}

interface ActiveInterval {
  activationOrder: number;
  details: IntervalDetails;
  identity: string;
  key: string;
  trigger: HTMLElement;
}

interface SwimlaneIntervalProps {
  active: boolean;
  ariaLabel: string;
  details: IntervalDetails;
  fallbackWidth: number;
  intervalKey: string;
  onBlur: (intervalKey: string) => void;
  onFocus: (interval: Omit<ActiveInterval, 'activationOrder'>) => void;
  onMouseEnter: (interval: Omit<ActiveInterval, 'activationOrder'>) => void;
  onMouseLeave: (intervalKey: string) => void;
  onTarget?: (target: SwimlaneNavigationTarget) => void;
  style: CSSProperties;
  target?: SwimlaneNavigationTarget;
  testId: string;
  tooltipId: string;
  dataSegmentType?: string;
  inlineLabel?: string;
}

function timestamp(value: Date | string): number {
  const normalized = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(normalized) ? normalized : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function percentage(value: Date | string, axisStart: number, axisDuration: number): number {
  if (axisDuration <= 0) return 0;
  return clamp(((timestamp(value) - axisStart) / axisDuration) * 100, 0, 100);
}

function intervalStyle(
  startTime: Date | string,
  endTime: Date | string,
  axisStart: number,
  axisDuration: number
): CSSProperties {
  const left = percentage(startTime, axisStart, axisDuration);
  const end = percentage(endTime, axisStart, axisDuration);
  const width = Math.max(0, end - left);

  return {
    left: `${left}%`,
    width: width === 0 ? `${MIN_INTERVAL_WIDTH}px` : `${width}%`,
    minWidth: `${MIN_INTERVAL_WIDTH}px`,
  };
}

function intervalPixelWidth(
  startTime: Date | string,
  endTime: Date | string,
  axisStart: number,
  axisDuration: number,
  clockWidth: number
): number {
  if (axisDuration <= 0) return MIN_INTERVAL_WIDTH;
  const start = percentage(startTime, axisStart, axisDuration);
  const end = percentage(endTime, axisStart, axisDuration);
  return Math.max(MIN_INTERVAL_WIDTH, ((end - start) / 100) * clockWidth);
}

function exactNumber(value: number): string {
  return value.toLocaleString();
}

function segmentTreatment(segment: SwimlaneParentSegment): CSSProperties {
  switch (segment.type) {
    case 'work':
      return {
        backgroundColor: 'var(--context-btn-active-bg)',
        border: '1px solid var(--color-border-emphasis)',
        color: 'var(--context-btn-active-text)',
      };
    case 'child-wait':
      return {
        backgroundColor: 'transparent',
        backgroundImage:
          'repeating-linear-gradient(135deg, transparent 0, transparent 3px, var(--color-border) 3px, var(--color-border) 5px)',
        border: '1px solid var(--color-border-emphasis)',
      };
    case 'HITL-wait':
      return {
        backgroundColor: 'var(--warning-bg)',
        border: '1px solid var(--warning-border)',
        color: 'var(--warning-text)',
      };
    case 'idle':
      return {
        backgroundColor: 'transparent',
        border: '1px solid var(--color-border-subtle)',
      };
  }
}

function markLabel(mark: SwimlaneHitlMark): 'ask' | 'resume' {
  return mark.source === 'explicit-ask' ? 'ask' : 'resume';
}

function graphemes(value: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(value), ({ segment }) => segment);
  }
  return Array.from(value);
}

function truncateLabel(label: string): string {
  const parts = graphemes(label);
  return parts.length > 60 ? `${parts.slice(0, 60).join('')}…` : label;
}

function workIdentity(segment: SwimlaneParentSegment): string {
  if (segment.requestId) return `request:${segment.requestId}`;
  if (segment.chunkId) return `chunk:${segment.chunkId}`;
  return `id:${segment.id.replace(/-part-\d+$/, '')}`;
}

function intervalIdentity(namespace: 'activation' | 'parent', ...parts: string[]): string {
  const encodedParts = parts.map((part) => [part.length, part].join(':')).join('|');
  return `${namespace}:${encodedParts}`;
}

function useFittedLabel(
  triggerRef: RefObject<HTMLElement | null>,
  labelRef: RefObject<HTMLSpanElement | null>,
  fallbackWidth: number,
  label: string | undefined
): boolean {
  const [fits, setFits] = useState(false);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const labelElement = labelRef.current;
    if (!trigger || !labelElement || !label) {
      return;
    }

    const measure = (): void => {
      const renderedTriggerWidth = trigger.getBoundingClientRect().width;
      const computedStyle = window.getComputedStyle(trigger);
      const horizontalBorderWidth =
        (Number.parseFloat(computedStyle.borderLeftWidth) || 0) +
        (Number.parseFloat(computedStyle.borderRightWidth) || 0);
      const contentWidth =
        trigger.clientWidth || Math.max(0, renderedTriggerWidth - horizontalBorderWidth);
      const renderedLabelWidth =
        labelElement.getBoundingClientRect().width ||
        labelElement.scrollWidth ||
        label.length * 6;
      const fallbackContentWidth = Math.max(0, fallbackWidth - horizontalBorderWidth);
      const availableWidth =
        (contentWidth || fallbackContentWidth) - LABEL_HORIZONTAL_PADDING * 2;
      setFits(availableWidth >= renderedLabelWidth);
    };

    measure();
  }, [fallbackWidth, label, labelRef, triggerRef]);

  return fits;
}

/* eslint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-static-element-interactions -- informational intervals are intentionally keyboard-focusable tooltip triggers, not fabricated buttons */
const SwimlaneInterval = ({
  active,
  ariaLabel,
  details,
  fallbackWidth,
  intervalKey,
  onBlur,
  onFocus,
  onMouseEnter,
  onMouseLeave,
  onTarget,
  style,
  target,
  testId,
  tooltipId,
  dataSegmentType,
  inlineLabel,
}: Readonly<SwimlaneIntervalProps>): JSX.Element => {
  const triggerRef = useRef<HTMLElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const labelFits = useFittedLabel(triggerRef, labelRef, fallbackWidth, inlineLabel);
  const setTrigger = (element: HTMLElement | null): void => {
    triggerRef.current = element;
  };
  const handleFocus = (event: FocusEvent<HTMLElement>): void =>
    onFocus({
      details,
      identity: ariaLabel,
      key: intervalKey,
      trigger: event.currentTarget,
    });
  const handleMouseEnter = (event: MouseEvent<HTMLElement>): void =>
    onMouseEnter({
      details,
      identity: ariaLabel,
      key: intervalKey,
      trigger: event.currentTarget,
    });
  const content = inlineLabel ? (
    <span
      ref={labelRef}
      aria-hidden="true"
      data-label-visible={labelFits ? 'true' : 'false'}
      data-testid={`${testId}-duration`}
      style={{
        fontSize: '10px',
        fontWeight: 600,
        left: `${LABEL_HORIZONTAL_PADDING}px`,
        lineHeight: `${ROW_HEIGHT - TRACK_INSET * 2}px`,
        position: 'absolute',
        top: 0,
        visibility: labelFits ? 'visible' : 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      {inlineLabel}
    </span>
  ) : null;

  if (target && onTarget) {
    return (
      <button
        type="button"
        aria-describedby={active ? tooltipId : undefined}
        aria-label={ariaLabel}
        data-segment-type={dataSegmentType}
        data-testid={testId}
        onClick={() => onTarget(target)}
        onBlur={() => onBlur(intervalKey)}
        onFocus={handleFocus}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => onMouseLeave(intervalKey)}
        ref={setTrigger}
        style={{
          ...style,
          appearance: 'none',
          color: style.color ?? 'inherit',
          cursor: 'pointer',
          font: 'inherit',
          padding: 0,
          textAlign: 'left',
        }}
      >
        {content}
      </button>
    );
  }
  return (
    <div
      aria-describedby={active ? tooltipId : undefined}
      aria-label={ariaLabel}
      data-segment-type={dataSegmentType}
      data-testid={testId}
      onBlur={() => onBlur(intervalKey)}
      onFocus={handleFocus}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => onMouseLeave(intervalKey)}
      ref={setTrigger}
      style={style}
      tabIndex={0}
    >
      {content}
    </div>
  );
};
/* eslint-enable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-static-element-interactions -- restore default accessibility checks */

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: `${LABEL_COLUMN_WIDTH}px minmax(${MIN_CLOCK_WIDTH}px, 1fr)`,
  height: `${ROW_HEIGHT}px`,
};

const labelStyle: CSSProperties = {
  alignItems: 'center',
  backgroundColor: 'var(--color-surface)',
  borderRight: '1px solid var(--color-border)',
  color: 'var(--color-text-secondary)',
  display: 'flex',
  fontSize: '12px',
  left: 0,
  overflow: 'hidden',
  padding: `0 ${LABEL_HORIZONTAL_PADDING}px`,
  position: 'sticky',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  zIndex: 6,
};

const clockStyle: CSSProperties = {
  borderBottom: '1px solid var(--color-border)',
  minWidth: `${MIN_CLOCK_WIDTH}px`,
  position: 'relative',
};

const baseTrackStyle: CSSProperties = {
  backgroundColor: 'transparent',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: '4px',
  bottom: `${TRACK_INSET}px`,
  left: 0,
  position: 'absolute',
  right: 0,
  top: `${TRACK_INSET}px`,
};

const intervalBaseStyle: CSSProperties = {
  borderRadius: '3px',
  bottom: `${TRACK_INSET}px`,
  boxSizing: 'border-box',
  overflow: 'hidden',
  position: 'absolute',
  top: `${TRACK_INSET}px`,
};

interface HitlLayout {
  labelLevel: number | null;
  labelSide: 'left' | 'right';
  offset: number;
  pixel: number;
}

function layoutHitlMarks(
  marks: SwimlaneHitlMark[],
  axisStart: number,
  axisDuration: number,
  clockWidth: number
): Map<string, HitlLayout> {
  const layout = new Map<string, HitlLayout>();
  const occupiedRanges: { end: number; start: number }[][] = [[], []];
  const ordered = marks
    .map((mark, sourceIndex) => ({
      idealPixel: (percentage(mark.timestamp, axisStart, axisDuration) / 100) * clockWidth,
      mark,
      sourceIndex,
    }))
    .sort(
      (left, right) =>
        left.idealPixel - right.idealPixel || left.sourceIndex - right.sourceIndex
    );
  const minimumPixel = Math.min(1, clockWidth / 2);
  const maximumPixel = Math.max(minimumPixel, clockWidth - minimumPixel);
  const availableWidth = Math.max(0, maximumPixel - minimumPixel);
  const tickGap =
    ordered.length <= 1
      ? 0
      : Math.min(MIN_HITL_TICK_GAP, availableWidth / (ordered.length - 1));
  const reservedPixels = ordered.map(({ idealPixel }, index) =>
    Math.max(clamp(idealPixel, minimumPixel, maximumPixel), minimumPixel + index * tickGap)
  );
  if (reservedPixels.length > 0) {
    reservedPixels[reservedPixels.length - 1] = Math.min(
      reservedPixels[reservedPixels.length - 1],
      maximumPixel
    );
  }
  for (let index = reservedPixels.length - 2; index >= 0; index--) {
    reservedPixels[index] = Math.min(reservedPixels[index], reservedPixels[index + 1] - tickGap);
  }

  for (let index = 0; index < ordered.length; index++) {
    const { idealPixel, mark } = ordered[index];
    const pixel = clamp(reservedPixels[index], minimumPixel, maximumPixel);
    const basePixel = idealPixel;
    const offset = pixel - basePixel;
    const labelWidth = markLabel(mark) === 'ask' ? 24 : 38;
    const labelSide = pixel + labelWidth + 6 <= clockWidth ? 'right' : 'left';
    const labelStart = labelSide === 'right' ? pixel + 4 : pixel - labelWidth - 4;
    const labelEnd = labelStart + labelWidth;
    let labelLevel: number | null = null;
    for (let level = 0; level < occupiedRanges.length; level++) {
      const overlaps = occupiedRanges[level].some(
        (range) => labelStart < range.end && labelEnd > range.start
      );
      if (!overlaps) {
        labelLevel = level;
        occupiedRanges[level].push({ end: labelEnd, start: labelStart });
        break;
      }
    }
    layout.set(mark.id, { labelLevel, labelSide, offset, pixel });
  }
  return layout;
}

function IntervalTooltip({
  activeKey,
  details,
  identity,
  onDismiss,
  tooltipId,
  trigger,
}: Readonly<{
  activeKey: string;
  details: IntervalDetails;
  identity: string;
  onDismiss: () => void;
  tooltipId: string;
  trigger: HTMLElement | undefined;
}>): JSX.Element | null {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ key: string; left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!trigger?.isConnected || !tooltip) {
      onDismiss();
      return;
    }
    const triggerRect = trigger.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewportWidth = Math.max(0, window.innerWidth);
    const viewportHeight = Math.max(0, window.innerHeight);
    const marginX = Math.min(TOOLTIP_MARGIN, viewportWidth / 2);
    const marginY = Math.min(TOOLTIP_MARGIN, viewportHeight / 2);
    const maxLeft = Math.max(marginX, viewportWidth - tooltipRect.width - marginX);
    const left = clamp(
      triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2,
      marginX,
      maxLeft
    );
    const below = triggerRect.bottom + TOOLTIP_GAP;
    const above = triggerRect.top - tooltipRect.height - TOOLTIP_GAP;
    const preferredTop =
      below + tooltipRect.height <= viewportHeight - marginY || above < marginY ? below : above;
    const maxTop = Math.max(marginY, viewportHeight - tooltipRect.height - marginY);
    setPosition({ key: activeKey, left, top: clamp(preferredTop, marginY, maxTop) });
  }, [activeKey, onDismiss, trigger]);

  useEffect(() => {
    if (!trigger || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      if (!trigger.isConnected) onDismiss();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [onDismiss, trigger]);

  return createPortal(
    <div
      ref={tooltipRef}
      id={tooltipId}
      role="tooltip"
      data-interval-key={activeKey}
      data-testid="swimlane-tooltip"
      style={{
        backgroundColor: 'var(--color-surface-overlay)',
        border: '1px solid var(--color-border-emphasis)',
        borderRadius: '6px',
        boxShadow: '0 10px 25px rgba(0, 0, 0, 0.28)',
        boxSizing: 'border-box',
        color: 'var(--color-text)',
        fontSize: '11px',
        left: position?.left ?? 0,
        maxHeight: `calc(100vh - ${TOOLTIP_MARGIN * 2}px)`,
        maxWidth: `calc(100vw - ${TOOLTIP_MARGIN * 2}px)`,
        opacity: position?.key === activeKey ? 1 : 0,
        overflow: 'auto',
        padding: '8px 10px',
        pointerEvents: 'none',
        position: 'fixed',
        top: position?.top ?? 0,
        visibility: position?.key === activeKey ? 'visible' : 'hidden',
        width: `${Math.max(0, Math.min(260, window.innerWidth - TOOLTIP_MARGIN * 2))}px`,
        zIndex: 99999,
      }}
    >
      <div
        aria-hidden="true"
        style={{ color: 'var(--color-text-secondary)', fontWeight: 600, marginBottom: '5px' }}
      >
        {identity}
      </div>
      <dl
        style={{
          display: 'grid',
          gap: '3px 12px',
          gridTemplateColumns: 'max-content minmax(0, 1fr)',
          margin: 0,
        }}
      >
        <dt style={{ color: 'var(--color-text-muted)' }}>Duration</dt>
        <dd style={{ margin: 0, textAlign: 'right' }}>{formatDuration(details.durationMs)}</dd>
        {details.metrics && (
          <>
            <dt style={{ color: 'var(--color-text-muted)' }}>Input</dt>
            <dd style={{ margin: 0, textAlign: 'right' }}>
              {exactNumber(details.metrics.inputTokens)}
            </dd>
            <dt style={{ color: 'var(--color-text-muted)' }}>Cache read</dt>
            <dd style={{ margin: 0, textAlign: 'right' }}>
              {exactNumber(details.metrics.cacheReadTokens)}
            </dd>
            <dt style={{ color: 'var(--color-text-muted)' }}>Cache write</dt>
            <dd style={{ margin: 0, textAlign: 'right' }}>
              {exactNumber(details.metrics.cacheCreationTokens)}
            </dd>
            <dt style={{ color: 'var(--color-text-muted)' }}>Output</dt>
            <dd style={{ margin: 0, textAlign: 'right' }}>
              {exactNumber(details.metrics.outputTokens)}
            </dd>
          </>
        )}
      </dl>
    </div>,
    document.body
  );
}

const swimlaneModelKeys = new WeakMap<SwimlaneModel, number>();
let nextSwimlaneModelKey = 1;

function swimlaneModelKey(swimlane: SwimlaneModel): number {
  const existing = swimlaneModelKeys.get(swimlane);
  if (existing !== undefined) return existing;
  const key = nextSwimlaneModelKey++;
  swimlaneModelKeys.set(swimlane, key);
  return key;
}

const SwimlaneSurfaceContent = ({ swimlane, onTarget }: SwimlaneSurfaceProps): JSX.Element => {
  const axisStart = timestamp(swimlane.startTime);
  const axisEnd = timestamp(swimlane.endTime);
  const axisDuration = Math.max(0, axisEnd - axisStart);
  const rawTooltipId = useId();
  const tooltipId = `swimlane-tooltip-${rawTooltipId.replaceAll(':', '')}`;
  const clockRef = useRef<HTMLDivElement>(null);
  const activationOrderRef = useRef(0);
  const [clockWidth, setClockWidth] = useState(MIN_CLOCK_WIDTH);
  const [hoveredInterval, setHoveredInterval] = useState<ActiveInterval | null>(null);
  const [focusedInterval, setFocusedInterval] = useState<ActiveInterval | null>(null);
  const connectedHoveredInterval = hoveredInterval?.trigger.isConnected ? hoveredInterval : null;
  const connectedFocusedInterval = focusedInterval?.trigger.isConnected ? focusedInterval : null;
  const activeInterval =
    (connectedHoveredInterval?.activationOrder ?? -1) >
    (connectedFocusedInterval?.activationOrder ?? -1)
      ? connectedHoveredInterval
      : connectedFocusedInterval;
  const activeKey = activeInterval?.key ?? null;
  const workMetrics = new Map<string, SessionMetrics>();
  for (const segment of swimlane.parentSegments) {
    if (segment.type === 'work' && segment.metrics) {
      workMetrics.set(workIdentity(segment), segment.metrics);
    }
  }

  const closeTooltip = useCallback((): void => {
    setHoveredInterval(null);
    setFocusedInterval(null);
  }, []);

  useLayoutEffect(() => {
    const clock = clockRef.current;
    if (!clock) return;
    const measure = (): void => {
      const width = clock.getBoundingClientRect().width || clock.clientWidth || MIN_CLOCK_WIDTH;
      setClockWidth(width);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(clock);
    return () => observer.disconnect();
  }, [swimlane]);

  useEffect(() => {
    if (!activeKey) return;
    const dismiss = (): void => closeTooltip();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss();
    };
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [activeKey, closeTooltip]);

  const interactionProps = {
    onBlur: (key: string) =>
      setFocusedInterval((current) => (current?.key === key ? null : current)),
    onFocus: (interval: Omit<ActiveInterval, 'activationOrder'>) =>
      setFocusedInterval({ ...interval, activationOrder: ++activationOrderRef.current }),
    onMouseEnter: (interval: Omit<ActiveInterval, 'activationOrder'>) =>
      setHoveredInterval({ ...interval, activationOrder: ++activationOrderRef.current }),
    onMouseLeave: (key: string) =>
      setHoveredInterval((current) => (current?.key === key ? null : current)),
    tooltipId,
  };
  const hitlLayout = layoutHitlMarks(swimlane.hitlMarks, axisStart, axisDuration, clockWidth);

  return (
    <section
      aria-label="Session swimlane"
      data-testid="swimlane-surface"
      className="absolute inset-0 overflow-y-auto"
      style={{ backgroundColor: 'var(--color-surface)', paddingTop: '60px' }}
    >
      <div data-testid="swimlane-horizontal-scroll" style={{ overflowX: 'auto', width: '100%' }}>
        <div
          data-testid="swimlane-clock-canvas"
          style={{
            minWidth: `${LABEL_COLUMN_WIDTH + MIN_CLOCK_WIDTH}px`,
            padding: '8px 16px 18px',
          }}
        >
          <div data-testid="swimlane-axis" style={{ ...rowStyle, height: '28px' }}>
            <div style={{ ...labelStyle, color: 'var(--color-text)', fontWeight: 600 }}>
              Wall clock
            </div>
            <div
              style={{
                ...clockStyle,
                borderBottom: '1px solid var(--color-border-emphasis)',
                color: 'var(--color-text-muted)',
                fontSize: '10px',
                minHeight: '28px',
              }}
            >
              <span style={{ left: 0, position: 'absolute', top: '4px' }}>0ms</span>
              <span
                style={{
                  left: '50%',
                  position: 'absolute',
                  top: '4px',
                  transform: 'translateX(-50%)',
                }}
              >
                {formatDuration(axisDuration / 2)}
              </span>
              <span style={{ position: 'absolute', right: 0, top: '4px' }}>
                {formatDuration(axisDuration)}
              </span>
            </div>
          </div>

          <div data-testid="swimlane-parent-row" style={rowStyle}>
            <div style={{ ...labelStyle, color: 'var(--color-text)', fontWeight: 600 }} title="Parent">
              Parent
            </div>
            <div ref={clockRef} data-clock-width={clockWidth} style={clockStyle}>
              <div aria-hidden="true" style={baseTrackStyle} />
              {swimlane.parentSegments.map((segment) => {
                const intervalKey = intervalIdentity('parent', segment.id);
                const metrics =
                  segment.type === 'work'
                    ? (segment.metrics ?? workMetrics.get(workIdentity(segment)))
                    : undefined;
                const details = { durationMs: segment.durationMs, metrics };
                const identity = `Parent ${segment.type}`;
                return (
                  <SwimlaneInterval
                    key={intervalKey}
                    active={activeKey === intervalKey}
                    ariaLabel={identity}
                    details={details}
                    fallbackWidth={intervalPixelWidth(
                      segment.startTime,
                      segment.endTime,
                      axisStart,
                      axisDuration,
                      clockWidth
                    )}
                    intervalKey={intervalKey}
                    onBlur={interactionProps.onBlur}
                    onFocus={interactionProps.onFocus}
                    onMouseEnter={interactionProps.onMouseEnter}
                    onMouseLeave={interactionProps.onMouseLeave}
                    dataSegmentType={segment.type}
                    inlineLabel={formatDuration(segment.durationMs)}
                    testId={`swimlane-parent-segment-${segment.id}`}
                    target={segment.target}
                    onTarget={onTarget}
                    tooltipId={tooltipId}
                    style={{
                      ...intervalBaseStyle,
                      ...intervalStyle(segment.startTime, segment.endTime, axisStart, axisDuration),
                      ...segmentTreatment(segment),
                      zIndex: segment.type === 'work' ? 2 : 1,
                    }}
                  />
                );
              })}
              {swimlane.hitlMarks.map((mark) => {
                const label = markLabel(mark);
                const layout = hitlLayout.get(mark.id) ?? {
                  labelLevel: null,
                  labelSide: 'right',
                  offset: 0,
                  pixel: 0,
                };
                const clockPercentage = percentage(mark.timestamp, axisStart, axisDuration);
                return (
                  <div
                    key={mark.id}
                    role="img"
                    aria-label={`${label} boundary`}
                    data-clock-percentage={clockPercentage}
                    data-clock-pixel={layout.pixel}
                    data-label-visible={layout.labelLevel === null ? 'false' : 'true'}
                    data-mark-label={label}
                    data-mark-source={mark.source}
                    data-testid={`swimlane-mark-${mark.id}`}
                    style={{
                      backgroundColor: 'var(--warning-border)',
                      bottom: '2px',
                      left: `calc(${clockPercentage}% + ${layout.offset}px)`,
                      position: 'absolute',
                      top: '1px',
                      transform: 'translateX(-1px)',
                      width: '2px',
                      zIndex: 5,
                    }}
                  >
                    {layout.labelLevel !== null && (
                      <span
                        aria-hidden="true"
                        style={{
                          color: 'var(--warning-text)',
                          fontSize: '9px',
                          ...(layout.labelSide === 'right' ? { left: '4px' } : { right: '4px' }),
                          lineHeight: 1,
                          position: 'absolute',
                          top: `${layout.labelLevel * 10}px`,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {label}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {swimlane.childRows.map((row) => {
            const displayedLabel = truncateLabel(row.label);
            const visibleDepth = Math.min(row.depth, MAX_VISIBLE_DEPTH);
            return (
              <div
                key={row.id}
                data-depth={row.depth}
                data-parent-row-id={row.parentRowId ?? ''}
                data-testid={`swimlane-child-row-${row.id}`}
                style={rowStyle}
              >
                <div
                  aria-label={row.label}
                  style={{
                    ...labelStyle,
                    color: 'var(--color-text)',
                    fontWeight: 500,
                    paddingLeft: `${LABEL_HORIZONTAL_PADDING + visibleDepth * DEPTH_INDENT + (row.depth > 0 ? 8 : 0)}px`,
                  }}
                  title={row.label}
                >
                  {Array.from({ length: visibleDepth }, (_, guideIndex) => (
                    <span
                      key={guideIndex}
                      aria-hidden="true"
                      data-testid={`swimlane-guide-${row.id}-${guideIndex}`}
                      style={{
                        backgroundColor: 'var(--color-border-emphasis)',
                        bottom: 0,
                        left: `${LABEL_HORIZONTAL_PADDING + guideIndex * DEPTH_INDENT}px`,
                        position: 'absolute',
                        top: 0,
                        width: '1px',
                      }}
                    />
                  ))}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {displayedLabel}
                  </span>
                </div>
                <div style={clockStyle}>
                  <div aria-hidden="true" style={baseTrackStyle} />
                  {row.activations.map((activation) => {
                    const intervalKey = intervalIdentity('activation', row.id, activation.id);
                    const details = {
                      durationMs: activation.durationMs,
                      metrics: activation.metrics,
                    };
                    const identity = `${row.label} activation`;
                    return (
                      <SwimlaneInterval
                        key={intervalKey}
                        active={activeKey === intervalKey}
                        ariaLabel={identity}
                        details={details}
                        fallbackWidth={intervalPixelWidth(
                          activation.startTime,
                          activation.endTime,
                          axisStart,
                          axisDuration,
                          clockWidth
                        )}
                        inlineLabel={formatDuration(activation.durationMs)}
                        intervalKey={intervalKey}
                        onBlur={interactionProps.onBlur}
                        onFocus={interactionProps.onFocus}
                        onMouseEnter={interactionProps.onMouseEnter}
                        onMouseLeave={interactionProps.onMouseLeave}
                        testId={`swimlane-activation-${activation.id}`}
                        target={activation.target}
                        onTarget={onTarget}
                        tooltipId={tooltipId}
                        style={{
                          ...intervalBaseStyle,
                          ...intervalStyle(
                            activation.startTime,
                            activation.endTime,
                            axisStart,
                            axisDuration
                          ),
                          backgroundColor: 'var(--card-header-hover)',
                          borderColor: 'var(--card-separator)',
                          borderStyle: 'solid',
                          borderWidth: '1px',
                          color: 'var(--card-text-lighter)',
                          zIndex: 2,
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {activeInterval && (
        <IntervalTooltip
          activeKey={activeInterval.key}
          details={activeInterval.details}
          identity={activeInterval.identity}
          onDismiss={closeTooltip}
          tooltipId={tooltipId}
          trigger={activeInterval.trigger}
        />
      )}
    </section>
  );
};

export const SwimlaneSurface = ({ swimlane, onTarget }: SwimlaneSurfaceProps): JSX.Element => (
  <SwimlaneSurfaceContent
    key={swimlaneModelKey(swimlane)}
    swimlane={swimlane}
    onTarget={onTarget}
  />
);
