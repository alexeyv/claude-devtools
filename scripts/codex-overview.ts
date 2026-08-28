/**
 * Prototype check: render the session header and native tool names for real
 * Codex rollouts, exactly as the display layer would.
 *
 * Usage: npx tsx scripts/codex-overview.ts [sessionsDir]
 */

import { buildSessionOverview } from '../src/main/services/analysis/SessionOverviewBuilder';
import { CodexProjectIndex } from '../src/main/services/discovery/CodexProjectIndex';
import {
  adaptCodexRollout,
  codexOverviewSource,
} from '../src/main/services/parsing/CodexSessionAdapter';
import { getToolSummary } from '../src/renderer/utils/toolRendering/toolSummaryHelpers';
import { getToolDisplayName } from '../src/shared/utils/toolIdentity';
import * as fs from 'fs/promises';

function formatDuration(ms?: number): string {
  if (ms === undefined) return '?';
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

async function main(): Promise<void> {
  const index = new CodexProjectIndex(process.argv[2]);
  const built = await index.build();

  const all = [...built.byThreadId.values()];
  const samples = [
    all.filter((e) => !e.isSubagent).sort((a, b) => b.size - a.size)[0],
    all.filter((e) => e.isSubagent).sort((a, b) => b.size - a.size)[0],
  ].filter(Boolean);

  for (const entry of samples) {
    const content = await fs.readFile(entry.filePath, 'utf8');
    const adapted = adaptCodexRollout(content, entry.threadId);
    const overview = buildSessionOverview(adapted.messages, codexOverviewSource(adapted.info));

    console.log('\n' + '='.repeat(72));
    console.log(`${overview.platformLabel}  ·  ${overview.modelDisplay ?? 'unknown model'}`);
    if (overview.isSubagent) {
      console.log(
        `subagent: ${overview.agentNickname ?? '?'}  (parent ${overview.parentSessionId})`
      );
    }
    console.log(`directory: ${overview.cwd ?? '?'}`);
    console.log(`started:   ${overview.startedAt ?? '?'}`);
    console.log(`duration:  ${formatDuration(overview.durationMs)}`);
    console.log(
      `messages:  ${overview.messageCount}   tokens: ${overview.totalTokens?.toLocaleString() ?? '?'}   cli: ${overview.cliVersion ?? '?'}`
    );

    console.log('\n  tool calls as they would display:');
    const seen = new Set<string>();
    for (const message of adapted.messages) {
      for (const call of message.toolCalls) {
        if (seen.has(call.name) || seen.size >= 8) continue;
        seen.add(call.name);
        const label = getToolDisplayName(call.name);
        const summary = getToolSummary(call.name, call.input, 'codex');
        console.log(`    ${label.padEnd(16)} ${summary}`);
      }
    }
  }
}

void main();
