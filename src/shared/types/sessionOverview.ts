/**
 * Session overview - the "what am I looking at" header for a session.
 *
 * Answers, for a session from any supported agent CLI: which platform and
 * model produced it, which directory it ran in, when it started, and how long
 * it went on. Shared so main can build it and the renderer can display it.
 */

import type { AgentPlatform } from '../utils/toolIdentity';

export interface SessionOverview {
  /** Agent CLI that recorded the session. */
  platform: AgentPlatform;
  /** Human-facing platform name, e.g. "Codex". */
  platformLabel: string;
  /** Session or thread id. */
  sessionId: string;

  /** Raw model identifier as recorded, e.g. "claude-opus-4-5" or "gpt-5.6-sol". */
  model?: string;
  /** Friendly model name for display, e.g. "opus4.5". */
  modelDisplay?: string;
  /** Every distinct model seen, in order of first use, when a session switched mid-run. */
  modelsUsed: string[];

  /** Working directory the session ran in. */
  cwd?: string;
  /** Git branch, when recorded. */
  gitBranch?: string;
  /** CLI version that wrote the log. */
  cliVersion?: string;

  /** First message timestamp (ISO 8601). */
  startedAt?: string;
  /** Last message timestamp (ISO 8601). */
  endedAt?: string;
  /** Wall-clock span between them. */
  durationMs?: number;

  /** Message count after adaptation. */
  messageCount: number;
  /** Total tokens across the session. */
  totalTokens?: number;

  /** True when this log is a spawned subagent rather than a main session. */
  isSubagent: boolean;
  /** Subagent display name, when the platform records one. */
  agentNickname?: string;
  /** Parent thread/session id for subagent logs. */
  parentSessionId?: string;
}
