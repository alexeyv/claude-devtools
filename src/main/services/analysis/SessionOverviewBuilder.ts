/**
 * SessionOverviewBuilder - derives a session's identifying header.
 *
 * Works from `ParsedMessage[]` plus whatever the source recorded out of band,
 * so it serves any platform: Claude Code sessions carry cwd/model/gitBranch on
 * the messages themselves, while Codex records them in `session_meta` and
 * `turn_context`.
 */

import { type ParsedMessage } from '@main/types';
import { calculateMetrics } from '@main/utils/jsonl';
import { type SessionOverview } from '@shared/types/sessionOverview';
import { formatModelName } from '@shared/utils/modelDisplay';
import { type AgentPlatform, getPlatformLabel } from '@shared/utils/toolIdentity';

/** Out-of-band session facts the messages do not carry themselves. */
export interface SessionOverviewSource {
  platform: AgentPlatform;
  sessionId: string;
  /** Preferred over any cwd found on messages. */
  cwd?: string;
  /** Preferred over any model found on messages. */
  model?: string;
  cliVersion?: string;
  gitBranch?: string;
  startedAt?: Date;
  isSubagent?: boolean;
  agentNickname?: string;
  parentSessionId?: string;
}

/** Build the overview header for a session. */
export function buildSessionOverview(
  messages: ParsedMessage[],
  source: SessionOverviewSource
): SessionOverview {
  const timestamps: number[] = [];
  const modelsUsed: string[] = [];
  let cwd = source.cwd;
  let gitBranch = source.gitBranch;
  let lastModel: string | undefined;

  for (const message of messages) {
    const time = message.timestamp.getTime();
    if (!isNaN(time)) timestamps.push(time);

    cwd ??= message.cwd;
    gitBranch ??= message.gitBranch;

    // `<synthetic>` marks system-generated placeholders, not a real model.
    if (message.model && message.model !== '<synthetic>') {
      lastModel = message.model;
      if (!modelsUsed.includes(message.model)) modelsUsed.push(message.model);
    }
  }

  // Loop instead of spreading: large sessions overflow the argument limit.
  let minTs: number | undefined;
  let maxTs: number | undefined;
  for (const ts of timestamps) {
    if (minTs === undefined || ts < minTs) minTs = ts;
    if (maxTs === undefined || ts > maxTs) maxTs = ts;
  }
  const startMs = source.startedAt?.getTime() ?? minTs;
  const endMs = maxTs;

  // The session's own model wins over per-message values, which on some
  // platforms reflect only the most recent turn.
  const model = source.model ?? lastModel;
  if (model && !modelsUsed.includes(model)) modelsUsed.unshift(model);

  const metrics = calculateMetrics(messages);

  return {
    platform: source.platform,
    platformLabel: getPlatformLabel(source.platform),
    sessionId: source.sessionId,
    model,
    modelDisplay: formatModelName(model, source.platform),
    modelsUsed,
    cwd,
    gitBranch,
    cliVersion: source.cliVersion,
    startedAt: startMs !== undefined ? new Date(startMs).toISOString() : undefined,
    endedAt: endMs !== undefined ? new Date(endMs).toISOString() : undefined,
    durationMs:
      startMs !== undefined && endMs !== undefined ? Math.max(0, endMs - startMs) : undefined,
    messageCount: messages.length,
    totalTokens: metrics.totalTokens > 0 ? metrics.totalTokens : undefined,
    isSubagent: source.isSubagent ?? false,
    agentNickname: source.agentNickname,
    parentSessionId: source.parentSessionId,
  };
}
