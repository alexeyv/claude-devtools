import { formatDuration, formatTokensCompact } from '@renderer/utils/formatters';

import type {
  SessionMetrics,
  SwimlaneHitlMark,
  SwimlaneModel,
  SwimlaneParentSegment,
} from '@shared/types';
import type { CSSProperties } from 'react';

const LABEL_COLUMN_WIDTH = 184;
const MIN_CLOCK_WIDTH = 720;
const MIN_INTERVAL_WIDTH = 2;

interface SwimlaneSurfaceProps {
  swimlane: SwimlaneModel;
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

function metricsText(durationMs: number, metrics: SessionMetrics): string {
  return [
    formatDuration(durationMs),
    `${formatTokensCompact(metrics.inputTokens)} in`,
    `${formatTokensCompact(metrics.cacheReadTokens)} cache`,
    `${formatTokensCompact(metrics.cacheCreationTokens)} write`,
    `${formatTokensCompact(metrics.outputTokens)} out`,
  ].join(' · ');
}

function segmentTreatment(segment: SwimlaneParentSegment): CSSProperties {
  switch (segment.type) {
    case 'work':
      return {
        backgroundColor: 'var(--color-surface-raised)',
        border: '1px solid var(--color-border-emphasis)',
      };
    case 'child-wait':
      return {
        backgroundColor: 'transparent',
        backgroundImage:
          'repeating-linear-gradient(135deg, transparent 0, transparent 4px, var(--color-border) 4px, var(--color-border) 6px)',
        border: '1px solid var(--color-border-emphasis)',
      };
    case 'HITL-wait':
      return {
        backgroundColor: 'var(--warning-bg)',
        border: '1px solid var(--warning-border)',
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

function truncateLabel(label: string): string {
  const codePoints = Array.from(label);
  return codePoints.length > 60 ? `${codePoints.slice(0, 60).join('')}…` : label;
}

function workIdentity(segment: SwimlaneParentSegment): string {
  if (segment.requestId) return `request:${segment.requestId}`;
  if (segment.chunkId) return `chunk:${segment.chunkId}`;
  return `id:${segment.id.replace(/-part-\d+$/, '')}`;
}

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: `${LABEL_COLUMN_WIDTH}px minmax(${MIN_CLOCK_WIDTH}px, 1fr)`,
  minHeight: '46px',
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
  padding: '0 12px',
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
  bottom: '10px',
  left: 0,
  position: 'absolute',
  right: 0,
  top: '10px',
};

const intervalBaseStyle: CSSProperties = {
  borderRadius: '3px',
  bottom: '10px',
  overflow: 'visible',
  position: 'absolute',
  top: '10px',
};

const metricsStyle: CSSProperties = {
  color: 'var(--color-text)',
  fontSize: '10px',
  left: '4px',
  lineHeight: '24px',
  position: 'absolute',
  textShadow: '0 1px 2px var(--color-surface)',
  top: 0,
  whiteSpace: 'nowrap',
  zIndex: 4,
};

export const SwimlaneSurface = ({ swimlane }: SwimlaneSurfaceProps): JSX.Element => {
  const axisStart = timestamp(swimlane.startTime);
  const axisEnd = timestamp(swimlane.endTime);
  const axisDuration = Math.max(0, axisEnd - axisStart);
  const workMetrics = new Map<string, SessionMetrics>();
  for (const segment of swimlane.parentSegments) {
    if (segment.type === 'work' && segment.metrics) {
      workMetrics.set(workIdentity(segment), segment.metrics);
    }
  }

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
            padding: '12px 16px 24px',
          }}
        >
          <div
            data-testid="swimlane-axis"
            style={{
              ...rowStyle,
              minHeight: '32px',
            }}
          >
            <div style={{ ...labelStyle, color: 'var(--color-text)' }}>Wall clock</div>
            <div
              style={{
                ...clockStyle,
                borderBottom: '1px solid var(--color-border-emphasis)',
                color: 'var(--color-text-muted)',
                fontSize: '10px',
                minHeight: '32px',
              }}
            >
              <span style={{ left: 0, position: 'absolute', top: '5px' }}>0ms</span>
              <span
                style={{
                  left: '50%',
                  position: 'absolute',
                  top: '5px',
                  transform: 'translateX(-50%)',
                }}
              >
                {formatDuration(axisDuration / 2)}
              </span>
              <span style={{ position: 'absolute', right: 0, top: '5px' }}>
                {formatDuration(axisDuration)}
              </span>
            </div>
          </div>

          <div data-testid="swimlane-parent-row" style={rowStyle}>
            <div style={labelStyle} title="Parent">
              Parent
            </div>
            <div style={clockStyle}>
              <div aria-hidden="true" style={baseTrackStyle} />
              {swimlane.parentSegments.map((segment) => {
                const metrics =
                  segment.type === 'work'
                    ? (segment.metrics ?? workMetrics.get(workIdentity(segment)))
                    : undefined;
                const metricSummary =
                  segment.type === 'work' && metrics
                    ? metricsText(segment.durationMs, metrics)
                    : undefined;
                return (
                  <div
                    key={segment.id}
                    aria-label={
                      metricSummary
                        ? `Parent ${segment.type}: ${metricSummary}`
                        : `Parent ${segment.type}: ${formatDuration(segment.durationMs)}`
                    }
                    data-segment-type={segment.type}
                    data-testid={`swimlane-parent-segment-${segment.id}`}
                    style={{
                      ...intervalBaseStyle,
                      ...intervalStyle(segment.startTime, segment.endTime, axisStart, axisDuration),
                      ...segmentTreatment(segment),
                      zIndex: segment.type === 'work' ? 2 : 1,
                    }}
                  >
                    {metricSummary && (
                      <span data-testid={`swimlane-metrics-${segment.id}`} style={metricsStyle}>
                        {metricSummary}
                      </span>
                    )}
                  </div>
                );
              })}
              {swimlane.hitlMarks.map((mark) => {
                const label = markLabel(mark);
                return (
                  <div
                    key={mark.id}
                    aria-label={`${label} boundary`}
                    data-mark-label={label}
                    data-mark-source={mark.source}
                    data-testid={`swimlane-mark-${mark.id}`}
                    style={{
                      bottom: '4px',
                      left: `${percentage(mark.timestamp, axisStart, axisDuration)}%`,
                      position: 'absolute',
                      top: '2px',
                      transform: 'translateX(-1px)',
                      width: '2px',
                      zIndex: 5,
                      backgroundColor: 'var(--warning-border)',
                    }}
                  >
                    <span
                      style={{
                        color: 'var(--warning-text)',
                        fontSize: '9px',
                        left: '4px',
                        lineHeight: 1,
                        position: 'absolute',
                        top: 0,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {swimlane.childRows.map((row) => {
            const displayedLabel = truncateLabel(row.label);
            return (
              <div
                key={row.id}
                data-depth={row.depth}
                data-parent-row-id={row.parentRowId ?? ''}
                data-testid={`swimlane-child-row-${row.id}`}
                style={rowStyle}
              >
                <div
                  style={{ ...labelStyle, paddingLeft: `${12 + row.depth * 16}px` }}
                  title={row.label}
                >
                  {displayedLabel}
                </div>
                <div style={clockStyle}>
                  <div aria-hidden="true" style={baseTrackStyle} />
                  {row.activations.map((activation) => {
                    const metricSummary = metricsText(activation.durationMs, activation.metrics);
                    return (
                      <div
                        key={activation.id}
                        aria-label={`${row.label} activation: ${metricSummary}`}
                        data-testid={`swimlane-activation-${activation.id}`}
                        style={{
                          ...intervalBaseStyle,
                          ...intervalStyle(
                            activation.startTime,
                            activation.endTime,
                            axisStart,
                            axisDuration
                          ),
                          backgroundColor: 'var(--card-header-bg)',
                          border: '1px solid var(--card-border)',
                          zIndex: 2,
                        }}
                      >
                        <span
                          data-testid={`swimlane-metrics-${activation.id}`}
                          style={{ ...metricsStyle, color: 'var(--card-text-light)' }}
                        >
                          {metricSummary}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
