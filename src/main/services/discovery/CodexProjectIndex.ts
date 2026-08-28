/**
 * CodexProjectIndex - Builds project and thread structure over Codex rollouts.
 *
 * Claude Code stores sessions under `~/.claude/projects/{encoded-cwd}/`, so the
 * directory name IS the project. Codex stores them date-sharded under
 * `~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{ts}-{threadId}.jsonl`, and the
 * only project identity is the `cwd` recorded in each file's `session_meta`.
 *
 * This index therefore reads a short head of every rollout, groups by `cwd`,
 * and reconstructs the parent/child thread tree that Codex spreads across
 * separate files (one per spawned subagent).
 *
 * Head reads are cached by (path, mtime, size), so rescans only touch files
 * that actually changed.
 */

import { LocalFileSystemProvider } from '@main/services/infrastructure/LocalFileSystemProvider';
import {
  type CodexSessionMetaPayload,
  getCodexPayloadType,
  isCodexEnvelope,
} from '@main/types/codexJsonl';
import { createLogger } from '@shared/utils/logger';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

import { threadIdFromRolloutFilename } from '../parsing/CodexSessionAdapter';

import type { FileSystemProvider } from '@main/services/infrastructure/FileSystemProvider';

const logger = createLogger('Discovery:CodexProjectIndex');

/**
 * Lines read from the head of a rollout when probing for `session_meta`.
 * The meta line is first in practice; the margin covers format drift without
 * paying for a full parse of a multi-megabyte rollout.
 */
const HEAD_LINE_BUDGET = 12;

// =============================================================================
// Types
// =============================================================================

/** One rollout file, as summarized from its head. */
export interface CodexRolloutEntry {
  /** Thread id (from `session_meta`, falling back to the filename). */
  threadId: string;
  /** Absolute path to the rollout file. */
  filePath: string;
  /** Working directory - project identity. Undefined when unrecorded. */
  cwd?: string;
  /** Parent thread id when this rollout is a spawned subagent. */
  parentThreadId?: string;
  rootThreadId?: string;
  agentNickname?: string;
  agentPath?: string;
  depth?: number;
  isSubagent: boolean;
  cliVersion?: string;
  /** Session start, from `session_meta` or the file's mtime as a fallback. */
  startedAt: number;
  mtimeMs: number;
  size: number;
}

/** Rollouts sharing one working directory. */
export interface CodexProjectGroup {
  /** Stable id derived from the cwd. */
  id: string;
  /** Working directory. */
  path: string;
  /** Display name (last path segment). */
  name: string;
  /** Root (non-subagent) rollouts, newest first. */
  rootThreads: CodexRolloutEntry[];
  /** Every rollout in the project, including subagents. */
  allThreads: CodexRolloutEntry[];
  mostRecentActivity: number;
}

export interface CodexIndex {
  /** Every rollout found, keyed by thread id. */
  byThreadId: Map<string, CodexRolloutEntry>;
  /** Child rollouts keyed by parent thread id. */
  childrenByParent: Map<string, CodexRolloutEntry[]>;
  /** Projects, most recently active first. */
  projects: CodexProjectGroup[];
  stats: CodexIndexStats;
}

export interface CodexIndexStats {
  filesScanned: number;
  headsRead: number;
  cacheHits: number;
  /** Rollouts with no recorded cwd - cannot be assigned to a project. */
  missingCwd: number;
  subagentThreads: number;
  /** Subagents whose parent rollout was not found in the index. */
  orphanedSubagents: number;
  durationMs: number;
}

interface CachedHead {
  mtimeMs: number;
  size: number;
  entry: CodexRolloutEntry;
}

// =============================================================================
// Index
// =============================================================================

