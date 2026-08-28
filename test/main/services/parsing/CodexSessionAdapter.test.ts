/**
 * Tests for CodexSessionAdapter.
 *
 * Covers the adapter's contract with the rest of the pipeline:
 * - Codex rollout lines -> Claude-shaped ParsedMessages
 * - Injected harness context never becomes a user turn
 * - Tool call/result linking, including the JS-wrapped `exec` tool
 * - Token accounting via reset-aware cumulative deltas
 * - Both format eras (enveloped, legacy-flat)
 */

import { describe, expect, it } from 'vitest';

import {
  CodexSessionAdapter,
  adaptCodexRollout,
  convertCodexUsage,
  isErrorOutput,
  parseCodexToolInvocation,
  parseCodexToolInvocations,
  threadIdFromRolloutFilename,
} from '../../../../src/main/services/parsing/CodexSessionAdapter';
import { classifyMessages } from '../../../../src/main/services/parsing/MessageClassifier';
import { isParsedCompactMessage } from '../../../../src/main/types/messages';
import { calculateMetrics } from '../../../../src/main/utils/jsonl';

// =============================================================================
// Fixtures
// =============================================================================

function envelope(type: string, payload: unknown, timestamp = '2026-08-19T05:23:42.000Z'): string {
  return JSON.stringify({ timestamp, ordinal: 0, type, payload });
}

function sessionMeta(overrides: Record<string, unknown> = {}): string {
  return envelope('session_meta', {
    session_id: 'root-thread',
    id: 'thread-1',
    timestamp: '2026-08-19T05:23:40.000Z',
    cwd: '/Users/alex/src/demo',
    cli_version: '0.147.0',
    model_provider: 'openai',
    ...overrides,
  });
}

function userMessage(text: string): string {
  return envelope('response_item', {
    type: 'message',
    id: `msg-${text.slice(0, 8)}`,
    role: 'user',
    content: [{ type: 'input_text', text }],
  });
}

function tokenCount(total: Record<string, number>): string {
  return envelope('event_msg', {
    type: 'token_count',
    info: { total_token_usage: total },
  });
}

// =============================================================================
// Session metadata
// =============================================================================

describe('CodexSessionAdapter - session info', () => {
  it('extracts identity and cwd from session_meta', () => {
    const { info } = adaptCodexRollout([sessionMeta(), userMessage('hello')].join('\n'));

    expect(info.threadId).toBe('thread-1');
    expect(info.rootThreadId).toBe('root-thread');
    expect(info.cwd).toBe('/Users/alex/src/demo');
    expect(info.cliVersion).toBe('0.147.0');
    expect(info.isSubagent).toBe(false);
    expect(info.formatEra).toBe('enveloped');
  });

  it('recognizes spawned subagent threads and their provenance', () => {
    const { info } = adaptCodexRollout(
      sessionMeta({
        parent_thread_id: 'parent-thread',
        thread_source: 'subagent',
        agent_nickname: 'Mendel',
        source: {
          subagent: {
            thread_spawn: { parent_thread_id: 'parent-thread', depth: 2, agent_path: '/root/rev' },
          },
        },
      })
    );

    expect(info.isSubagent).toBe(true);
    expect(info.parentThreadId).toBe('parent-thread');
    expect(info.agentNickname).toBe('Mendel');
    expect(info.agentPath).toBe('/root/rev');
    expect(info.depth).toBe(2);
  });

  it('takes the model from turn_context', () => {
    const { info } = adaptCodexRollout(
      [sessionMeta(), envelope('turn_context', { model: 'gpt-5.6-sol' })].join('\n')
    );

    expect(info.model).toBe('gpt-5.6-sol');
  });
});

// =============================================================================
// Message classification
// =============================================================================

