/**
 * ASCII timeline rendering shared by the fixture-capture scripts.
 *
 * Shows a parent session's span with each child agent underneath, so the shape
 * of a parallel run is legible without opening the app.
 */

export interface TimelineSpan {
  label: string;
  start: number;
  end: number;
}

const WIDTH = 56;
const LABEL_WIDTH = 14;

/** Render a parent span plus its children as a fenced ASCII chart. */
export function renderTimeline(parent: TimelineSpan, children: TimelineSpan[]): string[] {
  const start = Math.min(parent.start, ...children.map((c) => c.start));
  const end = Math.max(parent.end, ...children.map((c) => c.end));
  const span = Math.max(1, end - start);

  const bar = (from: number, to: number, fill: string): string => {
    const startCol = Math.floor(((from - start) / span) * WIDTH);
    const endCol = Math.max(startCol + 1, Math.ceil(((to - start) / span) * WIDTH));
    return ' '.repeat(startCol) + fill.repeat(Math.min(WIDTH, endCol) - startCol);
  };

  const label = (text: string): string => text.slice(0, LABEL_WIDTH).padEnd(LABEL_WIDTH);

  const rows = ['```', `${label(parent.label)} |${bar(parent.start, parent.end, '=')}`];

  for (const child of [...children].sort((a, b) => a.start - b.start)) {
    rows.push(`${label(child.label)} |${bar(child.start, child.end, '#')}`);
  }

  rows.push(
    `${' '.repeat(LABEL_WIDTH)} +${'-'.repeat(WIDTH)}`,
    `${' '.repeat(LABEL_WIDTH + 1)}${new Date(start).toISOString().slice(11, 16)}` +
      `${' '.repeat(Math.max(1, WIDTH - 10))}${new Date(end).toISOString().slice(11, 16)}`,
    '```'
  );

  return rows;
}

/** Peak number of spans overlapping at any one moment. */
export function peakConcurrency(spans: TimelineSpan[]): number {
  const events = spans
    .flatMap((s) => [
      { at: s.start, delta: 1 },
      { at: s.end, delta: -1 },
    ])
    .sort((a, b) => a.at - b.at || a.delta - b.delta);

  let live = 0;
  let peak = 0;
  for (const event of events) {
    live += event.delta;
    peak = Math.max(peak, live);
  }
  return peak;
}

/** Human-readable duration. */
export function formatDuration(ms?: number): string {
  if (ms === undefined) return '?';
  const minutes = Math.round(ms / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}