/** Default Codex sessions root. */
function getCodexSessionsPath(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

export class CodexProjectIndex {
  private readonly sessionsDir: string;
  private readonly fsProvider: FileSystemProvider;
  private readonly headCache = new Map<string, CachedHead>();

  constructor(sessionsDir?: string, fsProvider?: FileSystemProvider) {
    this.sessionsDir = sessionsDir ?? getCodexSessionsPath();
    this.fsProvider = fsProvider ?? new LocalFileSystemProvider();
  }

  /** Scan the sessions tree and build the project/thread index. */
  async build(): Promise<CodexIndex> {
    const startedAt = Date.now();
    const stats: CodexIndexStats = {
      filesScanned: 0,
      headsRead: 0,
      cacheHits: 0,
      missingCwd: 0,
      subagentThreads: 0,
      orphanedSubagents: 0,
      durationMs: 0,
    };

    const files = await this.listRolloutFiles(this.sessionsDir);
    stats.filesScanned = files.length;

    const entries: CodexRolloutEntry[] = [];
    for (const filePath of files) {
      const read = await this.readEntry(filePath);
      if (!read) continue;
      entries.push(read.entry);
      if (read.cacheHit) stats.cacheHits++;
      else stats.headsRead++;
    }

    const { index, counts } = this.assemble(entries);
    stats.missingCwd = counts.missingCwd;
    stats.subagentThreads = counts.subagentThreads;
    stats.orphanedSubagents = counts.orphanedSubagents;
    stats.durationMs = Date.now() - startedAt;

    logger.info(
      `Codex index: ${entries.length} rollouts, ${index.projects.length} projects, ` +
        `${stats.subagentThreads} subagents in ${stats.durationMs}ms`
    );

    return { ...index, stats };
  }

  // ---------------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------------

  /** Recursively collect `*.jsonl` paths under the date-sharded tree. */
  private async listRolloutFiles(dir: string): Promise<string[]> {
    if (!(await this.fsProvider.exists(dir))) {
      logger.warn(`Codex sessions directory does not exist: ${dir}`);
      return [];
    }

    const found: string[] = [];
    const stack = [dir];

    while (stack.length > 0) {
      const current = stack.pop()!;
      let dirents;
      try {
        dirents = await this.fsProvider.readdir(current);
      } catch (error) {
        logger.warn(`Failed to read ${current}:`, error);
        continue;
      }

      for (const dirent of dirents) {
        const full = path.join(current, dirent.name);
        if (dirent.isDirectory()) {
          stack.push(full);
        } else if (dirent.isFile() && dirent.name.endsWith('.jsonl')) {
          found.push(full);
        }
      }
    }

    return found;
  }

  /** Summarize one rollout, reusing the cached head when the file is unchanged. */
  private async readEntry(
    filePath: string
  ): Promise<{ entry: CodexRolloutEntry; cacheHit: boolean } | null> {
    let stat;
    try {
      stat = await this.fsProvider.stat(filePath);
    } catch (error) {
      logger.warn(`Failed to stat ${filePath}:`, error);
      return null;
    }

    const cached = this.headCache.get(filePath);
    if (cached?.mtimeMs === stat.mtimeMs && cached?.size === stat.size) {
      return { entry: cached.entry, cacheHit: true };
    }

    const meta = await this.readSessionMeta(filePath);

    const spawn = meta?.source?.subagent?.thread_spawn;
    const parentThreadId = meta?.parent_thread_id ?? spawn?.parent_thread_id;
    const threadId = meta?.id ?? threadIdFromRolloutFilename(path.basename(filePath)) ?? filePath;

    const metaStartedAt = meta?.timestamp ? Date.parse(meta.timestamp) : NaN;

    const entry: CodexRolloutEntry = {
      threadId,
      filePath,
      cwd: meta?.cwd,
      parentThreadId,
      rootThreadId: meta?.session_id,
      agentNickname: meta?.agent_nickname ?? spawn?.agent_nickname,
      agentPath: meta?.agent_path ?? spawn?.agent_path,
      depth: spawn?.depth,
      isSubagent: Boolean(parentThreadId) || meta?.thread_source === 'subagent',
      cliVersion: meta?.cli_version,
      startedAt: isNaN(metaStartedAt) ? stat.mtimeMs : metaStartedAt,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };

    this.headCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, entry });
    return { entry, cacheHit: false };
  }

  /**
   * Read just enough of a rollout to find its `session_meta` payload.
   * Returns null for legacy-flat rollouts, which predate `session_meta`.
   */
  private async readSessionMeta(filePath: string): Promise<CodexSessionMetaPayload | null> {
    const stream = this.fsProvider.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      let lineCount = 0;
      for await (const line of rl) {
        if (++lineCount > HEAD_LINE_BUDGET) break;
        if (!line.trim()) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        if (isCodexEnvelope(parsed) && parsed.type === 'session_meta') {
          const payload = parsed.payload;
          if (payload && typeof payload === 'object') {
            return payload as CodexSessionMetaPayload;
          }
        }

        // Legacy-flat rollouts open with conversation content, not metadata.
        if (getCodexPayloadType(parsed) === 'message') break;
      }
    } catch (error) {
      logger.warn(`Failed to read head of ${filePath}:`, error);
    } finally {
      rl.close();
      stream.destroy();
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Assembly
  // ---------------------------------------------------------------------------

  /** Group entries into projects by cwd and link the thread tree. */
  private assemble(cachedEntries: CodexRolloutEntry[]): {
    index: Omit<CodexIndex, 'stats'>;
    counts: Pick<CodexIndexStats, 'missingCwd' | 'subagentThreads' | 'orphanedSubagents'>;
  } {
    // Assembly fills in inherited fields; work on copies so the cache keeps
    // each rollout's own head and every rebuild starts from the same facts.
    const entries = cachedEntries.map((entry) => ({ ...entry }));
    const counts = { missingCwd: 0, subagentThreads: 0, orphanedSubagents: 0 };
    const byThreadId = new Map<string, CodexRolloutEntry>();
    const childrenByParent = new Map<string, CodexRolloutEntry[]>();

    for (const entry of entries) {
      byThreadId.set(entry.threadId, entry);
      if (entry.isSubagent) counts.subagentThreads++;
      if (!entry.cwd) counts.missingCwd++;
    }

    for (const entry of entries) {
      if (!entry.parentThreadId) continue;
      const siblings = childrenByParent.get(entry.parentThreadId) ?? [];
      siblings.push(entry);
      childrenByParent.set(entry.parentThreadId, siblings);
      if (!byThreadId.has(entry.parentThreadId)) counts.orphanedSubagents++;
    }

    for (const siblings of childrenByParent.values()) {
      siblings.sort((a, b) => a.startedAt - b.startedAt);
    }

    // A subagent rollout may omit cwd; inherit it from the nearest ancestor so
    // child threads land in the same project as the run that spawned them.
    for (const entry of entries) {
      if (entry.cwd) continue;
      let cursor = entry.parentThreadId;
      const guard = new Set<string>();
      while (cursor && !guard.has(cursor)) {
        guard.add(cursor);
        const parent = byThreadId.get(cursor);
        if (!parent) break;
        if (parent.cwd) {
          entry.cwd = parent.cwd;
          counts.missingCwd--;
          break;
        }
        cursor = parent.parentThreadId;
      }
    }

    const groups = new Map<string, CodexProjectGroup>();
    for (const entry of entries) {
      if (!entry.cwd) continue;

      let group = groups.get(entry.cwd);
      if (!group) {
        group = {
          id: `codex:${entry.cwd}`,
          path: entry.cwd,
          name: path.basename(entry.cwd) || entry.cwd,
          rootThreads: [],
          allThreads: [],
          mostRecentActivity: 0,
        };
        groups.set(entry.cwd, group);
      }

      group.allThreads.push(entry);
      if (!entry.isSubagent) group.rootThreads.push(entry);
      group.mostRecentActivity = Math.max(group.mostRecentActivity, entry.mtimeMs);
    }

    const projects = [...groups.values()].sort(
      (a, b) => b.mostRecentActivity - a.mostRecentActivity
    );
    for (const project of projects) {
      project.rootThreads.sort((a, b) => b.startedAt - a.startedAt);
      project.allThreads.sort((a, b) => b.startedAt - a.startedAt);
    }

    return { index: { byThreadId, childrenByParent, projects }, counts };
  }

  /** All descendant rollouts of a thread, depth-first. */
  collectDescendants(index: CodexIndex, threadId: string): CodexRolloutEntry[] {
    const result: CodexRolloutEntry[] = [];
    const stack = [...(index.childrenByParent.get(threadId) ?? [])];
    const visited = new Set<string>();

    while (stack.length > 0) {
      const entry = stack.pop()!;
      if (visited.has(entry.threadId)) continue;
      visited.add(entry.threadId);
      result.push(entry);
      stack.push(...(index.childrenByParent.get(entry.threadId) ?? []));
    }

    return result;
  }
}
