/**
 * Find Codex sessions worth keeping as reference fixtures: real runs with
 * spawned subagents, ideally overlapping in time.
 *
 * Usage: npx tsx scripts/codex-find-fixtures.ts [pattern]
 */

import { CodexProjectIndex } from '../src/main/services/discovery/CodexProjectIndex';
import { adaptCodexRollout } from '../src/main/services/parsing/CodexSessionAdapter';
import * as fs from 'fs/promises';

const PATTERN = new RegExp(process.argv[2] ?? 'bmad-build|bmad-quick-dev|tam-dev', 'i');

interface Candidate {
  threadId: string;
  filePath: string;
  cwd?: string;
  firstTurn: string;
  descendants: number;
  maxConcurrent: number;
  treeBytes: number;
  startedAt: number;
  spans: { start: number; end: number }[];
}

/** Peak number of subagents alive at the same moment. */
function peakConcurrency(spans: { start: number; end: number }[]): number {
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

async function main(): Promise<void> {
  const index = new CodexProjectIndex();
  const built = await index.build();
  const candidates: Candidate[] = [];

  for (const entry of built.byThreadId.values()) {
    if (entry.isSubagent) continue;

    const descendants = index.collectDescendants(built, entry.threadId);
    if (descendants.length < 2) continue;

    const content = await fs.readFile(entry.filePath, 'utf8');
    if (!PATTERN.test(content)) continue;

    const adapted = adaptCodexRollout(content, entry.threadId);
    const firstTurn = adapted.messages.find((m) => m.type === 'user' && !m.isMeta);

    // A subagent's span is its own first-to-last activity.
    const spans = descendants.map((d) => ({ start: d.startedAt, end: d.mtimeMs }));
    const treeBytes = descendants.reduce((sum, d) => sum + d.size, entry.size);

    candidates.push({
      threadId: entry.threadId,
      filePath: entry.filePath,
      cwd: entry.cwd,
      firstTurn:
        typeof firstTurn?.content === 'string' ? firstTurn.content.replace(/\s+/g, ' ') : '',
      descendants: descendants.length,
      maxConcurrent: peakConcurrency(spans),
      treeBytes,
      startedAt: entry.startedAt,
      spans,
    });
  }

  candidates.sort((a, b) => b.maxConcurrent - a.maxConcurrent || b.descendants - a.descendants);

  console.log(`${candidates.length} candidate sessions with >=2 subagents matching ${PATTERN}\n`);
  for (const c of candidates.slice(0, 15)) {
    const mb = (c.treeBytes / 1_000_000).toFixed(1);
    console.log(
      `${c.threadId}  subagents=${String(c.descendants).padStart(3)} ` +
        `peakParallel=${String(c.maxConcurrent).padStart(2)}  tree=${mb.padStart(6)}MB  ` +
        `${new Date(c.startedAt).toISOString().slice(0, 16)}  ${c.cwd ?? '?'}`
    );
    console.log(`    ${c.firstTurn.slice(0, 150)}`);
  }
}

void main();