describe('CodexSessionAdapter - message classification', () => {
  it('emits a real user turn for genuine user text', () => {
    const { messages } = adaptCodexRollout([sessionMeta(), userMessage('fix the bug')].join('\n'));

    const userTurns = messages.filter((m) => m.type === 'user' && !m.isMeta);
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0].content).toBe('fix the bug');
    expect(userTurns[0].userType).toBe('external');
  });

  it.each([
    ['<environment_context>\n  <cwd>/x</cwd>', 'environment context'],
    ['<skills_instructions>\nskills', 'skills instructions'],
    ['<recommended_plugins>\nplugins', 'recommended plugins'],
    ['# AGENTS.md instructions for /Users/alex/src/demo\n\n<INSTRUCTIONS>', 'AGENTS.md preamble'],
  ])('does not treat injected %s as a user turn', (text) => {
    const { messages } = adaptCodexRollout([sessionMeta(), userMessage(text)].join('\n'));

    expect(messages.filter((m) => m.type === 'user' && !m.isMeta)).toHaveLength(0);
    expect(messages.filter((m) => m.type === 'system')).toHaveLength(1);
  });

  it('routes developer-role messages to system (filtered downstream)', () => {
    const { messages } = adaptCodexRollout(
      [
        sessionMeta(),
        envelope('response_item', {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'internal harness rules' }],
        }),
      ].join('\n')
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('system');
    expect(messages[0].isMeta).toBe(true);
  });

  it('emits assistant text as a text content block', () => {
    const { messages } = adaptCodexRollout(
      [
        sessionMeta(),
        envelope('response_item', {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'done' }],
        }),
      ].join('\n')
    );

    expect(messages[0].type).toBe('assistant');
    expect(messages[0].content).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('skips encrypted reasoning but counts it', () => {
    const { messages, stats } = adaptCodexRollout(
      [
        sessionMeta(),
        envelope('response_item', { type: 'reasoning', summary: [], encrypted_content: 'gAAA' }),
      ].join('\n')
    );

    expect(messages).toHaveLength(0);
    expect(stats.encryptedReasoning).toBe(1);
  });

  it('emits visible reasoning as a thinking block', () => {
    const { messages } = adaptCodexRollout(
      [
        sessionMeta(),
        envelope('response_item', {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'weighing options' }],
        }),
      ].join('\n')
    );

    expect(messages[0].content).toEqual([
      { type: 'thinking', thinking: 'weighing options', signature: '' },
    ]);
  });

  it('emits a compact-summary message for compaction', () => {
    const { messages } = adaptCodexRollout(
      [sessionMeta(), envelope('compacted', { message: 'summary text' })].join('\n')
    );

    expect(messages[0].isCompactSummary).toBe(true);
    expect(messages[0].content).toBe('summary text');
  });
});

// =============================================================================
// Tool calls
// =============================================================================

