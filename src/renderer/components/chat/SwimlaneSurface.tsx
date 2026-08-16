import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { formatDuration } from '@renderer/utils/formatters';
import { SWIMLANE_SCHEMA_VERSION } from '@shared/types';

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
const MIN_MEANINGFUL_INTERVAL_WIDTH = 1;
const ROW_HEIGHT = 34;
const TRACK_INSET = 6;
const LABEL_HORIZONTAL_PADDING = 8;
const MAX_VISIBLE_DEPTH = 7;
const DEPTH_INDENT = 12;
const TOOLTIP_MARGIN = 8;
const TOOLTIP_GAP = 6;
const MIN_HITL_TICK_GAP = 3;
const SUPPRESSED_DETAIL_LIMIT = 50;
const EVIDENCE_TYPES = [
  'assistant-output',
  'model-response',
  'tool-execution',
  'child-wait',
  'human-wait',
] as const;
const PARENT_TYPES = [...EVIDENCE_TYPES, 'unattributed'] as const;

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

interface SuppressedInterval {
  details: IntervalDetails;
  id: string;
  identity: string;
  target?: SwimlaneNavigationTarget;
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

type RuntimeRecord = Record<string, unknown>;

function runtimeRecord(value: unknown): RuntimeRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as RuntimeRecord) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function runtimeTimestamp(value: unknown): number | undefined {
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  const normalized = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(normalized) ? normalized : undefined;
}

function runtimeMetrics(value: unknown): SessionMetrics | undefined {
  const candidate = runtimeRecord(value);
  if (!candidate) return undefined;
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens']) {
    const tokenCount = finiteNumber(candidate[key]);
    if (tokenCount === undefined || !Number.isInteger(tokenCount) || tokenCount < 0)
      return undefined;
  }
  return candidate as unknown as SessionMetrics;
}

function runtimeTarget(value: unknown): SwimlaneNavigationTarget | undefined {
  const candidate = runtimeRecord(value);
  if (!candidate) return undefined;
  const groupId = runtimeNonblankString(candidate.groupId);
  if (candidate.kind === 'turn' && groupId) {
    return { kind: 'turn', groupId };
  }
  const processId = runtimeNonblankString(candidate.processId);
  if (candidate.kind === 'subagent' && groupId && processId) {
    const spawnId = runtimeNonblankString(candidate.spawnId);
    return {
      kind: 'subagent',
      groupId,
      processId,
      ...(spawnId ? { spawnId } : {}),
    };
  }
  return undefined;
}

function runtimeString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function runtimeNonblankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function uniqueRuntimeId(value: unknown, fallback: string, usedIds: Set<string>): string {
  const base = runtimeNonblankString(value) ?? fallback;
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) id = `${base}-${suffix++}`;
  usedIds.add(id);
  return id;
}

function clippedInterval(
  candidate: RuntimeRecord,
  axisStart: number,
  axisEnd: number
): { durationMs: number; endTime: Date; startTime: Date } | undefined {
  const rawStart = runtimeTimestamp(candidate.startTime);
  const rawEnd = runtimeTimestamp(candidate.endTime);
  if (rawStart === undefined || rawEnd === undefined || rawEnd < rawStart) {
    return undefined;
  }
  if (rawStart === rawEnd) {
    return rawStart >= axisStart && rawStart <= axisEnd
      ? { startTime: new Date(rawStart), endTime: new Date(rawEnd), durationMs: 0 }
      : undefined;
  }
  if (axisEnd <= axisStart) return undefined;
  const start = Math.max(axisStart, rawStart);
  const end = Math.min(axisEnd, rawEnd);
  if (end <= start) return undefined;
  return { startTime: new Date(start), endTime: new Date(end), durationMs: end - start };
}

function isParentType(value: unknown): value is SwimlaneParentSegment['type'] {
  return typeof value === 'string' && (PARENT_TYPES as readonly string[]).includes(value);
}

function isEvidenceType(value: unknown): value is SwimlaneModel['evidence'][number]['type'] {
  return typeof value === 'string' && (EVIDENCE_TYPES as readonly string[]).includes(value);
}

function normalizedParentType(value: unknown, legacy: boolean): SwimlaneParentSegment['type'] {
  if (legacy) return value === 'work' ? 'assistant-output' : 'unattributed';
  return isParentType(value) ? value : 'unattributed';
}

