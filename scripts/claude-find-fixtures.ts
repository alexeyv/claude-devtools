/**
 * Find Claude Code sessions worth keeping as reference fixtures: runs that
 * spawned several subagents, ideally overlapping in time.
 *
 * Unlike Codex, Claude keeps subagents in `{projectId}/{sessionId}/subagents/`
 * rather than separate top-level rollouts, so discovery goes through the app's
 * own ProjectScanner and SubagentResolver.
 *
 * Usage: npx tsx scripts/claude-find-fixtures.ts [minSubagents]
 */

import { ProjectScanner } from '../src/main/services/discovery/ProjectScanner';
import { SubagentResolver } from '../src/main/services/discovery/SubagentResolver';
import { SessionParser } from '../src/main/services/parsing/SessionParser';
import { peakConcurrency } from './lib/timeline';

const MIN_SUBAGENTS = Number(process.argv[2] ?? 3);

async function main(): Promise<void> {
  const scanner = new ProjectScanner();
  const parser = new SessionParser(scanner);
  const resolver = new SubagentResolver(scanner);

  const projects = await scanner.scan();
  console.log(`scanning ${projects.length} projects...`);

  const rows: {
    projectId: string;
    sessionId: string;
    cwd: string;
    subagents: number;
    peak: number;
    parallel: number;
    firstMessage: string;
    startedAt: number;
  }[] = [];

  for (const project of projects) {
    const sessions = await scanner.listSessions(project.id);

    for (const session of sessions) {
      // `session.hasSubagents` comes from light metadata and is not reliable
      // here; ask for the files directly, which is one readdir per session.
      const subagentFiles = await scanner.listSubagentFiles(project.id, session.id);
      if (subagentFiles.length < MIN_SUBAGENTS) continue;

      try {
        const parsed = await parser.parseSession(project.id, session.id);
        const subagents = await resolver.resolveSubagents(
          project.id,
          session.id,
          parsed.taskCalls,
          parsed.messages
        );
        if (subagents.length < MIN_SUBAGENTS) continue;

        const spans = subagents.map((s) => ({
          label: s.subagentType ?? s.id,
          start: s.startTime.getTime(),
          end: s.endTime.getTime(),
        }));

        rows.push({
          projectId: project.id,
          sessionId: session.id,
          cwd: project.path,
          subagents: subagents.length,
          peak: peakConcurrency(spans),
          parallel: subagents.filter((s) => s.isParallel).length,
          firstMessage: (session.firstMessage ?? '').replace(/\s+/g, ' ').slice(0, 130),
          startedAt: session.createdAt,
        });
      } catch (error) {
        console.error(`  failed ${project.id}/${session.id}: ${String(error).slice(0, 80)}`);
      }
    }
  }

  rows.sort((a, b) => b.peak - a.peak || b.subagents - a.subagents);

  console.log(`\n${rows.length} sessions with >=${MIN_SUBAGENTS} subagents\n`);
  for (const row of rows.slice(0, 15)) {
    console.log(
      `${row.sessionId}  subagents=${String(row.subagents).padStart(3)} ` +
        `peak=${String(row.peak).padStart(2)} parallel=${String(row.parallel).padStart(3)}  ` +
        `${new Date(row.startedAt).toISOString().slice(0, 16)}  ${row.cwd}`
    );
    console.log(`    ${row.firstMessage}`);
  }
}

void main();