describe('CodexSessionAdapter - tool calls', () => {
  const execCall = envelope('response_item', {
    type: 'custom_tool_call',
    id: 'ctc-1',
    call_id: 'call-1',
    name: 'exec',
    input:
      'const r = await tools.exec_command({"cmd":"ls -la","workdir":"/tmp"}); text(r.output);\n',
  });

  it('keeps the native Codex tool name and recovers the command', () => {
    const { messages } = adaptCodexRollout([sessionMeta(), execCall].join('\n'));

    const call = messages[0].toolCalls[0];
    expect(call.name).toBe('exec_command');
    expect(call.platform).toBe('codex');
    expect(call.id).toBe('call-1');
    expect(call.input.command).toBe('ls -la');
  });

  it('links tool results back to their call and exposes shell stdout', () => {
    const { messages } = adaptCodexRollout(
      [
        sessionMeta(),
        execCall,
        envelope('response_item', {
          type: 'custom_tool_call_output',
          call_id: 'call-1',
          output: [{ type: 'input_text', text: 'total 0\n' }],
        }),
      ].join('\n')
    );

    const result = messages[1];
    expect(result.isMeta).toBe(true);
    expect(result.toolResults[0].toolUseId).toBe('call-1');
    expect(result.sourceToolUseID).toBe('call-1');
    expect(result.toolUseResult).toEqual({ stdout: 'total 0\n', stderr: '', interrupted: false });
  });

  it('flags spawn_agent as a spawn without renaming it', () => {
    const { messages } = adaptCodexRollout(
      [
        sessionMeta(),
        envelope('response_item', {
          type: 'function_call',
          call_id: 'call-2',
          name: 'spawn_agent',
          arguments: JSON.stringify({ name: 'reviewer', agent_path: '/root/rev' }),
        }),
      ].join('\n')
    );

    const call = messages[0].toolCalls[0];
    expect(call.name).toBe('spawn_agent');
    expect(call.isTask).toBe(true);
    expect(call.taskDescription).toBe('reviewer');
    expect(call.taskSubagentType).toBe('/root/rev');
  });

  it('recovers the patch target so the summary can name the file', () => {
    const { messages } = adaptCodexRollout(
      [
        sessionMeta(),
        envelope('response_item', {
          type: 'custom_tool_call',
          call_id: 'call-4',
          name: 'exec',
          input:
            'await tools.apply_patch("*** Begin Patch\\n*** Update File: /src/app.ts\\n*** End Patch");',
        }),
      ].join('\n')
    );

    const call = messages[0].toolCalls[0];
    expect(call.name).toBe('apply_patch');
    expect(call.input.file_path).toBe('/src/app.ts');
    expect(call.input.patch_action).toBe('update');
  });

  it('surfaces the child name from spawn_agent arguments', () => {
    const { messages } = adaptCodexRollout(
      [
        sessionMeta(),
        envelope('response_item', {
          type: 'function_call',
          call_id: 'call-5',
          name: 'spawn_agent',
          arguments: JSON.stringify({ task_name: 'inspect_pr_218', fork_turns: 'all' }),
        }),
      ].join('\n')
    );

    expect(messages[0].toolCalls[0].taskDescription).toBe('inspect_pr_218');
  });

  it('links a result to a call that only carries an item id', () => {
    const { messages } = adaptCodexRollout(
      [
        sessionMeta(),
        envelope('response_item', {
          type: 'function_call',
          id: 'fc-only',
          name: 'read_file',
          arguments: JSON.stringify({ path: '/tmp/a.ts' }),
        }),
        envelope('response_item', {
          type: 'function_call_output',
          id: 'fc-only',
          output: 'contents',
        }),
      ].join('\n')
    );

    expect(messages[0].toolCalls[0].id).toBe('fc-only');
    expect(messages[1].toolResults[0].toolUseId).toBe('fc-only');
  });

  it('marks a non-zero exit as an error result', () => {
    const { messages } = adaptCodexRollout(
      [
        sessionMeta(),
        execCall,
        envelope('response_item', {
          type: 'custom_tool_call_output',
          call_id: 'call-1',
          output: 'Chunk ID: bff815\nWall time: 0.0000 seconds\nProcess exited with code 1\nOutput:\nboom',
        }),
      ].join('\n')
    );

    expect(messages[1].toolResults[0].isError).toBe(true);
  });

  it('records every tool a script calls, keyed off the first', () => {
    const { messages } = adaptCodexRollout(
      [
        sessionMeta(),
        envelope('response_item', {
          type: 'custom_tool_call',
          call_id: 'call-multi',
          name: 'exec',
          input:
            'const a = await tools.read_file({"path":"/tmp/a.ts"}); const b = await tools.exec_command({"cmd":"ls"}); text(a.output + b.output);',
        }),
      ].join('\n')
    );

    const call = messages[0].toolCalls[0];
    expect(call.name).toBe('read_file');
    expect(call.input.additional_calls).toEqual([
      { tool: 'exec_command', input: { command: 'ls', cmd: 'ls' } },
    ]);
  });

  it('keeps file-editing tools under their own name', () => {
    const { messages } = adaptCodexRollout(
      [
        sessionMeta(),
        envelope('response_item', {
          type: 'function_call',
          call_id: 'call-3',
          name: 'apply_patch',
          arguments: JSON.stringify({ patch: '*** Begin Patch' }),
        }),
      ].join('\n')
    );

    expect(messages[0].toolCalls[0].name).toBe('apply_patch');
  });
});

