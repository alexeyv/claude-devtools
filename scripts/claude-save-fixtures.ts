/**
 * Copy whole Claude Code session trees (session file + its subagents) into a
 * fixture directory.
 *
 * The copy keeps Claude's `{encoded-project}/{sessionId}.jsonl` plus
 * `{encoded-project}/{sessionId}/subagents/` layout, so the result is itself a
 * valid projects root: `new ProjectScanner(dir)` reads it directly.
 *
 * Usage: npx tsx scripts/claude-save-fixtures.ts <outDir> <sessionId> [sessionId...]
 */

import { buildSessionOverview } from '../src/main/services/analysis/SessionOverviewBuilder';
import { ProjectScanner } from '../src/main/services/discovery/ProjectScanner';
import { SubagentResolver } from '../src/main/services/discovery/SubagentResolver';
import { SessionParser } from '../src/main/services/parsing/SessionParser';
import { formatDuration, peakConcurrency, renderTimeline, type TimelineSpan } from './lib/timeline';
import * as fs from 'fs/promises';
import * as path from 'path';

const CLAUDE_PROJECTS = path.join(process.env.HOME ?? '', '.claude', 'projects');

/** Copy a file, creating parent directories as needed. */
async function copyInto(source: string, target: string): Promise<number> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
  return (await fs.stat(target)).size;
}

async function main(): Promise<void> {
  const [outDir, ...sessionIds] = process.argv.slice(2);
  if (!outDir || sessionIds.length === 0) {
    console.error('usage: claude-save-fixtures.ts <outDir> <sessionId> [sessionId...]');
    process.exit(2);
  }

  const scanner = new ProjectScanner();
  const parser = new SessionParser(scanner);
  const resolver = new SubagentResolver(scanner);
  const projects = await scanner.scan();

  await fs.mkdir(outDir, { recursive: true });

  const manifest: string[] = [
    '# Claude Code session fixtures',
    '',
    'Complete Claude Code session trees captured from `~/.claude/projects` as',
    'reference material: each is a session file plus every subagent it spawned.',
    '',
    "The directory keeps Claude's own layout, so it works as a drop-in projects",
    'root — point `ProjectScanner` at it:',
    '',
    '```ts',
    `const scanner = new ProjectScanner('${outDir}');`,
    '```',
    '',
    'These are real working sessions and are git-ignored deliberately.',
    '',
  ];

  let totalFiles = 0;
  let totalBytes = 0;

  for (const sessionId of sessionIds) {
    // Locate the owning project by looking for the session file on disk.
    const project = projects.find((p) => p.sessions.includes(sessionId));
    if (!project) {
      console.error(`skipped: no project contains ${sessionId}`);
      continue;
    }

    const encodedDir = path.basename(path.dirname(scanner.getSessionPath(project.id, sessionId)));
    const sessionFile = scanner.getSessionPath(project.id, sessionId);

    let bytes = await copyInto(sessionFile, path.join(outDir, encodedDir, `${sessionId}.jsonl`));
    let fileCount = 1;

    // Subagents live beside the session, with a sidecar .meta.json each.
    const subagentFiles = await scanner.listSubagentFiles(project.id, sessionId);
    for (const subagentFile of subagentFiles) {
      const relative = path.relative(path.join(CLAUDE_PROJECTS, encodedDir), subagentFile);
      bytes += await copyInto(subagentFile, path.join(outDir, encodedDir, relative));
      fileCount++;

      const meta = subagentFile.replace(/\.jsonl$/, '.meta.json');
      try {
        bytes += await copyInto(
          meta,
          path.join(outDir, encodedDir, relative.replace(/\.jsonl$/, '.meta.json'))
        );
        fileCount++;
      } catch {
        // Not every subagent has a sidecar; absence is not an error.
      }
    }

    const parsed = await parser.parseSession(project.id, sessionId);
    const subagents = await resolver.resolveSubagents(
      project.id,
      sessionId,
      parsed.taskCalls,
      parsed.messages
    );

    const overview = buildSessionOverview(parsed.messages, {
      platform: 'claude',
      sessionId,
      cwd: project.path,
    });

    const spans: TimelineSpan[] = subagents.map((s) => ({
      label: s.description ?? s.subagentType ?? s.id,
      start: s.startTime.getTime(),
      end: s.endTime.getTime(),
    }));

    const parentSpan: TimelineSpan = {
      label: 'main',
      start: Date.parse(overview.startedAt ?? '') || spans[0]?.start || 0,
      end: Date.parse(overview.endedAt ?? '') || spans[spans.length - 1]?.end || 0,
    };

    const firstUser = parsed.byType.realUser[0];
    const prompt =
      typeof firstUser?.content === 'string'
        ? firstUser.content.replace(/\s+/g, ' ')
        : (overview.cwd ?? '(none)');

    const types = [...new Set(subagents.map((s) => s.subagentType).filter(Boolean))];

    totalFiles += fileCount;
    totalBytes += bytes;

    manifest.push(
      `## ${sessionId}`,
      '',
      `- **Prompt**: ${prompt.slice(0, 220)}`,
      `- **Directory**: \`${project.path}\``,
      `- **Project dir**: \`${encodedDir}\``,
      `- **Model**: ${overview.modelDisplay ?? '?'}`,
      `- **Started**: ${overview.startedAt ?? '?'}`,
      `- **Duration**: ${formatDuration(overview.durationMs)}`,
      `- **Subagents**: ${subagents.length} across ${fileCount} files, peak ${peakConcurrency(spans)} running at once`,
      `- **Subagent types**: ${types.length > 0 ? types.join(', ') : '(none recorded)'}`,
      `- **Task calls**: ${parsed.taskCalls.length}`,
      `- **Messages**: ${overview.messageCount}, ${overview.totalTokens?.toLocaleString() ?? '?'} tokens`,
      `- **Size**: ${(bytes / 1_000_000).toFixed(1)} MB`,
      '',
      ...(spans.length > 0 ? renderTimeline(parentSpan, spans) : ['(no subagents)']),
      ''
    );

    console.log(
      `${sessionId}: ${fileCount} files, ${(bytes / 1_000_000).toFixed(1)} MB, ` +
        `${subagents.length} subagents (peak ${peakConcurrency(spans)})`
    );
  }

  manifest.push(
    '---',
    '',
    `Total: ${totalFiles} files, ${(totalBytes / 1_000_000).toFixed(1)} MB.`,
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
