/**
 * buildSegments sweep-line vs. a brute-force reference over the pairwise
 * "active evidence" rule it replaced.
 */

import { describe, expect, it } from 'vitest';

import {
  buildSegments,
  type EvidenceRange,
  type RequestRange,
} from '../../../../src/main/services/analysis/SwimlaneBuilder';

import type { SwimlaneSegmentType } from '../../../../src/main/types';

type AttributedType = Exclude<SwimlaneSegmentType, 'unattributed'>;

const TYPES: AttributedType[] = [
  'human-wait',
  'child-wait',
  'tool-execution',
  'assistant-output',
  'model-response',
];

const PRIORITY = new Map<AttributedType, number>([
  ['human-wait', 5],
  ['child-wait', 4],
  ['tool-execution', 3],
  ['assistant-output', 2],
  ['model-response', 1],
]);

/** Deterministic LCG so the fixture is stable across runs. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** The O(E) per-interval rule the previous implementation applied. */
function referenceActive(
  ranges: EvidenceRange[],
  start: number,
  end: number
): EvidenceRange | undefined {
  return ranges
    .filter((range) => range.start <= start && range.end >= end && range.end > range.start)
    .sort(
      (left, right) =>
        (PRIORITY.get(right.type) ?? 0) - (PRIORITY.get(left.type) ?? 0) ||
        left.end - left.start - (right.end - right.start) ||
        right.start - left.start ||
        left.id.localeCompare(right.id)
    )[0];
}

interface Draft {
  type: SwimlaneSegmentType;
  start: number;
  end: number;
  evidenceId?: string;
}

function referenceDrafts(axisStart: number, axisEnd: number, ranges: EvidenceRange[]): Draft[] {
  const boundaries = new Set<number>([axisStart, axisEnd]);
  for (const range of ranges) {
    boundaries.add(Math.max(axisStart, Math.min(axisEnd, range.start)));
    boundaries.add(Math.max(axisStart, Math.min(axisEnd, range.end)));
  }
  const points = [...boundaries].sort((left, right) => left - right);
  const drafts: Draft[] = [];
  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start) continue;
    const evidence = referenceActive(ranges, start, end);
    const type: SwimlaneSegmentType = evidence?.type ?? 'unattributed';
    const previous = drafts.at(-1);
    if (previous?.type === type && previous.end === start && previous.evidenceId === evidence?.id) {
      previous.end = end;
      continue;
    }
    drafts.push({ type, start, end, evidenceId: evidence?.id });
  }
  return drafts;
}

function randomRanges(count: number, seed: number, axisStart: number, axisEnd: number): EvidenceRange[] {
  const random = rng(seed);
  const span = axisEnd - axisStart;
  return Array.from({ length: count }, (_, index) => {
    // Coarse grid so many ranges share endpoints and lengths (tie-break coverage).
    const start = axisStart + Math.floor(random() * 40) * (span / 40) - (random() < 0.05 ? span / 10 : 0);
    const length = Math.floor(random() * 12) * (span / 40);
    return {
      id: `e${index}`,
      type: TYPES[Math.floor(random() * TYPES.length)],
      start,
      end: start + length,
    };
  });
}

describe('buildSegments sweep line', () => {
  it('matches the brute-force reference on a few hundred overlapping ranges', () => {
    const axisStart = 1_000_000;
    const axisEnd = 1_400_000;
    for (const seed of [1, 7, 42]) {
      const ranges = randomRanges(300, seed, axisStart, axisEnd);
      const segments = buildSegments(axisStart, axisEnd, ranges, [] as RequestRange[]);
      const actual = segments
        .filter((segment) => segment.durationMs > 0)
        .map((segment) => ({
          type: segment.type,
          start: segment.startTime.getTime(),
          end: segment.endTime.getTime(),
          evidenceId: segment.evidenceId,
        }));
      const expected = referenceDrafts(axisStart, axisEnd, ranges);
      expect(actual).toEqual(expected);
    }
  });

  it('prefers priority, then shorter, then later-starting, then id', () => {
    const ranges: EvidenceRange[] = [
      { id: 'long-tool', type: 'tool-execution', start: 0, end: 100 },
      { id: 'short-tool', type: 'tool-execution', start: 40, end: 60 },
      { id: 'b-model', type: 'model-response', start: 0, end: 100 },
      { id: 'a-model', type: 'model-response', start: 0, end: 100 },
      { id: 'human', type: 'human-wait', start: 90, end: 120 },
    ];
    const segments = buildSegments(0, 100, ranges, []);
    expect(segments.map((segment) => [segment.id, segment.durationMs])).toEqual([
      ['long-tool', 40],
      ['short-tool', 20],
      ['long-tool-part-2', 30],
      ['human', 10],
    ]);
  });
});