describe('parseCodexToolInvocation', () => {
  it('extracts the inner tool and arguments', () => {
    const parsed = parseCodexToolInvocation(
      'const r = await tools.exec_command({"cmd":"echo hi","workdir":"/tmp"}); text(r.output);'
    );

    expect(parsed.tool).toBe('exec_command');
    expect(parsed.args).toEqual({ cmd: 'echo hi', workdir: '/tmp' });
  });

  it('survives braces and escaped quotes inside the command', () => {
    const parsed = parseCodexToolInvocation(
      'await tools.exec_command({"cmd":"awk \'{print \\"}\\"}\' f.txt","workdir":"/tmp"});'
    );

    expect(parsed.tool).toBe('exec_command');
    expect(parsed.args.workdir).toBe('/tmp');
  });

  it('falls back to the raw input when the shape is unfamiliar', () => {
    const parsed = parseCodexToolInvocation('some unrecognized program');

    expect(parsed.tool).toBe('exec');
    expect(parsed.args).toEqual({ cmd: 'some unrecognized program' });
  });

  it('reads bare JS object literals, not just JSON', () => {
    // Codex emits unquoted keys for several tools.
    const parsed = parseCodexToolInvocation(
      'const r = await tools.write_stdin({session_id:14804,chars:"y\\n",yield_time_ms:1000});'
    );

    expect(parsed.tool).toBe('write_stdin');
    expect(parsed.args.session_id).toBe(14804);
    expect(parsed.args.chars).toBe('y\n');
  });

  it('summarizes array arguments by entry count', () => {
    const parsed = parseCodexToolInvocation(
      'await tools.update_plan({plan:[{step:"one",status:"done"},{step:"two",status:"pending"}]});'
    );

    expect(parsed.args.planCount).toBe(2);
  });

  it('reads a positional string argument', () => {
    const parsed = parseCodexToolInvocation(
      'await tools.apply_patch("*** Begin Patch\\n*** Update File: /tmp/a.ts\\n*** End Patch");'
    );

    expect(parsed.tool).toBe('apply_patch');
    expect(parsed.args.value).toContain('Update File: /tmp/a.ts');
  });

  it('resolves a variable reference to its assignment', () => {
    const parsed = parseCodexToolInvocation(
      'const patch = "*** Begin Patch\\n*** Add File: /tmp/new.ts\\n"; await tools.apply_patch(patch);'
    );

    expect(parsed.args.value).toContain('Add File: /tmp/new.ts');
  });

  it('reads quoted keys in a non-JSON object literal', () => {
    // Single-quoted values make this invalid JSON, so the scanner handles it.
    const parsed = parseCodexToolInvocation(
      "await tools.exec_command({\"cmd\": 'ls -la', 'workdir': \"/tmp\", \"yield_time_ms\": 500});"
    );

    expect(parsed.args).toEqual({ cmd: 'ls -la', workdir: '/tmp', yield_time_ms: 500 });
  });

  it('returns every call in a multi-call script', () => {
    const parsed = parseCodexToolInvocations(
      'const a = await tools.read_file({"path":"/x"}); await tools.exec_command({"cmd":"ls"}); await tools.apply_patch("*** Begin Patch");'
    );

    expect(parsed.map((call) => call.tool)).toEqual(['read_file', 'exec_command', 'apply_patch']);
    expect(parsed[1].args).toEqual({ cmd: 'ls' });
    expect(parsed[2].args).toEqual({ value: '*** Begin Patch' });
  });

  it('does not read keys out of nested objects', () => {
    const parsed = parseCodexToolInvocation(
      'await tools.exec_command({cmd:"ls",opts:{cmd:"nested-should-not-win"}});'
    );

    expect(parsed.args.cmd).toBe('ls');
  });
});

