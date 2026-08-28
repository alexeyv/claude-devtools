/**
 * Prototype check: read a Claude projects root (the real one, or a fixture
 * directory) and report what the pipeline sees.
 *
 * Usage: npx tsx scripts/claude-probe.ts [projectsDir]
 */

import { ChunkBuilder } from '../src/main/services/analysis/ChunkBuilder';
import { buildSessionOverview } from '../src/main/services/analysis/SessionOverviewBuilder';
import { ProjectScanner } from '../src/main/services/discovery/ProjectScanner';
import { SubagentResolver } from '../src/main/services/discovery/SubagentResolver';
import { SessionParser } from '../src/main/services/parsing/SessionParser';
import { formatDuration, peakConcurrency } from './lib/timeline';

async function main(): Promise<void> {
  const scanner = new ProjectScanner(process.argv[2]);
  const parser = new SessionParser(scanner);
  const resolver = new SubagentResolver(scanner);
  const builder = new ChunkBuilder();

  const projects = await scanner.scan();
  console.log(`=== ${projects.length} projects ===`);

  for (const project of projects) {
    const sessions = await scanner.listSessions(project.id);
    console.log(`${project.name.padEnd(28)} sessions=${sessions.length}  ${project.path}`);

    for (const session of sessions) {
      const parsed = await parser.parseSession(project.id, session.id);
      const subagents = await resolver.resolveSubagents(
        project.id,
        session.id,
        parsed.taskCalls,
        parsed.messages
      );
      const overview = buildSessionOverview(parsed.messages, {
        platform: 'claude',
        sessionId: session.id,
        cwd: project.path,
      });
      const chunks = builder.buildChunks(parsed.messages, subagents);
      const byType = chunks.reduce<Record<string, number>>((acc, chunk) => {
        acc[chunk.chunkType] = (acc[chunk.chunkType] ?? 0) + 1;
        return acc;
      }, {});

      const spans = subagents.map((s) => ({
        label: s.id,
        start: s.startTime.getTime(),
        end: s.endTime.getTime(),
      }));

      console.log(
        `  ${session.id.slice(0, 8)}  ${overview.modelDisplay ?? '?'}  ` +
          `msgs=${parsed.messages.length} subagents=${subagents.length} ` +
          `peak=${peakConcurrency(spans)} flaggedParallel=${subagents.filter((s) => s.isParallel).length} ` +
          `dur=${formatDuration(overview.durationMs)} chunks=${JSON.stringify(byType)}`
      );
    }
  }
}

void main();
