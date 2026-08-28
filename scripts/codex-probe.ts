/**
 * Prototype probe: run the Codex adapter and project index over real rollout
 * logs and report how much of them the pipeline understands.
 *
 * Usage: npx tsx scripts/codex-probe.ts [sessionsDir]
 */

import { ChunkBuilder } from '../src/main/services/analysis/ChunkBuilder';
import { CodexProjectIndex } from '../src/main/services/discovery/CodexProjectIndex';
import { adaptCodexRollout } from '../src/main/services/parsing/CodexSessionAdapter';
import * as fs from 'fs/promises';
import * as path from 'path';

import type { CodexRolloutEntry } from '../src/main/services/discovery/CodexProjectIndex';

function pct(part: number, total: number): string {
  return total === 0 ? '0%' : `${((part / total) * 100).toFixed(1)}%`;
}

async function probeSample(
  label: string,
  entry: CodexRolloutEntry,
  builder: ChunkBuilder
): Promise<void> {
  console.log(`\n=== Adapting ${label}: ${path.basename(entry.filePath)} ===`);

  const content = await fs.readFile(entry.filePath, 'utf8');
  const adapted = adaptCodexRollout(content, entry.threadId);
  const stats = adapted.stats;

  console.log(
    `era=${adapted.info.formatEra} model=${adapted.info.model ?? '?'} ` +
      `cwd=${adapted.info.cwd ?? '?'}`
  );
  console.log(
    `lines=${stats.totalLines} messages=${stats.emittedMessages} ` +
      `toolCalls=${stats.toolCalls} toolResults=${stats.toolResults} ` +
      `encryptedReasoning=${stats.encryptedReasoning} parseErrors=${stats.parseErrors}`
  );
  console.log(`ignored: ${JSON.stringify(stats.ignored)}`);

  const chunks = builder.buildChunks(adapted.messages);
  const byType = chunks.reduce<Record<string, number>>((acc, chunk) => {
    acc[chunk.chunkType] = (acc[chunk.chunkType] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`chunks: ${JSON.stringify(byType)}`);

  const withUsage = adapted.messages.filter((message) => message.usage).length;
  const assistants = adapted.messages.filter((message) => message.type === 'assistant').length;
  console.log(
    `usage attributed to ${withUsage}/${assistants} assistant msgs (${pct(withUsage, assistants)})`
  );

  const toolNames = new Map<string, number>();
  for (const message of adapted.messages) {
    for (const call of message.toolCalls) {
      toolNames.set(call.name, (toolNames.get(call.name) ?? 0) + 1);
    }
  }
  const toolsSummary = [...toolNames.entries()]
    .map(([name, count]) => `${name}=${count}`)
    .join(' ');
  console.log(`tools: ${toolsSummary || '(none)'}`);

  const firstUser = adapted.messages.find((message) => message.type === 'user' && !message.isMeta);
  if (firstUser && typeof firstUser.content === 'string') {
    console.log(`first user turn: ${firstUser.content.slice(0, 140).replace(/\n/g, ' ')}`);
  }
}

async function main(): Promise<void> {
  const sessionsDir = process.argv[2];
  const index = new CodexProjectIndex(sessionsDir);

  console.log('=== Building index ===');
  const built = await index.build();
  const s = built.stats;
  console.log(
    `files=${s.filesScanned} heads=${s.headsRead} missingCwd=${s.missingCwd} ` +
      `subagents=${s.subagentThreads} orphans=${s.orphanedSubagents} in ${s.durationMs}ms`
  );

  console.log(`\n=== Top projects (${built.projects.length} total) ===`);
  for (const project of built.projects.slice(0, 10)) {
    console.log(
      `${project.name.padEnd(28)} roots=${String(project.rootThreads.length).padStart(4)} ` +
        `all=${String(project.allThreads.length).padStart(4)}  ${project.path}`
    );
  }

  // Deepest thread tree in the index - the swimlane's reason for existing.
  let deepestRoot = null as null | { threadId: string; count: number };
  for (const entry of built.byThreadId.values()) {
    if (entry.isSubagent) continue;
    const count = index.collectDescendants(built, entry.threadId).length;
    if (!deepestRoot || count > deepestRoot.count) {
      deepestRoot = { threadId: entry.threadId, count };
    }
  }
  if (deepestRoot) {
    console.log(
      `\nLargest thread tree: ${deepestRoot.threadId} with ${deepestRoot.count} descendants`
    );
  }

  // Adapt a spread of rollouts: biggest, a subagent, and the oldest.
  const all = [...built.byThreadId.values()];
  const biggest = [...all].sort((a, b) => b.size - a.size)[0];
  const subagent = all.find((e) => e.isSubagent);
  const oldest = [...all].sort((a, b) => a.startedAt - b.startedAt)[0];

  const samples = [
    ['largest', biggest],
    ['subagent', subagent],
    ['oldest', oldest],
  ] as const;

  const builder = new ChunkBuilder();

  for (const [label, entry] of samples) {
    if (!entry) continue;
    await probeSample(label, entry, builder);
  }
}

void main();
