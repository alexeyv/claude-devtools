import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
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
import type {
  CSSProperties,
  FocusEvent,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';

const LABEL_COLUMN_WIDTH = 184;
const CANVAS_HORIZONTAL_PADDING = 16;
const UNMEASURED_CLOCK_WIDTH = 720;
const MIN_MEANINGFUL_INTERVAL_WIDTH = 1;
const ROW_HEIGHT = 34;
const RULER_HEIGHT = 28;
const TRACK_INSET = 6;
const LABEL_HORIZONTAL_PADDING = 8;
const MAX_VISIBLE_DEPTH = 7;
const DEPTH_INDENT = 12;
const TOOLTIP_MARGIN = 8;
const TOOLTIP_GAP = 6;
const TOOLTIP_Z_INDEX = 99_999;
const MIN_HITL_TICK_GAP = 3;
const SUPPRESSED_DETAIL_LIMIT = 50;
const MIN_ZOOM_LEVEL = 0;
const MIN_VIEWPORT_DURATION_MS = 100;
const TARGET_RULER_TICK_COUNT = 10;
const MAX_RULER_TICK_COUNT = 20;
const ESTIMATED_RULER_CHARACTER_WIDTH = 6;
const RULER_LABEL_GAP = 8;
const HOVER_LABEL_GAP = 8;
const HOVER_LABEL_HEIGHT = 20;
const HOVER_LABEL_HORIZONTAL_PADDING = 6;
const HOVER_LABEL_BORDER_WIDTH = 1;
const HOVER_LABEL_FONT_SIZE = 10;
const HOVER_LABEL_WIDTH_SLACK = 1;
const FALLBACK_HOVER_CHARACTER_EM_WIDTH = 0.62;
const HOVER_CHARACTER_EM_WIDTHS: Record<string, number> = {
  ' ': 0.3,
  '.': 0.32,
  h: 0.62,
  m: 0.92,
  s: 0.54,
};
const HOVER_LABEL_Z_INDEX = 7;
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

interface HoverCursor {
  guideLeft: number;
  label: string;
  labelHeight: number;
  labelLeft: number;
  labelTop: number;
  labelWidth: number;
}

interface PointerPosition {
  clientX: number;
  clientY: number;
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
  const childEvidenceIds = new Set<string>();
  const childSegmentIds = new Set<string>();
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
          const activationStart = interval.startTime.getTime();
          const activationEnd = interval.endTime.getTime();
          const childEvidenceIdMap = new Map<string, string>();
          const childEvidence = Array.isArray(activation.evidence)
            ? activation.evidence.flatMap((evidenceValue, evidenceIndex) => {
                const childEvidenceCandidate = runtimeRecord(evidenceValue);
                if (!childEvidenceCandidate || !isEvidenceType(childEvidenceCandidate.type)) {
                  return [];
                }
                const evidenceInterval = clippedInterval(
                  childEvidenceCandidate,
                  activationStart,
                  activationEnd
                );
                if (!evidenceInterval) return [];
                const evidenceMetrics = runtimeMetrics(childEvidenceCandidate.metrics);
                const rawEvidenceId = runtimeNonblankString(childEvidenceCandidate.id);
                const normalizedEvidenceId = uniqueRuntimeId(
                  rawEvidenceId,
                  `child-evidence-${rowIndex}-${activationIndex}-${evidenceIndex}`,
                  childEvidenceIds
                );
                if (rawEvidenceId && !childEvidenceIdMap.has(rawEvidenceId)) {
                  childEvidenceIdMap.set(rawEvidenceId, normalizedEvidenceId);
                }
                return [
                  {
                    id: normalizedEvidenceId,
                    type: childEvidenceCandidate.type,
                    ...evidenceInterval,
                    ...(typeof childEvidenceCandidate.requestId === 'string'
                      ? { requestId: childEvidenceCandidate.requestId }
                      : {}),
                    ...(typeof childEvidenceCandidate.toolUseId === 'string'
                      ? { toolUseId: childEvidenceCandidate.toolUseId }
                      : {}),
                    ...(typeof childEvidenceCandidate.processId === 'string'
                      ? { processId: childEvidenceCandidate.processId }
                      : {}),
                    ...(typeof childEvidenceCandidate.startMessageId === 'string'
                      ? { startMessageId: childEvidenceCandidate.startMessageId }
                      : {}),
                    ...(typeof childEvidenceCandidate.endMessageId === 'string'
                      ? { endMessageId: childEvidenceCandidate.endMessageId }
                      : {}),
                    ...(typeof childEvidenceCandidate.label === 'string'
                      ? { label: childEvidenceCandidate.label }
                      : {}),
                    ...(evidenceMetrics ? { metrics: evidenceMetrics } : {}),
                    ...(target ? { target } : {}),
                  },
                ];
              })
            : undefined;
          const childSegments = Array.isArray(activation.segments)
            ? activation.segments.flatMap((segmentValue, segmentIndex) => {
                const segment = runtimeRecord(segmentValue);
                if (!segment || !isParentType(segment.type)) return [];
                const segmentInterval = clippedInterval(segment, activationStart, activationEnd);
                if (!segmentInterval) return [];
                const segmentMetrics = runtimeMetrics(segment.metrics);
                const rawEvidenceId = runtimeNonblankString(segment.evidenceId);
                const evidenceId = rawEvidenceId
                  ? (childEvidenceIdMap.get(rawEvidenceId) ?? rawEvidenceId)
                  : undefined;
                return [
                  {
                    id: uniqueRuntimeId(
                      segment.id,
                      `child-segment-${rowIndex}-${activationIndex}-${segmentIndex}`,
                      childSegmentIds
                    ),
                    type: segment.type,
                    ...segmentInterval,
                    ...(evidenceId ? { evidenceId } : {}),
                    ...(segmentMetrics ? { metrics: segmentMetrics } : {}),
                    ...(runtimeNonblankString(segment.requestId)
                      ? { requestId: runtimeNonblankString(segment.requestId) }
                      : {}),
                    ...(target ? { target } : {}),
                  },
                ];
              })
            : undefined;
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
              ...(childEvidence ? { evidence: childEvidence } : {}),
              ...(childSegments && childSegments.length > 0 ? { segments: childSegments } : {}),
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

interface RulerTick {
  alignment: 'center' | 'end' | 'start';
  elapsedMs: number;
  estimatedLabelEndPixel: number;
  estimatedLabelStartPixel: number;
  label: string;
}

interface UnpositionedRulerTick {
  elapsedMs: number;
  label: string;
}

function maximumZoomLevel(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= MIN_VIEWPORT_DURATION_MS) {
    return MIN_ZOOM_LEVEL;
  }
  return Math.max(MIN_ZOOM_LEVEL, Math.floor(Math.log2(durationMs / MIN_VIEWPORT_DURATION_MS)));
}

function decimalPlacesForStep(stepMs: number): number {
  if (stepMs < 10) return 3;
  if (stepMs < 100) return 2;
  if (stepMs < 1000) return 1;
  return 0;
}

function formattedSeconds(milliseconds: number, precision: number): string {
  const seconds = milliseconds / 1000;
  return precision > 0 ? seconds.toFixed(precision) : String(Math.round(seconds));
}

function formatElapsedTime(elapsedMs: number, stepMs: number): string {
  const normalizedElapsed = Math.max(0, Math.round(elapsedMs * 1000) / 1000);
  if (normalizedElapsed < 1000) {
    const precision = stepMs < 1 ? Math.min(3, Math.max(0, Math.ceil(-Math.log10(stepMs)))) : 0;
    const roundedMilliseconds = Number(normalizedElapsed.toFixed(precision));
    if (roundedMilliseconds < 1000) return `${roundedMilliseconds.toFixed(precision)}ms`;
  }

  const secondsPrecision = decimalPlacesForStep(stepMs);
  const roundingIncrementMs = 1000 / 10 ** secondsPrecision;
  const roundedElapsed = Math.round(normalizedElapsed / roundingIncrementMs) * roundingIncrementMs;
  const wholeHours = Math.floor(roundedElapsed / 3_600_000);
  const afterHours = roundedElapsed - wholeHours * 3_600_000;
  const wholeMinutes = Math.floor(afterHours / 60_000);
  const afterMinutes = afterHours - wholeMinutes * 60_000;
  const seconds = formattedSeconds(afterMinutes, secondsPrecision);

  if (wholeHours > 0) {
    if (wholeMinutes === 0 && afterMinutes === 0) return `${wholeHours}h`;
    if (afterMinutes === 0) return `${wholeHours}h ${wholeMinutes}m`;
    return `${wholeHours}h ${wholeMinutes}m ${seconds}s`;
  }
  if (wholeMinutes > 0) {
    if (afterMinutes === 0) return `${wholeMinutes}m`;
    return `${wholeMinutes}m ${seconds}s`;
  }
  return `${formattedSeconds(roundedElapsed, secondsPrecision)}s`;
}

let hoverLabelRuler: HTMLElement | null | undefined;

// Measured in the DOM rather than on a canvas so the label's inherited font
// stack and tabular figures are honoured; canvas measureText ignores both.
function hoverLabelRulerElement(): HTMLElement | null {
  if (hoverLabelRuler === undefined) {
    try {
      const ruler = document.createElement('span');
      ruler.setAttribute('aria-hidden', 'true');
      ruler.style.cssText = [
        'position:absolute',
        'left:-9999px',
        'top:0',
        'visibility:hidden',
        'pointer-events:none',
        'white-space:pre',
        'padding:0',
        'border:0',
        `font-size:${HOVER_LABEL_FONT_SIZE}px`,
        'font-variant-numeric:tabular-nums',
      ].join(';');
      document.body.appendChild(ruler);
      hoverLabelRuler = ruler;
    } catch {
      hoverLabelRuler = null;
    }
  }
  return hoverLabelRuler ?? null;
}

function estimatedHoverTextWidth(label: string): number {
  let ems = 0;
  for (const character of label) {
    ems += HOVER_CHARACTER_EM_WIDTHS[character] ?? FALLBACK_HOVER_CHARACTER_EM_WIDTH;
  }
  return ems * HOVER_LABEL_FONT_SIZE;
}

function hoverLabelWidth(label: string): number {
  let textWidth = estimatedHoverTextWidth(label);
  const ruler = hoverLabelRulerElement();
  if (ruler) {
    ruler.textContent = label;
    const measured = ruler.getBoundingClientRect().width;
    if (Number.isFinite(measured) && measured > 0) textWidth = measured;
  }
  return Math.ceil(
    textWidth +
      HOVER_LABEL_HORIZONTAL_PADDING * 2 +
      HOVER_LABEL_BORDER_WIDTH * 2 +
      HOVER_LABEL_WIDTH_SLACK
  );
}

function powerOfTenNiceStep(targetMs: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(Number.MIN_VALUE, targetMs)));
  const normalized = targetMs / magnitude;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * magnitude;
}