/** Convert stale or partial IPC data into the renderer's current, safe projection. */
function normalizeSwimlaneModel(swimlaneValue: unknown): SwimlaneModel {
  const model = runtimeRecord(swimlaneValue) ?? {};
  const rawStart = runtimeTimestamp(model.startTime);
  const rawEnd = runtimeTimestamp(model.endTime);
  const axisStart = rawStart ?? rawEnd ?? 0;
  const axisEnd =
    rawStart !== undefined && rawEnd !== undefined && rawEnd >= rawStart ? rawEnd : axisStart;
  const schemaVersion = finiteNumber(model.schemaVersion);
  const legacy =
    schemaVersion === undefined || !Number.isInteger(schemaVersion) || schemaVersion <= 0;
  const parentIds = new Set<string>();
  const evidenceIds = new Set<string>();
  const markIds = new Set<string>();
  const rowIds = new Set<string>();
  const activationIds = new Set<string>();
  const parentSegments = (Array.isArray(model.parentSegments) ? model.parentSegments : []).flatMap(
    (value, index): SwimlaneParentSegment[] => {
      const candidate = runtimeRecord(value);
      if (!candidate) return [];
      const interval = clippedInterval(candidate, axisStart, axisEnd);
      if (!interval) return [];
      const type = normalizedParentType(candidate.type, legacy);
      const retainLegacyWorkDetails = !legacy || candidate.type === 'work';
      const metrics = retainLegacyWorkDetails ? runtimeMetrics(candidate.metrics) : undefined;
      const chunkId = retainLegacyWorkDetails
        ? runtimeNonblankString(candidate.chunkId)
        : undefined;
      const explicitTarget = retainLegacyWorkDetails ? runtimeTarget(candidate.target) : undefined;
      const target =
        explicitTarget ??
        (legacy && candidate.type === 'work' && chunkId
          ? { kind: 'turn' as const, groupId: chunkId }
          : undefined);
      const retainsEvidenceLink =
        !legacy && isParentType(candidate.type) && type !== 'unattributed';
      const evidenceId = retainsEvidenceLink
        ? runtimeNonblankString(candidate.evidenceId)
        : undefined;
      return [
        {
          id: uniqueRuntimeId(candidate.id, `parent-${index}`, parentIds),
          type,
          ...interval,
          ...(evidenceId ? { evidenceId } : {}),
          ...(metrics ? { metrics } : {}),
          ...(retainLegacyWorkDetails && runtimeNonblankString(candidate.requestId)
            ? { requestId: runtimeNonblankString(candidate.requestId) }
            : {}),
          ...(chunkId ? { chunkId } : {}),
          ...(target ? { target } : {}),
        },
      ];
    }
  );
  const evidence = (!legacy && Array.isArray(model.evidence) ? model.evidence : []).flatMap(
    (value, index): SwimlaneModel['evidence'] => {
      const candidate = runtimeRecord(value);
      if (!candidate) return [];
      const start = runtimeTimestamp(candidate.startTime);
      const end = runtimeTimestamp(candidate.endTime);
      if (
        start === undefined ||
        end === undefined ||
        end < start ||
        !isEvidenceType(candidate.type)
      ) {
        return [];
      }
      const metrics = runtimeMetrics(candidate.metrics);
      const target = runtimeTarget(candidate.target);
      return [
        {
          id: uniqueRuntimeId(candidate.id, `evidence-${index}`, evidenceIds),
          type: candidate.type,
          startTime: new Date(start),
          endTime: new Date(end),
          durationMs: end - start,
          ...(typeof candidate.requestId === 'string' ? { requestId: candidate.requestId } : {}),
          ...(typeof candidate.toolUseId === 'string' ? { toolUseId: candidate.toolUseId } : {}),
          ...(typeof candidate.processId === 'string' ? { processId: candidate.processId } : {}),
          ...(typeof candidate.startMessageId === 'string'
            ? { startMessageId: candidate.startMessageId }
            : {}),
          ...(typeof candidate.endMessageId === 'string'
            ? { endMessageId: candidate.endMessageId }
            : {}),
          ...(typeof candidate.label === 'string' ? { label: candidate.label } : {}),
          ...(metrics ? { metrics } : {}),
          ...(target ? { target } : {}),
        },
      ];
    }
  );
  const hitlMarks = (Array.isArray(model.hitlMarks) ? model.hitlMarks : []).flatMap(
    (value, index): SwimlaneModel['hitlMarks'] => {
      const candidate = runtimeRecord(value);
      const markTime = candidate ? runtimeTimestamp(candidate.timestamp) : undefined;
      const validTypeSourcePair =
        candidate &&
        typeof candidate.type === 'string' &&
        ((['ask', 'answer'].includes(candidate.type) && candidate.source === 'explicit-ask') ||
          (['resume-start', 'resume'].includes(candidate.type) &&
            candidate.source === 'linked-resume'));
      if (
        !candidate ||
        markTime === undefined ||
        !validTypeSourcePair ||
        markTime < axisStart ||
        markTime > axisEnd
      ) {
        return [];
      }
      return [
        {
          id: uniqueRuntimeId(candidate.id, `mark-${index}`, markIds),
          type: candidate.type as SwimlaneModel['hitlMarks'][number]['type'],
          timestamp: new Date(markTime),
          source: candidate.source as SwimlaneModel['hitlMarks'][number]['source'],
          ...(typeof candidate.toolUseId === 'string' ? { toolUseId: candidate.toolUseId } : {}),
        },
      ];
    }
  );
  const childRows = (Array.isArray(model.childRows) ? model.childRows : []).flatMap(
    (rowValue, rowIndex): SwimlaneModel['childRows'] => {
      const candidate = runtimeRecord(rowValue);
      if (!candidate) return [];
      const activations = (
        Array.isArray(candidate.activations) ? candidate.activations : []
      ).flatMap(
        (activationValue, activationIndex): SwimlaneModel['childRows'][number]['activations'] => {
          const activation = runtimeRecord(activationValue);
          if (!activation) return [];
          const interval = clippedInterval(activation, axisStart, axisEnd);
          if (!interval) return [];
          const metrics = runtimeMetrics(activation.metrics);
          const target = runtimeTarget(activation.target);
          return [
            {
              id: uniqueRuntimeId(
                activation.id,
                `activation-${rowIndex}-${activationIndex}`,
                activationIds
              ),
              processId:
                runtimeNonblankString(activation.processId) ??
                `process-${rowIndex}-${activationIndex}`,
              ...interval,
              ...(metrics ? { metrics } : {}),
              ...(target ? { target } : {}),
            },
          ];
        }
      );
      return [
        {
          id: uniqueRuntimeId(candidate.id, `child-${rowIndex}`, rowIds),
          label: runtimeString(candidate.label) ?? `Child ${rowIndex + 1}`,
          parentRowId: runtimeString(candidate.parentRowId) ?? null,
          depth: Math.max(0, Math.floor(finiteNumber(candidate.depth) ?? 0)),
          activations,
        },
      ];
    }
  );

  return {
    schemaVersion: SWIMLANE_SCHEMA_VERSION,
    startTime: new Date(axisStart),
    endTime: new Date(axisEnd),
    durationMs: axisEnd - axisStart,
    evidence,
    parentSegments,
    hitlMarks,
    childRows,
  };
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
    width: `${width}%`,
  };
}

