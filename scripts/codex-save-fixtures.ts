/**
 * Copy whole Codex session trees (root rollout + every spawned subagent) into
 * a fixture directory.
 *
 * The copy keeps Codex's own {YYYY}/{MM}/{DD} layout, so the result is itself
 * a valid sessions root: every probe script accepts it as its first argument.
 *
 * Usage: npx tsx scripts/codex-save-fixtures.ts <outDir> <threadId> [threadId...]
 */

import { buildSessionOverview } from '../src/main/services/analysis/SessionOverviewBuilder';
import {
  type CodexRolloutEntry,
  CodexProjectIndex,
} from '../src/main/services/discovery/CodexProjectIndex';
import {
  adaptCodexRollout,
  codexOverviewSource,
} from '../src/main/services/parsing/CodexSessionAdapter';
import { formatDuration, peakConcurrency, renderTimeline, type TimelineSpan } from './lib/timeline';
import * as fs from 'fs/promises';
import * as path from 'path';

/** Spans for the timeline helpers, derived from rollout file activity. */
function toSpans(entries: CodexRolloutEntry[]): TimelineSpan[] {
  return entries.map((e) => ({
    label: e.agentNickname ?? e.threadId.slice(0, 8),
    start: e.startedAt,
    end: e.mtimeMs,
  }));
}

/** Mirror a rollout into the fixture tree under its original date shard. */
async function copyRollout(entry: CodexRolloutEntry, outDir: string): Promise<void> {
  // .../sessions/YYYY/MM/DD/rollout-*.jsonl -> YYYY/MM/DD/rollout-*.jsonl
  const shard = entry.filePath.split(path.sep).slice(-4).join(path.sep);
  const target = path.join(outDir, shard);

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(entry.filePath, target);
}

async function main(): Promise<void> {
  const [outDir, ...threadIds] = process.argv.slice(2);
  if (!outDir || threadIds.length === 0) {
    console.error('usage: codex-save-fixtures.ts <outDir> <threadId> [threadId...]');
    process.exit(2);
  }

  const index = new CodexProjectIndex();
  const built = await index.build();

  await fs.mkdir(outDir, { recursive: true });

  const manifest: string[] = [
    '# Codex session fixtures',
    '',
    'Complete Codex session trees captured from `~/.codex/sessions` as reference',
    'material: each is a root rollout plus every subagent rollout it spawned.',
    '',
    "The directory keeps Codex's own `{YYYY}/{MM}/{DD}` layout, so it works as a",
    'drop-in sessions root:',
    '',
    '```bash',
    `npx tsx scripts/codex-probe.ts ${outDir}`,
    `npx tsx scripts/codex-sweep.ts ${outDir}`,
    `npx tsx scripts/codex-overview.ts ${outDir}`,
    '```',
    '',
    'These are real working sessions and are git-ignored deliberately.',
    '',
  ];

  let totalFiles = 0;
  let totalBytes = 0;

  for (const threadId of threadIds) {
    const root = built.byThreadId.get(threadId);
    if (!root) {
      console.error(`skipped: no rollout found for ${threadId}`);
      continue;
    }

    const descendants = index.collectDescendants(built, threadId);
    const tree = [root, ...descendants];

    for (const entry of tree) await copyRollout(entry, outDir);

    const content = await fs.readFile(root.filePath, 'utf8');
    const adapted = adaptCodexRollout(content, root.threadId);
    const overview = buildSessionOverview(adapted.messages, codexOverviewSource(adapted.info));
    const firstTurn = adapted.messages.find((m) => m.type === 'user' && !m.isMeta);
    const prompt =
      typeof firstTurn?.content === 'string' ? firstTurn.content.replace(/\s+/g, ' ') : '(none)';

    const bytes = tree.reduce((sum, e) => sum + e.size, 0);
    totalFiles += tree.length;
    totalBytes += bytes;

    const nicknames = [...new Set(descendants.map((d) => d.agentNickname).filter(Boolean))];

    manifest.push(
      `## ${threadId}`,
      '',
      `- **Prompt**: ${prompt.slice(0, 220)}`,
      `- **Directory**: \`${overview.cwd ?? '?'}\``,
      `- **Model**: ${overview.modelDisplay ?? '?'} (Codex CLI ${overview.cliVersion ?? '?'})`,
      `- **Started**: ${overview.startedAt ?? '?'}`,
      `- **Duration**: ${formatDuration(overview.durationMs)}`,
      `- **Subagents**: ${descendants.length} across ${tree.length} files, peak ${peakConcurrency(toSpans(descendants))} running at once`,
      `- **Agents**: ${nicknames.length > 0 ? nicknames.join(', ') : '(unnamed)'}`,
      `- **Root messages**: ${overview.messageCount}, ${overview.totalTokens?.toLocaleString() ?? '?'} tokens`,
      `- **Size**: ${(bytes / 1_000_000).toFixed(1)} MB`,
      '',
      ...renderTimeline(
        { label: 'root', start: root.startedAt, end: root.mtimeMs },
        toSpans(descendants)
      ),
      ''
    );

    console.log(
      `${threadId}: ${tree.length} files, ${(bytes / 1_000_000).toFixed(1)} MB, ` +
        `${descendants.length} subagents (peak ${peakConcurrency(toSpans(descendants))})`
    );
  }

  manifest.push(
    '---',
    '',
    `Total: ${totalFiles} rollout files, ${(totalBytes / 1_000_000).toFixed(1)} MB.`,
    ''
  );

  await fs.writeFile(path.join(outDir, 'MANIFEST.md'), manifest.join('\n'), 'utf8');
  await fs.writeFile(
    path.join(outDir, '.gitignore'),
    [
      '# Real session logs - reference material, never committed',
      '*',
      '!.gitignore',
      '!MANIFEST.md',
      '',
    ].join('\n'),
    'utf8'
  );

  console.log(
    `\nwrote ${totalFiles} files (${(totalBytes / 1_000_000).toFixed(1)} MB) to ${outDir}`
  );
}

void main();