function niceTimeStep(targetMs: number): number {
  if (!Number.isFinite(targetMs) || targetMs <= 0) return 1;
  if (targetMs <= 10_000) return powerOfTenNiceStep(targetMs);

  const conventionalSteps = [
    15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000,
    10_800_000, 21_600_000, 43_200_000, 86_400_000,
  ];
  return conventionalSteps.find((step) => step >= targetMs) ?? powerOfTenNiceStep(targetMs);
}

function nextNiceTimeStep(stepMs: number): number {
  return niceTimeStep(stepMs * 1.001);
}

function ticksForStep(
  axisDuration: number,
  visibleStartMs: number,
  visibleEndMs: number,
  stepMs: number
): UnpositionedRulerTick[] {
  if (axisDuration <= 0) return [{ elapsedMs: 0, label: '0ms' }];
  const firstIndex = Math.max(0, Math.ceil(visibleStartMs / stepMs - 1e-9));
  const lastIndex = Math.min(
    Math.floor(axisDuration / stepMs + 1e-9),
    Math.floor(visibleEndMs / stepMs + 1e-9)
  );
  if (lastIndex < firstIndex) return [];
  return Array.from({ length: lastIndex - firstIndex + 1 }, (_, offset) => {
    const elapsedMs = (firstIndex + offset) * stepMs;
    return { elapsedMs, label: formatElapsedTime(elapsedMs, stepMs) };
  });
}