function intervalPixelWidth(
  startTime: Date | string,
  endTime: Date | string,
  axisStart: number,
  axisDuration: number,
  clockWidth: number
): number {
  if (axisDuration <= 0) return 0;
  const start = percentage(startTime, axisStart, axisDuration);
  const end = percentage(endTime, axisStart, axisDuration);
  return Math.max(0, ((end - start) / 100) * clockWidth);
}

function exactNumber(value: number): string {
  return value.toLocaleString();
}

function segmentTreatment(segment: SwimlaneParentSegment): CSSProperties {
  switch (segment.type) {
    case 'assistant-output':
      return {
        backgroundColor: 'var(--context-btn-active-bg)',
        border: '1px solid var(--color-border-emphasis)',
        color: 'var(--context-btn-active-text)',
      };
    case 'model-response':
      return {
        backgroundColor: 'var(--card-header-hover)',
        border: '1px solid var(--color-border-emphasis)',
        color: 'var(--card-text-lighter)',
      };
    case 'tool-execution':
      return {
        backgroundColor: 'var(--color-surface-raised)',
        border: '1px solid var(--color-border-emphasis)',
        color: 'var(--color-text-secondary)',
      };
    case 'child-wait':
      return {
        backgroundColor: 'transparent',
        backgroundImage:
          'repeating-linear-gradient(135deg, transparent 0, transparent 3px, var(--color-border) 3px, var(--color-border) 5px)',
        border: '1px solid var(--color-border-emphasis)',
      };
    case 'human-wait':
      return {
        backgroundColor: 'var(--warning-bg)',
        border: '1px solid var(--warning-border)',
        color: 'var(--warning-text)',
      };
    case 'unattributed':
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

function requestIdentity(segment: SwimlaneParentSegment): string {
  if (segment.requestId) return `request:${segment.requestId}`;
  if (segment.chunkId) return `chunk:${segment.chunkId}`;
  return `id:${segment.id.replace(/-part-\d+$/, '')}`;
}

function segmentLabel(type: SwimlaneParentSegment['type']): string {
  switch (type) {
    case 'model-response':
      return 'model response';
    case 'assistant-output':
      return 'assistant output';
    case 'tool-execution':
      return 'tool execution';
    case 'child-wait':
      return 'child wait';
    case 'human-wait':
      return 'human wait';
    case 'unattributed':
      return 'unattributed';
  }
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
        labelElement.getBoundingClientRect().width || labelElement.scrollWidth || label.length * 6;
      const fallbackContentWidth = Math.max(0, fallbackWidth - horizontalBorderWidth);
      const availableWidth = (contentWidth || fallbackContentWidth) - LABEL_HORIZONTAL_PADDING * 2;
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
      (left, right) => left.idealPixel - right.idealPixel || left.sourceIndex - right.sourceIndex
    );
  const minimumPixel = Math.min(1, clockWidth / 2);
  const maximumPixel = Math.max(minimumPixel, clockWidth - minimumPixel);
  const availableWidth = Math.max(0, maximumPixel - minimumPixel);
  const tickGap =
    ordered.length <= 1 ? 0 : Math.min(MIN_HITL_TICK_GAP, availableWidth / (ordered.length - 1));
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

const swimlaneModelKeys = new WeakMap<object, number>();
let nextSwimlaneModelKey = 1;

function swimlaneModelKey(swimlane: unknown): string {
  if (typeof swimlane !== 'object' || swimlane === null) {
    return `primitive:${typeof swimlane}:${String(swimlane)}`;
  }
  const existing = swimlaneModelKeys.get(swimlane);
  if (existing !== undefined) return `model:${existing}`;
  const key = nextSwimlaneModelKey++;
  swimlaneModelKeys.set(swimlane, key);
  return `model:${key}`;
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
  const requestMetrics = new Map<string, SessionMetrics>();
  for (const segment of swimlane.parentSegments) {
    if (segment.type === 'assistant-output' && segment.metrics) {
      requestMetrics.set(requestIdentity(segment), segment.metrics);
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
  const visibleParentSegments = swimlane.parentSegments.filter(
    (segment) =>
      intervalPixelWidth(segment.startTime, segment.endTime, axisStart, axisDuration, clockWidth) >=
      MIN_MEANINGFUL_INTERVAL_WIDTH
  );
  const visibleEvidenceIds = new Set(
    visibleParentSegments
      .map((segment) => segment.evidenceId)
      .filter((id): id is string => id !== undefined)
  );
  const evidenceIds = new Set((swimlane.evidence ?? []).map((evidence) => evidence.id));
  const suppressedEvidence: SuppressedInterval[] = (swimlane.evidence ?? [])
    .filter((evidence) => !visibleEvidenceIds.has(evidence.id))
    .map((evidence) => {
      const causalIdentity =
        evidence.label ?? evidence.toolUseId ?? evidence.requestId ?? evidence.processId;
      const identitySuffix = causalIdentity ? ` (${causalIdentity})` : '';
      return {
        id: `evidence:${evidence.id}`,
        identity: `${segmentLabel(evidence.type)}${identitySuffix}`,
        details: { durationMs: evidence.durationMs, metrics: evidence.metrics },
        target: evidence.target,
      };
    });
  const suppressedLegacySegments: SuppressedInterval[] = swimlane.parentSegments
    .filter(
      (segment) =>
        segment.type !== 'unattributed' &&
        (!segment.evidenceId || !evidenceIds.has(segment.evidenceId)) &&
        intervalPixelWidth(
          segment.startTime,
          segment.endTime,
          axisStart,
          axisDuration,
          clockWidth
        ) < MIN_MEANINGFUL_INTERVAL_WIDTH
    )
    .map((segment) => ({
      id: `parent:${segment.id}`,
      identity: segmentLabel(segment.type),
      details: { durationMs: segment.durationMs, metrics: segment.metrics },
      target: segment.target,
    }));
  const suppressedActivations: SuppressedInterval[] = swimlane.childRows.flatMap((row) =>
    row.activations
      .filter(
        (activation) =>
          intervalPixelWidth(
            activation.startTime,
            activation.endTime,
            axisStart,
            axisDuration,
            clockWidth
          ) < MIN_MEANINGFUL_INTERVAL_WIDTH
      )
      .map((activation) => ({
        id: `activation:${row.id}:${activation.id}`,
        identity: `${row.label} activation`,
        details: { durationMs: activation.durationMs, metrics: activation.metrics },
        target: activation.target,
      }))
  );
  const suppressedIntervals = [
    ...suppressedEvidence,
    ...suppressedLegacySegments,
    ...suppressedActivations,
  ];
  const suppressedCount = suppressedIntervals.length;
  const displayedSuppressedIntervals = suppressedIntervals.slice(0, SUPPRESSED_DETAIL_LIMIT);

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
              <span
                aria-label="Elapsed start"
                data-testid="swimlane-axis-start"
                style={{ left: 0, position: 'absolute', top: '4px' }}
              >
                0ms
              </span>
              <span
                aria-label={`Elapsed midpoint ${formatDuration(axisDuration / 2)}`}
                data-testid="swimlane-axis-midpoint"
                style={{
                  left: '50%',
                  position: 'absolute',
                  top: '4px',
                  transform: 'translateX(-50%)',
                }}
              >
                {formatDuration(axisDuration / 2)}
              </span>
              <span
                aria-label={`Elapsed endpoint ${formatDuration(axisDuration)}`}
                data-testid="swimlane-axis-endpoint"
                style={{ position: 'absolute', right: 0, top: '4px' }}
              >
                {formatDuration(axisDuration)}
              </span>
            </div>
          </div>

          <div data-testid="swimlane-parent-row" style={rowStyle}>
            <div
              style={{ ...labelStyle, color: 'var(--color-text)', fontWeight: 600 }}
              title="Parent"
            >
              Parent
            </div>
            <div ref={clockRef} data-clock-width={clockWidth} style={clockStyle}>
              <div aria-hidden="true" style={baseTrackStyle} />
              {visibleParentSegments.map((segment) => {
                const intervalKey = intervalIdentity('parent', segment.id);
                const metrics =
                  segment.type === 'assistant-output'
                    ? (segment.metrics ?? requestMetrics.get(requestIdentity(segment)))
                    : undefined;
                const details = { durationMs: segment.durationMs, metrics };
                const identity = `Parent ${segmentLabel(segment.type)}`;
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
                      zIndex: segment.type === 'assistant-output' ? 2 : 1,
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
                  {row.activations
                    .filter(
                      (activation) =>
                        intervalPixelWidth(
                          activation.startTime,
                          activation.endTime,
                          axisStart,
                          axisDuration,
                          clockWidth
                        ) >= MIN_MEANINGFUL_INTERVAL_WIDTH
                    )
                    .map((activation) => {
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
          {suppressedCount > 0 && (
            <details
              data-suppressed-count={suppressedCount}
              data-testid="swimlane-suppressed-activity"
              style={{
                color: 'var(--color-text-muted)',
                fontSize: '10px',
                marginLeft: `${LABEL_COLUMN_WIDTH}px`,
                padding: '6px 8px 0',
              }}
            >
              <summary aria-label={`${suppressedCount} hidden evidence intervals`}>
                {suppressedCount} hidden evidence {suppressedCount === 1 ? 'interval' : 'intervals'}
              </summary>
              <ul style={{ margin: '4px 0 0', paddingLeft: '18px' }}>
                {displayedSuppressedIntervals.map((interval) => {
                  const metrics = interval.details.metrics;
                  const text = `${interval.identity} — ${formatDuration(interval.details.durationMs)}${
                    metrics
                      ? `; input ${exactNumber(metrics.inputTokens)}, cache read ${exactNumber(metrics.cacheReadTokens)}, cache write ${exactNumber(metrics.cacheCreationTokens)}, output ${exactNumber(metrics.outputTokens)}`
                      : ''
                  }`;
                  return (
                    <li key={interval.id}>
                      {interval.target && onTarget ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (interval.target) onTarget(interval.target);
                          }}
                          style={{
                            background: 'none',
                            border: 0,
                            color: 'inherit',
                            cursor: 'pointer',
                            font: 'inherit',
                            padding: 0,
                            textAlign: 'left',
                            textDecoration: 'underline',
                          }}
                        >
                          {text}
                        </button>
                      ) : (
                        text
                      )}
                    </li>
                  );
                })}
              </ul>
              {suppressedCount > displayedSuppressedIntervals.length && (
                <div>
                  +{suppressedCount - displayedSuppressedIntervals.length} more retained in the
                  model
                </div>
              )}
            </details>
          )}
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

export const SwimlaneSurface = ({ swimlane, onTarget }: SwimlaneSurfaceProps): JSX.Element => {
  const normalizedSwimlane = normalizeSwimlaneModel(swimlane);
  return (
    <SwimlaneSurfaceContent
      key={swimlaneModelKey(swimlane)}
      swimlane={normalizedSwimlane}
      onTarget={onTarget}
    />
  );
};