describe('isErrorOutput', () => {
  it('reads the exit status from each Codex output header', () => {
    expect(isErrorOutput('Chunk ID: a1\nWall time: 0 seconds\nProcess exited with code 0\nOutput:\n')).toBe(
      false
    );
    expect(isErrorOutput('Chunk ID: a1\nWall time: 0 seconds\nProcess exited with code 127\nOutput:\n')).toBe(
      true
    );
    expect(isErrorOutput('Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess.')).toBe(false);
    expect(isErrorOutput('Exit code: 2\nWall time: 0 seconds\nOutput:\n')).toBe(true);
  });

  it('reads the exit code of an exec result nested in script output', () => {
    const wrap = (code: number): string =>
      `Script completed\nWall time 0.2 seconds\nOutput:\n{"chunk_id":"c9","wall_time_seconds":0.1,"exit_code":${code},"output":"x"}`;

    expect(isErrorOutput(wrap(0))).toBe(false);
    expect(isErrorOutput(wrap(1))).toBe(true);
  });

  it('does not mistake exit codes mentioned in the output body for the status', () => {
    expect(
      isErrorOutput('Exit code: 0\nOutput:\n  if (exit_code != 0) {\n"exit_code":1\n')
    ).toBe(false);
  });

  it('recognizes tool-level failure messages without an exit code', () => {
    expect(isErrorOutput('write_stdin failed: stdin is closed for this session')).toBe(true);
    expect(isErrorOutput('Error: GitHub API error 403')).toBe(true);
    expect(isErrorOutput('{"message":"Wait timed out.","timed_out":true}')).toBe(false);
    expect(isErrorOutput('')).toBe(false);
  });
});

// =============================================================================
// Token accounting
// =============================================================================

describe('CodexSessionAdapter - token accounting', () => {
  it('subtracts cached tokens from the input bucket', () => {
    // Codex reports input_tokens INCLUSIVE of cache reads and writes.
    expect(
      convertCodexUsage({
        input_tokens: 15070,
        cached_input_tokens: 11008,
        cache_write_input_tokens: 60,
        output_tokens: 198,
      })
    ).toEqual({
      input_tokens: 4002,
      output_tokens: 198,
      cache_read_input_tokens: 11008,
      cache_creation_input_tokens: 60,
    });
  });

  const assistantTurn = envelope('response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'ok' }],
  });

  it('ignores duplicate cumulative reports', () => {
    const { messages } = adaptCodexRollout(
      [
        sessionMeta(),
        assistantTurn,
        tokenCount({ input_tokens: 100, output_tokens: 10, total_tokens: 110 }),
        // Same cumulative totals repeated - no new tokens were spent.
        tokenCount({ input_tokens: 100, output_tokens: 10, total_tokens: 110 }),
      ].join('\n')
    );

    expect(calculateMetrics(messages).totalTokens).toBe(110);
  });

  it('accumulates deltas across successive reports', () => {
    const { messages } = adaptCodexRollout(
      [
        sessionMeta(),
        assistantTurn,
        tokenCount({ input_tokens: 100, output_tokens: 10, total_tokens: 110 }),
        assistantTurn,
        tokenCount({ input_tokens: 250, output_tokens: 30, total_tokens: 280 }),
      ].join('\n')
    );

    expect(calculateMetrics(messages).totalTokens).toBe(280);
  });

  it('treats a counter reset as a fresh segment rather than a negative delta', () => {
    // Compaction and thread rollback reset Codex's cumulative counter.
    const { messages } = adaptCodexRollout(
      [
        sessionMeta(),
        assistantTurn,
        tokenCount({ input_tokens: 1000, output_tokens: 100, total_tokens: 1100 }),
        assistantTurn,
        tokenCount({ input_tokens: 50, output_tokens: 5, total_tokens: 55 }),
      ].join('\n')
    );

    expect(calculateMetrics(messages).totalTokens).toBe(1155);
  });

  it('carries usage reported before any assistant message', () => {
    const { messages } = adaptCodexRollout(
      [
        sessionMeta(),
        tokenCount({ input_tokens: 40, output_tokens: 5, total_tokens: 45 }),
        assistantTurn,
      ].join('\n')
    );

    expect(calculateMetrics(messages).totalTokens).toBe(45);
  });
});