function positionedRulerTick(
  tick: UnpositionedRulerTick,
  axisDuration: number,
  clockWidth: number,
  visibleStartPixel: number,
  visibleEndPixel: number
): RulerTick | undefined {
  const tickPixel = (tick.elapsedMs / axisDuration) * clockWidth;
  const labelWidth = tick.label.length * ESTIMATED_RULER_CHARACTER_WIDTH;
  if (labelWidth > visibleEndPixel - visibleStartPixel) return undefined;

  let alignment: RulerTick['alignment'] = 'center';
  if (tick.elapsedMs === 0) alignment = 'start';
  else if (tick.elapsedMs === axisDuration) alignment = 'end';
  else if (tickPixel - labelWidth / 2 < visibleStartPixel) alignment = 'start';
  else if (tickPixel + labelWidth / 2 > visibleEndPixel) alignment = 'end';

  const estimatedLabelStartPixel =
    alignment === 'start'
      ? tickPixel
      : alignment === 'end'
        ? tickPixel - labelWidth
        : tickPixel - labelWidth / 2;
  const estimatedLabelEndPixel = estimatedLabelStartPixel + labelWidth;
  if (
    estimatedLabelStartPixel < visibleStartPixel - Number.EPSILON ||
    estimatedLabelEndPixel > visibleEndPixel + Number.EPSILON
  ) {
    return undefined;
  }
  return { ...tick, alignment, estimatedLabelEndPixel, estimatedLabelStartPixel };
}

function rulerLabelsDoNotOverlap(ticks: RulerTick[]): boolean {
  return ticks.every(
    (tick, index) =>
      index === 0 ||
      tick.estimatedLabelStartPixel - ticks[index - 1].estimatedLabelEndPixel >= RULER_LABEL_GAP
  );
}

