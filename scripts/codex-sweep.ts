/**
 * Prototype sweep: adapt every Codex rollout on disk and report aggregate
 * coverage, so gaps show up as numbers rather than anecdotes.
 *
 * Usage: npx tsx scripts/codex-sweep.ts [sessionsDir]
 */

import { ChunkBuilder } from '../src/main/services/analysis/ChunkBuilder';
import { CodexProjectIndex } from '../src/main/services/discovery/CodexProjectIndex';
import { adaptCodexRollout } from '../src/main/services/parsing/CodexSessionAdapter';
import * as fs from 'fs/promises';

import type { CodexRolloutEntry } from '../src/main/services/discovery/CodexProjectIndex';
import type { EnhancedChunk, ParsedMessage } from '../src/main/types';

interface SweepTotals {
  files: number;
  failures: number;
  emptyChunks: number;
  messages: number;
  toolCalls: number;
  toolResults: number;
  encryptedReasoning: number;
  parseErrors: number;
  userChunks: number;
  aiChunks: number;
  compactChunks: number;
  systemChunks: number;
  assistantsWithUsage: number;
  assistants: number;
}

interface SweepState {
  totals: SweepTotals;
  eras: Map<string, number>;
  ignored: Map<string, number>;
  tools: Map<string, number>;
  failures: { file: string; error: string }[];
}

function increment(counts: Map<string, number>, key: string, amount = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + amount);
}

function collectMessages(messages: ParsedMessage[], state: SweepState): void {
  for (const message of messages) {
    if (message.type === 'assistant') {
      state.totals.assistants++;
      if (message.usage) state.totals.assistantsWithUsage++;
    }
    for (const call of message.toolCalls) increment(state.tools, call.name);
  }
}

function collectChunks(chunks: EnhancedChunk[], state: SweepState): void {
  for (const chunk of chunks) {
    if (chunk.chunkType === 'user') state.totals.userChunks++;
    else if (chunk.chunkType === 'ai') state.totals.aiChunks++;
    else if (chunk.chunkType === 'compact') state.totals.compactChunks++;
    else if (chunk.chunkType === 'system') state.totals.systemChunks++;
  }
}

async function sweepEntry(
  entry: CodexRolloutEntry,
  builder: ChunkBuilder,
  state: SweepState
): Promise<void> {
  const content = await fs.readFile(entry.filePath, 'utf8');
  const adapted = adaptCodexRollout(content, entry.threadId);

  increment(state.eras, adapted.info.formatEra);
  state.totals.messages += adapted.stats.emittedMessages;
  state.totals.toolCalls += adapted.stats.toolCalls;
  state.totals.toolResults += adapted.stats.toolResults;
  state.totals.encryptedReasoning += adapted.stats.encryptedReasoning;
  state.totals.parseErrors += adapted.stats.parseErrors;
  for (const [key, count] of Object.entries(adapted.stats.ignored)) {
    increment(state.ignored, key, count);
  }

  collectMessages(adapted.messages, state);
  const chunks = builder.buildChunks(adapted.messages);
  if (chunks.length === 0 && adapted.stats.emittedMessages > 0) state.totals.emptyChunks++;
  collectChunks(chunks, state);
}

function printTopCounts(title: string, counts: Map<string, number>, width: number): void {
  console.log(title);
  for (const [name, count] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${name.padEnd(width)} ${count}`);
  }
}

async function main(): Promise<void> {
  const index = new CodexProjectIndex(process.argv[2]);
  const built = await index.build();
  const builder = new ChunkBuilder();
  const state: SweepState = {
    totals: {
      files: 0,
      failures: 0,
      emptyChunks: 0,
      messages: 0,
      toolCalls: 0,
      toolResults: 0,
      encryptedReasoning: 0,
      parseErrors: 0,
      userChunks: 0,
      aiChunks: 0,
      compactChunks: 0,
      systemChunks: 0,
      assistantsWithUsage: 0,
      assistants: 0,
    },
    eras: new Map(),
    ignored: new Map(),
    tools: new Map(),
    failures: [],
  };

  for (const entry of built.byThreadId.values()) {
    state.totals.files++;
    try {
      await sweepEntry(entry, builder, state);
    } catch (error) {
      state.totals.failures++;
      state.failures.push({ file: entry.filePath, error: String(error) });
    }
  }

  console.log('\n=== Corpus totals ===');
  console.log(state.totals);
  console.log('\neras:', Object.fromEntries(state.eras));
  console.log(
    '\nusage coverage:',
    `${((state.totals.assistantsWithUsage / state.totals.assistants) * 100).toFixed(1)}%`
  );
  printTopCounts('\ntop tools:', state.tools, 18);
  printTopCounts('\nignored line types:', state.ignored, 38);
  if (state.failures.length > 0) {
    console.log('\nfailures:');
    for (const failure of state.failures.slice(0, 10)) {
      console.log(`  ${failure.file}: ${failure.error}`);
    }
  }
}

void main();
