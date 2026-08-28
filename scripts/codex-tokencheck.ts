import { CodexProjectIndex } from '../src/main/services/discovery/CodexProjectIndex';
import { adaptCodexRollout } from '../src/main/services/parsing/CodexSessionAdapter';
import { calculateMetrics } from '../src/main/utils/jsonl';
import * as fs from 'fs/promises';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readTotalTokens(line: string): number | undefined {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed) || !isRecord(parsed.payload)) return undefined;
  const info = parsed.payload.info;
  if (!isRecord(info) || !isRecord(info.total_token_usage)) return undefined;
  const total = info.total_token_usage.total_tokens;
  return typeof total === 'number' ? total : undefined;
}

/**
 * Codex's own cumulative counter, as ground truth.
 *
 * The counter RESETS mid-file (compaction, thread rollback), so the final
 * value is not the file total. Sum the peak of each monotonic segment.
 */
function groundTruth(content: string): { total: number } | null {
  let segmentPeak = 0;
  let carried = 0;
  let saw = false;

  for (const line of content.split('\n')) {
    if (!line.includes('"token_count"')) continue;
    try {
      const total = readTotalTokens(line);
      if (total === undefined) continue;
      saw = true;
      if (total < segmentPeak) {
        carried += segmentPeak;
        segmentPeak = total;
      } else {
        segmentPeak = total;
      }
    } catch {
      /* ignore */
    }
  }

  return saw ? { total: carried + segmentPeak } : null;
}

async function main(): Promise<void> {
  const built = await new CodexProjectIndex().build();
  const entries = [...built.byThreadId.values()].sort((a, b) => b.size - a.size).slice(0, 25);

  let matched = 0;
  console.log('file                                      adapted   codex     delta');
  for (const entry of entries) {
    const content = await fs.readFile(entry.filePath, 'utf8');
    const truth = groundTruth(content);
    if (!truth) continue;

    const adapted = adaptCodexRollout(content, entry.threadId);
    const metrics = calculateMetrics(adapted.messages);
    const delta = metrics.totalTokens - truth.total;
    const ratio = truth.total ? (delta / truth.total) * 100 : 0;
    if (Math.abs(ratio) < 1) matched++;
    const ratioLabel = `${ratio.toFixed(1)}%`.padStart(9);

    console.log(
      `${entry.threadId.slice(0, 20).padEnd(22)} ${String(metrics.totalTokens).padStart(10)} ` +
        `${String(truth.total).padStart(9)} ${ratioLabel}`
    );
  }
  console.log(`\nwithin 1% of Codex's own counter: ${matched}/${entries.length}`);
}

void main();