function visibleRulerTicks(
  axisDuration: number,
  clockWidth: number,
  visibleClockWidth: number,
  scrollLeft: number
): RulerTick[] {
  if (axisDuration <= 0 || clockWidth <= 0 || visibleClockWidth <= 0) {
    return [
      {
        alignment: 'start',
        elapsedMs: 0,
        estimatedLabelEndPixel: 0,
        estimatedLabelStartPixel: 0,
        label: '0ms',
      },
    ];
  }
  const visibleStartPixel = clamp(scrollLeft, 0, clockWidth);
  const visibleEndPixel = clamp(scrollLeft + visibleClockWidth, visibleStartPixel, clockWidth);
  const visibleStartMs = (visibleStartPixel / clockWidth) * axisDuration;
  const visibleEndMs = clamp(
    (visibleEndPixel / clockWidth) * axisDuration,
    visibleStartMs,
    axisDuration
  );
  const visibleDurationMs = Math.max(0, visibleEndMs - visibleStartMs);
  let stepMs = niceTimeStep(visibleDurationMs / TARGET_RULER_TICK_COUNT);
  let fallbackTick: RulerTick | undefined;

  for (let attempt = 0; attempt < 32; attempt++) {
    const ticks = ticksForStep(axisDuration, visibleStartMs, visibleEndMs, stepMs).flatMap(
      (tick) => {
        const positioned = positionedRulerTick(
          tick,
          axisDuration,
          clockWidth,
          visibleStartPixel,
          visibleEndPixel
        );
        return positioned ? [positioned] : [];
      }
    );
    if (ticks.length > 0) {
      const visibleCenterPixel = (visibleStartPixel + visibleEndPixel) / 2;
      fallbackTick = ticks.slice(1).reduce((closest, tick) => {
        const closestDistance = Math.abs(
          (closest.elapsedMs / axisDuration) * clockWidth - visibleCenterPixel
        );
        const tickDistance = Math.abs(
          (tick.elapsedMs / axisDuration) * clockWidth - visibleCenterPixel
        );
        return tickDistance < closestDistance ? tick : closest;
      }, ticks[0]);
    }
    if (
      ticks.length > 0 &&
      ticks.length <= MAX_RULER_TICK_COUNT &&
      rulerLabelsDoNotOverlap(ticks)
    ) {
      return ticks;
    }
    const nextStep = nextNiceTimeStep(stepMs);
    if (nextStep <= stepMs || !Number.isFinite(nextStep)) break;
    stepMs = nextStep;
  }
  return fallbackTick ? [fallbackTick] : [];
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

function intervalIdentity(
  namespace: 'activation' | 'child-segment' | 'parent',
  ...parts: string[]
): string {
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

const baseRowStyle: CSSProperties = {
  display: 'grid',
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
  minWidth: 0,
  position: 'relative',
};

const zoomButtonClassName =
  'inline-flex min-h-8 items-center justify-center rounded border border-border bg-surface-raised px-2 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-overlay hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-emphasis disabled:cursor-not-allowed disabled:opacity-40';

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
        zIndex: TOOLTIP_Z_INDEX,
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

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The native two-axis scroll viewport must be keyboard focusable. */
const SwimlaneSurfaceContent = ({ swimlane, onTarget }: SwimlaneSurfaceProps): JSX.Element => {
  const axisStart = timestamp(swimlane.startTime);
  const axisEnd = timestamp(swimlane.endTime);
  const axisDuration = Math.max(0, axisEnd - axisStart);
  const rawTooltipId = useId();
  const tooltipId = `swimlane-tooltip-${rawTooltipId.replaceAll(':', '')}`;
  const scaleOutputId = `${tooltipId}-scale`;
  const rulerDescriptionId = `${tooltipId}-ruler-description`;
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const pendingCenterRef = useRef<number | null>(null);
  const rulerPanRef = useRef<{ clientX: number; scrollLeft: number } | null>(null);
  const hoverFrameRef = useRef<number | null>(null);
  const pointerPositionRef = useRef<PointerPosition | null>(null);
  const pointerTargetRef = useRef<HTMLElement | null>(null);
  const activationOrderRef = useRef(0);
  const [fitClockWidth, setFitClockWidth] = useState(UNMEASURED_CLOCK_WIDTH);
  const [zoomLevel, setZoomLevel] = useState(MIN_ZOOM_LEVEL);
  const [viewportScrollLeft, setViewportScrollLeft] = useState(0);
  const [hoveredInterval, setHoveredInterval] = useState<ActiveInterval | null>(null);
  const [focusedInterval, setFocusedInterval] = useState<ActiveInterval | null>(null);
  const [hoverCursor, setHoverCursor] = useState<HoverCursor | null>(null);
  const maxZoomLevel = maximumZoomLevel(axisDuration);
  const boundedZoomLevel = Math.min(zoomLevel, maxZoomLevel);
  const zoomFactor = 2 ** boundedZoomLevel;
  const zoomPercent = zoomFactor * 100;
  const clockWidth = Math.max(1, fitClockWidth * zoomFactor);
  const rulerTicks = visibleRulerTicks(axisDuration, clockWidth, fitClockWidth, viewportScrollLeft);
  const rowStyle: CSSProperties = {
    ...baseRowStyle,
    gridTemplateColumns: `${LABEL_COLUMN_WIDTH}px ${clockWidth}px`,
    width: `${LABEL_COLUMN_WIDTH + clockWidth}px`,
  };
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

  const clearHoverCursor = useCallback((): void => {
    if (hoverFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(hoverFrameRef.current);
    }
    hoverFrameRef.current = null;
    pointerPositionRef.current = null;
    pointerTargetRef.current = null;
    setHoverCursor(null);
  }, []);

  const recomputeHoverCursor = useCallback(
    (position: PointerPosition, targetOverride?: EventTarget | null): void => {
      const viewport = viewportRef.current;
      const canvas = canvasRef.current;
      if (!viewport || !canvas || !Number.isFinite(position.clientX + position.clientY)) {
        clearHoverCursor();
        return;
      }

      const hitTarget =
        targetOverride instanceof HTMLElement
          ? targetOverride
          : typeof document.elementFromPoint === 'function'
            ? document.elementFromPoint(position.clientX, position.clientY)
            : pointerTargetRef.current;
      const clockRegion = hitTarget?.closest<HTMLElement>('[data-swimlane-clock-region="true"]');
      if (!clockRegion || !canvas.contains(clockRegion)) {
        clearHoverCursor();
        return;
      }

      const clockRect = clockRegion.getBoundingClientRect();
      const insideClock =
        position.clientX >= clockRect.left &&
        position.clientX <= clockRect.right &&
        position.clientY >= clockRect.top &&
        position.clientY <= clockRect.bottom;
      if (!insideClock || !Number.isFinite(clockRect.width) || clockRect.width <= 0) {
        clearHoverCursor();
        return;
      }

      const elapsedPixel = clamp(position.clientX - clockRect.left, 0, clockRect.width);
      const guideLeft = Math.min(elapsedPixel, Math.max(0, clockRect.width - 1));
      const elapsedMs =
        axisDuration > 0
          ? clamp((elapsedPixel / clockRect.width) * axisDuration, 0, axisDuration)
          : 0;
      const clockResolutionMs = axisDuration > 0 ? axisDuration / clockRect.width : 1;
      const label = formatElapsedTime(elapsedMs, clockResolutionMs);
      const viewportRect = viewport.getBoundingClientRect();
      const contentLeft = viewportRect.left + viewport.clientLeft;
      const contentTop = viewportRect.top + viewport.clientTop;
      const contentRight = contentLeft + Math.max(0, viewport.clientWidth);
      const contentBottom = contentTop + Math.max(0, viewport.clientHeight);
      const visibleLeft = Math.max(
        0,
        contentLeft + LABEL_COLUMN_WIDTH + CANVAS_HORIZONTAL_PADDING,
        clockRect.left
      );
      const visibleRight = Math.min(window.innerWidth, contentRight, clockRect.right);
      const visibleTop = Math.max(0, contentTop);
      const visibleBottom = Math.min(window.innerHeight, contentBottom);
      const availableWidth = Math.max(0, visibleRight - visibleLeft);
      const availableHeight = Math.max(0, visibleBottom - visibleTop);
      if (availableWidth <= 0 || availableHeight <= 0) {
        clearHoverCursor();
        return;
      }
      const labelWidth = Math.min(hoverLabelWidth(label), availableWidth);
      const labelHeight = Math.min(HOVER_LABEL_HEIGHT, availableHeight);
      const right = clamp(
        position.clientX + HOVER_LABEL_GAP,
        visibleLeft,
        visibleRight - labelWidth
      );
      const left = clamp(
        position.clientX - HOVER_LABEL_GAP - labelWidth,
        visibleLeft,
        visibleRight - labelWidth
      );
      const below = clamp(
        position.clientY + HOVER_LABEL_GAP,
        visibleTop,
        visibleBottom - labelHeight
      );
      const above = clamp(
        position.clientY - HOVER_LABEL_GAP - labelHeight,
        visibleTop,
        visibleBottom - labelHeight
      );
      const horizontalCandidates =
        visibleRight - position.clientX >= position.clientX - visibleLeft
          ? [right, left]
          : [left, right];
      const verticalCandidates =
        visibleBottom - position.clientY >= position.clientY - visibleTop
          ? [below, above]
          : [above, below];
      const candidates = verticalCandidates.flatMap((top) =>
        horizontalCandidates.map((candidateLeft) => ({ left: candidateLeft, top }))
      );
      const tooltip = document.getElementById(tooltipId);
      const tooltipRect =
        tooltip && tooltip.style.visibility !== 'hidden' ? tooltip.getBoundingClientRect() : null;
      const overlapsTooltip = ({
        left: candidateLeft,
        top,
      }: {
        left: number;
        top: number;
      }): boolean =>
        tooltipRect !== null &&
        candidateLeft < tooltipRect.right &&
        candidateLeft + labelWidth > tooltipRect.left &&
        top < tooltipRect.bottom &&
        top + labelHeight > tooltipRect.top;
      const placement =
        candidates.find((candidate) => !overlapsTooltip(candidate)) ?? candidates[0];

      setHoverCursor({
        guideLeft,
        label,
        labelHeight,
        labelLeft: placement.left,
        labelTop: placement.top,
        labelWidth,
      });
    },
    [axisDuration, clearHoverCursor, tooltipId]
  );

  const recomputeStoredHoverCursor = useCallback((): void => {
    if (hoverFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(hoverFrameRef.current);
    }
    hoverFrameRef.current = null;
    const position = pointerPositionRef.current;
    if (position) recomputeHoverCursor(position);
  }, [recomputeHoverCursor]);

  const scheduleHoverCursorRecompute = useCallback((): void => {
    if (hoverFrameRef.current !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      recomputeStoredHoverCursor();
      return;
    }
    hoverFrameRef.current = requestAnimationFrame(() => {
      hoverFrameRef.current = null;
      const position = pointerPositionRef.current;
      if (position) recomputeHoverCursor(position);
    });
  }, [recomputeHoverCursor, recomputeStoredHoverCursor]);

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.pointerType === 'touch') {
        clearHoverCursor();
        return;
      }
      const position = { clientX: event.clientX, clientY: event.clientY };
      pointerPositionRef.current = position;
      pointerTargetRef.current = event.target instanceof HTMLElement ? event.target : null;
      scheduleHoverCursorRecompute();
    },
    [clearHoverCursor, scheduleHoverCursorRecompute]
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = (): void => {
      // clientWidth excludes a visible vertical scrollbar, so Fit cannot create
      // horizontal overflow merely because the lane list needs vertical scrolling.
      const viewportWidth = viewport.clientWidth || viewport.getBoundingClientRect().width;
      if (viewportWidth <= 0) return;
      const nextFitClockWidth = Math.max(
        1,
        viewportWidth - LABEL_COLUMN_WIDTH - CANVAS_HORIZONTAL_PADDING * 2
      );
      if (fitClockWidth === nextFitClockWidth) return;
      if (boundedZoomLevel > MIN_ZOOM_LEVEL) {
        const currentClockWidth = fitClockWidth * 2 ** boundedZoomLevel;
        pendingCenterRef.current = clamp(
          (viewport.scrollLeft + fitClockWidth / 2) / Math.max(1, currentClockWidth),
          0,
          1
        );
      }
      closeTooltip();
      setFitClockWidth(nextFitClockWidth);
    };
    const measureAndRecompute = (): void => {
      measure();
      recomputeStoredHoverCursor();
    };
    measureAndRecompute();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measureAndRecompute);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [boundedZoomLevel, closeTooltip, fitClockWidth, recomputeStoredHoverCursor, swimlane]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (boundedZoomLevel === MIN_ZOOM_LEVEL) {
      viewport.scrollLeft = 0;
      viewport.dispatchEvent(new Event('scroll'));
      pendingCenterRef.current = null;
      return;
    }
    const center = pendingCenterRef.current;
    if (center === null) return;
    viewport.scrollLeft = clamp(
      center * clockWidth - fitClockWidth / 2,
      0,
      Math.max(0, clockWidth - fitClockWidth)
    );
    viewport.dispatchEvent(new Event('scroll'));
    pendingCenterRef.current = null;
  }, [boundedZoomLevel, clockWidth, fitClockWidth]);

  useLayoutEffect(() => {
    recomputeStoredHoverCursor();
  }, [clockWidth, recomputeStoredHoverCursor, swimlane]);

  useLayoutEffect(() => {
    if (pointerPositionRef.current) scheduleHoverCursorRecompute();
  }, [activeKey, scheduleHoverCursorRecompute]);

  useEffect(() => {
    const handleCapturedScroll = (event: Event): void => {
      if (event.target !== viewportRef.current) recomputeStoredHoverCursor();
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') clearHoverCursor();
    };
    window.addEventListener('blur', clearHoverCursor);
    window.addEventListener('resize', recomputeStoredHoverCursor);
    window.addEventListener('scroll', handleCapturedScroll, true);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('blur', clearHoverCursor);
      window.removeEventListener('resize', recomputeStoredHoverCursor);
      window.removeEventListener('scroll', handleCapturedScroll, true);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [clearHoverCursor, recomputeStoredHoverCursor]);

  useEffect(
    () => () => {
      if (hoverFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(hoverFrameRef.current);
      }
      hoverFrameRef.current = null;
      pointerPositionRef.current = null;
      pointerTargetRef.current = null;
    },
    []
  );

  const setZoom = useCallback(
    (nextZoomLevel: number): void => {
      const viewport = viewportRef.current;
      const clampedZoomLevel = clamp(Math.round(nextZoomLevel), MIN_ZOOM_LEVEL, maxZoomLevel);
      if (clampedZoomLevel === boundedZoomLevel) return;
      if (viewport && clampedZoomLevel > MIN_ZOOM_LEVEL) {
        pendingCenterRef.current = clamp(
          (viewport.scrollLeft + fitClockWidth / 2) / clockWidth,
          0,
          1
        );
      } else {
        pendingCenterRef.current = null;
      }
      closeTooltip();
      setZoomLevel(clampedZoomLevel);
    },
    [boundedZoomLevel, clockWidth, closeTooltip, fitClockWidth, maxZoomLevel]
  );

  const beginRulerPan = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      const viewport = viewportRef.current;
      if (!viewport || event.button !== 0 || boundedZoomLevel === MIN_ZOOM_LEVEL) return;
      event.preventDefault();
      closeTooltip();
      rulerPanRef.current = { clientX: event.clientX, scrollLeft: viewport.scrollLeft };
    },
    [boundedZoomLevel, closeTooltip]
  );

  useEffect(() => {
    const stop = (): void => {
      rulerPanRef.current = null;
    };
    const pan = (event: globalThis.MouseEvent): void => {
      const viewport = viewportRef.current;
      const origin = rulerPanRef.current;
      if (!viewport || !origin) return;
      if ((event.buttons & 1) === 0) {
        stop();
        return;
      }
      const nextScrollLeft = clamp(
        origin.scrollLeft - (event.clientX - origin.clientX),
        0,
        Math.max(0, clockWidth - fitClockWidth)
      );
      viewport.scrollLeft = nextScrollLeft;
      setViewportScrollLeft(nextScrollLeft);
      const position = { clientX: event.clientX, clientY: event.clientY };
      pointerPositionRef.current = position;
      recomputeStoredHoverCursor();
    };
    window.addEventListener('blur', stop);
    window.addEventListener('mousemove', pan);
    window.addEventListener('mouseup', stop);
    return () => {
      window.removeEventListener('blur', stop);
      window.removeEventListener('mousemove', pan);
      window.removeEventListener('mouseup', stop);
    };
  }, [clockWidth, fitClockWidth, recomputeStoredHoverCursor]);

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
  const suppressedChildIntervals: SuppressedInterval[] = swimlane.childRows.flatMap((row) =>
    row.activations.flatMap((activation) => {
      if (!activation.segments) {
        return intervalPixelWidth(
          activation.startTime,
          activation.endTime,
          axisStart,
          axisDuration,
          clockWidth
        ) < MIN_MEANINGFUL_INTERVAL_WIDTH
          ? [
              {
                id: `activation:${row.id}:${activation.id}`,
                identity: `${row.label} activation`,
                details: { durationMs: activation.durationMs, metrics: activation.metrics },
                target: activation.target,
              },
            ]
          : [];
      }
      const visibleSegments = activation.segments.filter(
        (segment) =>
          intervalPixelWidth(
            segment.startTime,
            segment.endTime,
            axisStart,
            axisDuration,
            clockWidth
          ) >= MIN_MEANINGFUL_INTERVAL_WIDTH
      );
      const visibleChildEvidenceIds = new Set(
        visibleSegments
          .map((segment) => segment.evidenceId)
          .filter((id): id is string => id !== undefined)
      );
      const activationEvidenceIds = new Set(
        (activation.evidence ?? []).map((evidence) => evidence.id)
      );
      const activationIsSubpixel =
        intervalPixelWidth(
          activation.startTime,
          activation.endTime,
          axisStart,
          axisDuration,
          clockWidth
        ) < MIN_MEANINGFUL_INTERVAL_WIDTH;
      const hasOnlyUnattributedOrNoEvidenceSegments =
        activationEvidenceIds.size === 0 &&
        activation.segments.every(
          (segment) => segment.type === 'unattributed' || !segment.evidenceId
        );
      if (activationIsSubpixel && hasOnlyUnattributedOrNoEvidenceSegments) {
        return [
          {
            id: `activation:${row.id}:${activation.id}`,
            identity: `${row.label} activation`,
            details: { durationMs: activation.durationMs, metrics: activation.metrics },
            target: activation.target,
          },
        ];
      }
      const hiddenEvidence = (activation.evidence ?? [])
        .filter((evidence) => !visibleChildEvidenceIds.has(evidence.id))
        .map((evidence) => {
          const causalIdentity =
            evidence.label ?? evidence.toolUseId ?? evidence.requestId ?? evidence.processId;
          const identitySuffix = causalIdentity ? ` (${causalIdentity})` : '';
          return {
            id: `child-evidence:${row.id}:${activation.id}:${evidence.id}`,
            identity: `${row.label} ${segmentLabel(evidence.type)}${identitySuffix}`,
            details: { durationMs: evidence.durationMs, metrics: evidence.metrics },
            target: activation.target,
          };
        });
      const hiddenUnlinkedSegments = activation.segments
        .filter(
          (segment) =>
            segment.type !== 'unattributed' &&
            (!segment.evidenceId || !activationEvidenceIds.has(segment.evidenceId)) &&
            intervalPixelWidth(
              segment.startTime,
              segment.endTime,
              axisStart,
              axisDuration,
              clockWidth
            ) < MIN_MEANINGFUL_INTERVAL_WIDTH
        )
        .map((segment) => ({
          id: `child-segment:${row.id}:${activation.id}:${segment.id}`,
          identity: `${row.label} ${segmentLabel(segment.type)}`,
          details: { durationMs: segment.durationMs, metrics: segment.metrics },
          target: activation.target,
        }));
      return [...hiddenEvidence, ...hiddenUnlinkedSegments];
    })
  );
  const suppressedIntervals = [
    ...suppressedEvidence,
    ...suppressedLegacySegments,
    ...suppressedChildIntervals,
  ];
  const suppressedCount = suppressedIntervals.length;
  const displayedSuppressedIntervals = suppressedIntervals.slice(0, SUPPRESSED_DETAIL_LIMIT);

  return (
    <section
      aria-label="Session swimlane"
      data-testid="swimlane-surface"
      className="absolute inset-0"
      style={{
        backgroundColor: 'var(--color-surface)',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        paddingTop: '60px',
      }}
    >
      <div
        aria-label="Swimlane horizontal zoom"
        data-testid="swimlane-zoom-controls"
        role="group"
        style={{
          alignItems: 'center',
          borderBottom: '1px solid var(--color-border)',
          boxSizing: 'border-box',
          display: 'flex',
          flex: '0 0 auto',
          flexWrap: 'wrap',
          fontSize: '11px',
          gap: '8px',
          minHeight: '36px',
          minWidth: 0,
          padding: '6px 12px',
          width: '100%',
        }}
      >
        <button
          type="button"
          aria-label="Fit swimlane to width"
          className={zoomButtonClassName}
          data-testid="swimlane-zoom-fit"
          disabled={boundedZoomLevel === MIN_ZOOM_LEVEL}
          onClick={() => setZoom(MIN_ZOOM_LEVEL)}
          style={{ minWidth: '44px' }}
        >
          Fit
        </button>
        <button
          type="button"
          aria-label="Zoom out swimlane"
          className={zoomButtonClassName}
          data-testid="swimlane-zoom-out"
          disabled={boundedZoomLevel === MIN_ZOOM_LEVEL}
          onClick={() => setZoom(boundedZoomLevel - 1)}
          style={{ minWidth: '32px' }}
        >
          −
        </button>
        <input
          aria-describedby={scaleOutputId}
          aria-label="Swimlane zoom percentage"
          className="min-w-24 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-emphasis"
          data-testid="swimlane-zoom-range"
          aria-valuetext={`${zoomPercent}%`}
          disabled={maxZoomLevel === MIN_ZOOM_LEVEL}
          max={maxZoomLevel}
          min={MIN_ZOOM_LEVEL}
          onChange={(event) => setZoom(Number(event.currentTarget.value))}
          step={1}
          style={{ flex: '1 1 140px' }}
          type="range"
          value={boundedZoomLevel}
        />
        <button
          type="button"
          aria-label="Zoom in swimlane"
          className={zoomButtonClassName}
          data-testid="swimlane-zoom-in"
          disabled={boundedZoomLevel === maxZoomLevel}
          onClick={() => setZoom(boundedZoomLevel + 1)}
          style={{ minWidth: '32px' }}
        >
          +
        </button>
        <output
          aria-atomic="true"
          aria-live="polite"
          data-testid="swimlane-zoom-output"
          id={scaleOutputId}
          style={{ flex: '0 1 auto', minWidth: 0, whiteSpace: 'nowrap' }}
        >
          {zoomPercent}%
        </output>
      </div>
      <span className="sr-only" id={rulerDescriptionId}>
        Use the keyboard or native scrollbars to navigate the timeline. Drag the elapsed-time ruler
        horizontally for precise panning.
      </span>
      <div
        ref={viewportRef}
        aria-describedby={rulerDescriptionId}
        aria-label="Swimlane timeline viewport"
        data-testid="swimlane-horizontal-scroll"
        onPointerCancel={clearHoverCursor}
        onPointerLeave={clearHoverCursor}
        onPointerMove={handlePointerMove}
        onScroll={(event) => {
          setViewportScrollLeft(event.currentTarget.scrollLeft);
          recomputeStoredHoverCursor();
        }}
        role="region"
        tabIndex={0}
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowX: 'auto',
          overflowY: 'auto',
          width: '100%',
        }}
      >
        <div
          ref={canvasRef}
          data-testid="swimlane-clock-canvas"
          style={{
            boxSizing: 'border-box',
            padding: `8px ${CANVAS_HORIZONTAL_PADDING}px 18px`,
            position: 'relative',
            width: `${LABEL_COLUMN_WIDTH + clockWidth + CANVAS_HORIZONTAL_PADDING * 2}px`,
          }}
        >
          <div data-testid="swimlane-axis" style={{ ...rowStyle, height: '28px' }}>
            <div style={{ ...labelStyle, color: 'var(--color-text)', fontWeight: 600 }}>
              Elapsed
            </div>
            {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Dragging is optional; keyboard users scroll the focused viewport. */}
            <div
              data-clock-width={clockWidth}
              data-swimlane-clock-region="true"
              data-testid="swimlane-time-ruler"
              onMouseDown={beginRulerPan}
              style={{
                ...clockStyle,
                borderBottom: '1px solid var(--color-border-emphasis)',
                color: 'var(--color-text-muted)',
                cursor: boundedZoomLevel > MIN_ZOOM_LEVEL ? 'grab' : 'default',
                fontSize: '10px',
                minHeight: '28px',
                userSelect: 'none',
              }}
            >
              {rulerTicks.map((tick) => {
                const tickPercentage = axisDuration > 0 ? (tick.elapsedMs / axisDuration) * 100 : 0;
                return (
                  <span
                    key={tick.elapsedMs}
                    aria-label={`Elapsed ${tick.label}`}
                    data-elapsed-ms={tick.elapsedMs}
                    data-estimated-label-end-pixel={tick.estimatedLabelEndPixel}
                    data-estimated-label-start-pixel={tick.estimatedLabelStartPixel}
                    data-label-alignment={tick.alignment}
                    data-testid="swimlane-ruler-tick"
                    style={{
                      borderLeft: '1px solid var(--color-border-emphasis)',
                      bottom: 0,
                      left: `${tickPercentage}%`,
                      position: 'absolute',
                      top: '16px',
                    }}
                  >
                    <span
                      style={{
                        left: 0,
                        position: 'absolute',
                        top: '-15px',
                        transform:
                          tick.alignment === 'start'
                            ? 'none'
                            : tick.alignment === 'end'
                              ? 'translateX(-100%)'
                              : 'translateX(-50%)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {tick.label}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>

          <div data-testid="swimlane-parent-row" style={rowStyle}>
            <div
              style={{ ...labelStyle, color: 'var(--color-text)', fontWeight: 600 }}
              title="Parent"
            >
              Parent
            </div>
            <div
              data-clock-width={clockWidth}
              data-swimlane-clock-region="true"
              data-testid="swimlane-parent-clock"
              style={clockStyle}
            >
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
                <div
                  data-clock-width={clockWidth}
                  data-swimlane-clock-region="true"
                  data-testid={`swimlane-child-clock-${row.id}`}
                  style={clockStyle}
                >
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
                      if (activation.segments) {
                        const activationEvidenceById = new Map(
                          (activation.evidence ?? []).map((evidence) => [evidence.id, evidence])
                        );
                        return (
                          <Fragment key={intervalKey}>
                            <div
                              aria-hidden="true"
                              data-classified="true"
                              data-testid={`swimlane-activation-${activation.id}`}
                              style={{
                                ...intervalBaseStyle,
                                ...intervalStyle(
                                  activation.startTime,
                                  activation.endTime,
                                  axisStart,
                                  axisDuration
                                ),
                                background: 'transparent',
                                borderColor: 'var(--card-separator)',
                                borderStyle: 'solid',
                                borderWidth: '1px',
                                pointerEvents: 'none',
                                zIndex: 3,
                              }}
                            />
                            {activation.segments
                              .filter(
                                (segment) =>
                                  intervalPixelWidth(
                                    segment.startTime,
                                    segment.endTime,
                                    axisStart,
                                    axisDuration,
                                    clockWidth
                                  ) >= MIN_MEANINGFUL_INTERVAL_WIDTH
                              )
                              .map((segment) => {
                                const segmentKey = intervalIdentity(
                                  'child-segment',
                                  row.id,
                                  activation.id,
                                  segment.id
                                );
                                const segmentIdentity = `${row.label} ${segmentLabel(segment.type)}`;
                                return (
                                  <SwimlaneInterval
                                    key={segmentKey}
                                    active={activeKey === segmentKey}
                                    ariaLabel={segmentIdentity}
                                    details={{
                                      durationMs: segment.durationMs,
                                      metrics:
                                        segment.metrics ??
                                        (segment.evidenceId
                                          ? activationEvidenceById.get(segment.evidenceId)?.metrics
                                          : undefined),
                                    }}
                                    fallbackWidth={intervalPixelWidth(
                                      segment.startTime,
                                      segment.endTime,
                                      axisStart,
                                      axisDuration,
                                      clockWidth
                                    )}
                                    inlineLabel={formatDuration(segment.durationMs)}
                                    intervalKey={segmentKey}
                                    onBlur={interactionProps.onBlur}
                                    onFocus={interactionProps.onFocus}
                                    onMouseEnter={interactionProps.onMouseEnter}
                                    onMouseLeave={interactionProps.onMouseLeave}
                                    dataSegmentType={segment.type}
                                    testId={`swimlane-child-segment-${activation.id}-${segment.id}`}
                                    target={activation.target}
                                    onTarget={onTarget}
                                    tooltipId={tooltipId}
                                    style={{
                                      ...intervalBaseStyle,
                                      ...intervalStyle(
                                        segment.startTime,
                                        segment.endTime,
                                        axisStart,
                                        axisDuration
                                      ),
                                      ...segmentTreatment(segment),
                                      zIndex: 2,
                                    }}
                                  />
                                );
                              })}
                          </Fragment>
                        );
                      }
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
          {hoverCursor && (
            <div
              aria-hidden="true"
              data-testid="swimlane-hover-cursor"
              style={{
                height: `${RULER_HEIGHT + (swimlane.childRows.length + 1) * ROW_HEIGHT}px`,
                left: `${CANVAS_HORIZONTAL_PADDING + LABEL_COLUMN_WIDTH}px`,
                pointerEvents: 'none',
                position: 'absolute',
                top: '8px',
                width: `${clockWidth}px`,
              }}
            >
              <div
                data-testid="swimlane-hover-guide"
                style={{
                  backgroundColor: 'var(--error-highlight-ring)',
                  bottom: 0,
                  left: `${hoverCursor.guideLeft}px`,
                  pointerEvents: 'none',
                  position: 'absolute',
                  top: 0,
                  width: '1px',
                  zIndex: 5,
                }}
              />
              <span
                data-testid="swimlane-hover-label"
                style={{
                  backgroundColor: 'var(--color-surface-overlay)',
                  border: `${HOVER_LABEL_BORDER_WIDTH}px solid var(--error-highlight-ring)`,
                  borderRadius: '3px',
                  boxSizing: 'border-box',
                  color: 'var(--color-text)',
                  fontSize: `${HOVER_LABEL_FONT_SIZE}px`,
                  fontVariantNumeric: 'tabular-nums',
                  height: `${hoverCursor.labelHeight}px`,
                  left: `${hoverCursor.labelLeft}px`,
                  lineHeight: `${Math.max(0, hoverCursor.labelHeight - HOVER_LABEL_BORDER_WIDTH * 2)}px`,
                  overflow: 'hidden',
                  padding: `0 ${HOVER_LABEL_HORIZONTAL_PADDING}px`,
                  pointerEvents: 'none',
                  position: 'fixed',
                  top: `${hoverCursor.labelTop}px`,
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  width: `${hoverCursor.labelWidth}px`,
                  zIndex: HOVER_LABEL_Z_INDEX,
                }}
              >
                {hoverCursor.label}
              </span>
            </div>
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
/* eslint-enable jsx-a11y/no-noninteractive-tabindex -- Restore the default accessibility check. */

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