// =============================================================================
// Format eras
// =============================================================================

describe('CodexSessionAdapter - compaction', () => {
  it('classifies a compaction as a compact marker, not a user turn', () => {
    const { messages } = adaptCodexRollout(
      [
        sessionMeta(),
        envelope('compacted', { message: 'Summary of the conversation so far.' }),
      ].join('\n')
    );

    const compaction = messages[0];
    expect(compaction.isCompactSummary).toBe(true);
    expect(isParsedCompactMessage(compaction)).toBe(true);
    expect(classifyMessages(messages).map((entry) => entry.category)).toEqual(['compact']);
  });
});

describe('CodexSessionAdapter - format eras', () => {
  it('parses legacy-flat rollouts with bare response items', () => {
    const lines = [
      JSON.stringify({ id: 'legacy-1', timestamp: '2025-09-09T12:48:14.076Z', instructions: null }),
      JSON.stringify({ record_type: 'state' }),
      JSON.stringify({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'legacy question' }],
      }),
    ].join('\n');

    const { info, messages } = adaptCodexRollout(lines);

    expect(info.formatEra).toBe('legacy-flat');
    expect(info.threadId).toBe('legacy-1');
    expect(messages.filter((m) => m.type === 'user' && !m.isMeta)).toHaveLength(1);
  });

  it('does not double count compaction signalled on both streams', () => {
    // `context_compacted` always accompanies a top-level `compacted` line.
    const { messages } = adaptCodexRollout(
      [
        sessionMeta(),
        envelope('compacted', { message: 'summary' }),
        envelope('event_msg', { type: 'context_compacted' }),
      ].join('\n')
    );

    expect(messages.filter((m) => m.isCompactSummary)).toHaveLength(1);
  });

  it('records malformed lines without aborting the parse', () => {
    const { messages, stats } = adaptCodexRollout(
      [sessionMeta(), '{not json', userMessage('still parsed')].join('\n')
    );

    expect(stats.parseErrors).toBe(1);
    expect(messages.filter((m) => m.type === 'user' && !m.isMeta)).toHaveLength(1);
  });

  it('maintains a linear parent chain across emitted messages', () => {
    const { messages } = adaptCodexRollout(
      [sessionMeta(), userMessage('first'), userMessage('second')].join('\n')
    );

    expect(messages[0].parentUuid).toBeNull();
    expect(messages[1].parentUuid).toBe(messages[0].uuid);
  });
});

describe('threadIdFromRolloutFilename', () => {
  it('extracts the thread id from the conventional filename', () => {
    expect(
      threadIdFromRolloutFilename(
        'rollout-2026-08-18T23-36-04-01a018bb-ef5f-79f1-b28d-1b14a8f73f50.jsonl'
      )
    ).toBe('01a018bb-ef5f-79f1-b28d-1b14a8f73f50');
  });

  it('returns undefined for unconventional names', () => {
    expect(threadIdFromRolloutFilename('session.jsonl')).toBeUndefined();
  });
});

describe('CodexSessionAdapter - class entry point', () => {
  it('falls back to the supplied thread id when session_meta is absent', () => {
    const adapter = new CodexSessionAdapter();
    const { info } = adapter.adaptLines([userMessage('hi')], 'fallback-thread');

    expect(info.threadId).toBe('fallback-thread');
  });
});
