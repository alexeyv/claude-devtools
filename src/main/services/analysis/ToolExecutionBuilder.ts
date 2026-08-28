/**
 * ToolExecutionBuilder - Builds tool execution tracking from messages.
 *
 * Matches tool calls with their results using:
 * 1. sourceToolUseID for accurate internal user message matching
 * 2. toolResults array fallback for other patterns
 */

import type { ParsedMessage, ToolCall, ToolExecution, ToolResult } from '@main/types';

/**
 * Milliseconds between two timestamps, or 0 when either is an invalid Date.
 */
function elapsedMs(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  return isNaN(ms) ? 0 : ms;
}

/**
 * Build tool execution tracking from messages.
 * Enhanced to use sourceToolUseID for more accurate matching.
 */
export function buildToolExecutions(messages: ParsedMessage[]): ToolExecution[] {
  const executions: ToolExecution[] = [];
  const toolCallMap = new Map<string, { call: ToolCall; startTime: Date }>();

  // First pass: collect all tool calls
  for (const msg of messages) {
    for (const toolCall of msg.toolCalls) {
      toolCallMap.set(toolCall.id, {
        call: toolCall,
        startTime: msg.timestamp,
      });
    }
  }

  // Second pass: match with results and build executions
  // Try sourceToolUseID first (most accurate), then fall back to toolResults array
  const matchedResultIds = new Set<string>();
  const matchedCallIds = new Set<string>();

  const pushExecution = (
    callInfo: { call: ToolCall; startTime: Date },
    result: ToolResult,
    msg: ParsedMessage
  ): void => {
    matchedResultIds.add(result.toolUseId);
    matchedCallIds.add(callInfo.call.id);
    executions.push({
      toolCall: callInfo.call,
      result,
      startTime: callInfo.startTime,
      endTime: msg.timestamp,
      durationMs: elapsedMs(callInfo.startTime, msg.timestamp),
    });
  };

  for (const msg of messages) {
    // Check if this message has a sourceToolUseID (internal user messages).
    // A message can carry several tool_results, so pick the one whose id
    // actually matches rather than blindly taking the first.
    if (msg.sourceToolUseID) {
      const callInfo = toolCallMap.get(msg.sourceToolUseID);
      const result = msg.toolResults.find((r) => r.toolUseId === msg.sourceToolUseID);
      if (callInfo && result && !matchedResultIds.has(result.toolUseId)) {
        pushExecution(callInfo, result, msg);
      }
    }

    // Also check toolResults array for any results not matched above
    for (const result of msg.toolResults) {
      // Skip if already matched via sourceToolUseID
      if (matchedResultIds.has(result.toolUseId)) continue;

      const callInfo = toolCallMap.get(result.toolUseId);
      if (callInfo) {
        pushExecution(callInfo, result, msg);
      }
    }
  }

  // Add calls without results
  for (const [id, callInfo] of toolCallMap) {
    if (!matchedCallIds.has(id)) {
      executions.push({
        toolCall: callInfo.call,
        startTime: callInfo.startTime,
      });
    }
  }

  // Sort by start time
  executions.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  return executions;
}
