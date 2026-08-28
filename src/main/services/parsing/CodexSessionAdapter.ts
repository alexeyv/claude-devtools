/**
 * CodexSessionAdapter - Adapts Codex CLI rollout logs to the app's internal
 * `ParsedMessage` representation.
 *
 * Why an adapter and not a second pipeline: everything downstream of
 * `ParsedMessage` (ChunkBuilder, ConversationGroupBuilder, SwimlaneBuilder and
 * the entire renderer) is format-agnostic. Emitting Claude-shaped messages
 * therefore lights up the existing stack for free.
 *
 * Backbone: the `response_item` stream, which is present in every Codex format
 * era. `event_msg` lines are enrichment only (token accounting, and visible
 * reasoning on older builds where it was not yet encrypted).
 *
 * Deliberate omissions in this prototype are marked PROTOTYPE below.
 */

import { type ParsedMessage, type TokenUsage } from '@main/types';
import {
  type CodexCompactedPayload,
  type CodexCustomToolCallItem,
  type CodexCustomToolCallOutputItem,
  type CodexFunctionCallItem,
  type CodexFunctionCallOutputItem,
  type CodexMessageItem,
  type CodexReasoningItem,
  type CodexSessionMetaPayload,
  type CodexTokenCountPayload,
  type CodexTokenUsage,
  type CodexTurnContextPayload,
  type CodexWebSearchCallItem,
  getCodexPayloadType,
  isCodexEnvelope,
  isCodexLegacyHeader,
} from '@main/types/codexJsonl';
import { extractToolCalls, extractToolResults } from '@main/utils/toolExtraction';
import { createLogger } from '@shared/utils/logger';
import { getToolKind } from '@shared/utils/toolIdentity';

const logger = createLogger('Parsing:CodexSessionAdapter');

// =============================================================================
// Public types
// =============================================================================

type CodexFormatEra = 'legacy-flat' | 'enveloped';

/** Identity and provenance of a single Codex rollout file. */
export interface CodexSessionInfo {
  /** This rollout's thread id (also the filename suffix). */
  threadId: string;
  /** Root thread of the conversation, when recorded. */
  rootThreadId?: string;
  /** Parent thread id when this rollout is a spawned subagent. */
  parentThreadId?: string;
  /** Working directory - the project identity for this rollout. */
  cwd?: string;
  cliVersion?: string;
  /** Model, taken from the first `turn_context`. */
  model?: string;
  modelProvider?: string;
  /** Subagent display name, e.g. "Mendel". */
  agentNickname?: string;
  /** Subagent address, e.g. "/root/review_blind_hunter". */
  agentPath?: string;
  isSubagent: boolean;
  depth?: number;
  startedAt?: Date;
  formatEra: CodexFormatEra;
}

/** Diagnostics - how much of a rollout the adapter understood. */
interface CodexAdaptStats {
  totalLines: number;
  parseErrors: number;
  emittedMessages: number;
  toolCalls: number;
  toolResults: number;
  /** Reasoning items whose content was encrypted (no visible thinking). */
  encryptedReasoning: number;
  /** Line/payload types the adapter deliberately or accidentally ignored. */
  ignored: Record<string, number>;
}

export interface AdaptedCodexSession {
  info: CodexSessionInfo;
  messages: ParsedMessage[];
  stats: CodexAdaptStats;
}

// =============================================================================
// Tool name mapping
// =============================================================================

/**
 * Codex tool names are kept exactly as recorded - `exec_command` stays
 * `exec_command` rather than being relabelled `Bash`. Behavior that used to
 * key off Claude names now keys off `ToolKind` from the shared tool identity
 * module, so the display never misreports what actually ran.
 */

// =============================================================================
// Injected-context detection
// =============================================================================

/**
 * Codex injects harness context as `developer`- and `user`-role messages.
 * These are not user turns and must not start chunks, so they are emitted as
 * `system` messages (which `isParsedHardNoiseMessage` filters out entirely).
 */
const INJECTED_CONTEXT_TAGS = [
  '<environment_context>',
  '<skills_instructions>',
  '<recommended_plugins>',
  '<user_instructions>',
  '<multi_agent_mode>',
  '<plugins_instructions>',
  '<agents_md>',
];

/**
 * Codex prepends the project's AGENTS.md to the first user turn, the way
 * Claude Code injects CLAUDE.md. Same treatment: context, not a turn.
 */
const INJECTED_CONTEXT_PATTERNS = [/^#\s*AGENTS\.md instructions for /i];

function isInjectedContext(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    INJECTED_CONTEXT_TAGS.some((tag) => trimmed.startsWith(tag)) ||
    INJECTED_CONTEXT_PATTERNS.some((pattern) => pattern.test(trimmed))
  );
}

// =============================================================================
// exec() argument extraction
// =============================================================================

/**
 * Extract the first balanced `{...}` starting at or after `from`.
 * Brace-counting is string- and escape-aware so command text containing
 * braces or quotes does not truncate the object.
 */
function extractBalancedObject(source: string, from: number): string | null {
  const start = source.indexOf('{', from);
  if (start === -1) return null;

  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  return null;
}

/** Read a JS string literal starting at `from`; returns its value and end index. */
function readStringLiteral(source: string, from: number): { value: string; end: number } | null {
  const quote = source[from];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;

  let value = '';
  let escaped = false;

  for (let i = from + 1; i < source.length; i++) {
    const ch = source[i];

    if (escaped) {
      // Only the escapes that appear in recorded commands need decoding.
      value += ch === 'n' ? '\n' : ch === 't' ? '\t' : ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === quote) return { value, end: i };

    value += ch;
  }

  return null;
}

/**
 * Read depth-1 keys from a JS object literal.
 *
 * Codex emits both JSON (`{"cmd":"ls"}`) and bare JS (`{cmd:"ls"}`), so
 * `JSON.parse` alone is not enough. Strings, numbers and booleans are read
 * directly; an array value is summarized as `<key>Count`, which is what
 * display needs from `update_plan`'s step list. Only depth-1 keys are taken,
 * so nested structures cannot inject stray values.
 */
/** Sticky so the check runs in place instead of copying the remainder of the source. */
const KEY_COLON = /\s*:/y;

function followedByColon(source: string, from: number): boolean {
  KEY_COLON.lastIndex = from;
  return KEY_COLON.test(source);
}

function scanObjectLiteral(source: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  let depth = 0;
  let pendingKey: string | null = null;
  let cursor = 0;

  while (cursor < source.length) {
    const ch = source[cursor];

    if (ch === '"' || ch === "'" || ch === '`') {
      const literal = readStringLiteral(source, cursor);
      if (!literal) break;
      if (depth === 1 && pendingKey) {
        args[pendingKey] = literal.value;
        pendingKey = null;
      } else if (depth === 1 && followedByColon(source, literal.end + 1)) {
        // JSON-style quoted key: `{"cmd": "ls"}` or `{'cmd': 'ls'}`.
        pendingKey = literal.value;
      }
      cursor = literal.end + 1;
      continue;
    }

    if (ch === '[' && depth === 1 && pendingKey) {
      const arraySource = extractBalancedArray(source, cursor);
      if (arraySource) {
        args[`${pendingKey}Count`] = countArrayEntries(arraySource);
        pendingKey = null;
        cursor += arraySource.length;
        continue;
      }
    }

    if (ch === '{' || ch === '[') {
      depth++;
      cursor++;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth--;
      pendingKey = null;
      cursor++;
      continue;
    }
    if (ch === ',') {
      pendingKey = null;
      cursor++;
      continue;
    }

    if (depth === 1 && pendingKey && (ch === '-' || isAsciiDigit(ch))) {
      const numeric = readNumericPrefix(source, cursor);
      if (numeric) {
        args[pendingKey] = Number(numeric);
        pendingKey = null;
        cursor += numeric.length;
        continue;
      }
    }

    if (depth === 1 && /[A-Za-z_$]/.test(ch)) {
      const identifier = /^[\w$]+/.exec(source.slice(cursor));
      if (identifier) {
        const word = identifier[0];
        const isKey = /^\s*:/.exec(source.slice(cursor + word.length));

        if (isKey) {
          pendingKey = word;
        } else if (pendingKey && (word === 'true' || word === 'false')) {
          args[pendingKey] = word === 'true';
          pendingKey = null;
        }

        cursor += word.length;
        continue;
      }
    }

    cursor++;
  }

  return args;
}

function isAsciiDigit(value: string): boolean {
  return value >= '0' && value <= '9';
}

function readNumericPrefix(source: string, start: number): string | null {
  let cursor = start;
  if (source[cursor] === '-') cursor++;

  const integerStart = cursor;
  while (cursor < source.length && isAsciiDigit(source[cursor])) cursor++;
  if (cursor === integerStart) return null;

  if (source[cursor] === '.') {
    const fractionalStart = ++cursor;
    while (cursor < source.length && isAsciiDigit(source[cursor])) cursor++;
    if (cursor === fractionalStart) cursor--;
  }

  return source.slice(start, cursor);
}

/** Extract a balanced `[...]` starting at `from`, quote- and escape-aware. */
function extractBalancedArray(source: string, from: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let i = from; i < source.length; i++) {
    const ch = source[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }

    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }

  return null;
}

/** Count top-level object entries in an array literal. */
function countArrayEntries(arraySource: string): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let count = 0;

  for (const ch of arraySource) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }

    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === '{') {
      if (depth === 1) count++;
      depth++;
    } else if (ch === '}') depth--;
  }

  return count;
}

/** Resolve `tools.apply_patch(patch)` by finding the variable's assignment. */
function resolveIdentifierValue(source: string, identifier: string): string | null {
  const declarations = /(?:const|let|var)\s+([\w$]+)\s*=\s*/g;

  let match = declarations.exec(source);
  while (match) {
    if (match[1] === identifier) {
      const value = readStringLiteral(source, match.index + match[0].length);
      if (value) return value.value;
    }
    match = declarations.exec(source);
  }

  return null;
}

/** A tool invocation recovered from Codex's JavaScript tool source. */
export interface CodexToolInvocation {
  /** The tool actually called, e.g. `exec_command`. */
  tool: string;
  /** Arguments recovered from the call site. */
  args: Record<string, unknown>;
}

/**
 * Modern Codex wraps tool use in JavaScript source:
 *   `const r = await tools.exec_command({"cmd":"ls","workdir":"/x"}); text(r.output);`
 *
 * Calls take three observed shapes, all handled here: an object literal
 * (JSON or bare JS), a positional string (`tools.apply_patch("*** Begin...")`),
 * and a variable reference to a string assigned earlier in the same source.
 */
export function parseCodexToolInvocation(input: string): CodexToolInvocation {
  return parseCodexToolInvocations(input)[0];
}

/**
 * Every `tools.X(...)` call in the script, in source order. A script with no
 * recognizable call is reported as a single raw `exec`, so the result is
 * never empty.
 */
export function parseCodexToolInvocations(input: string): CodexToolInvocation[] {
  const invocations: CodexToolInvocation[] = [];
  const calls = /tools\.(\w+)\s*\(/g;
  let call = calls.exec(input);
  while (call) {
    invocations.push(parseInvocationAt(input, call[1], call.index + call[0].length));
    call = calls.exec(input);
  }

  return invocations.length > 0 ? invocations : [{ tool: 'exec', args: { cmd: input } }];
}

/** Parse the argument of one `tools.<tool>(` call whose `(` ends at `start`. */
function parseInvocationAt(input: string, tool: string, start: number): CodexToolInvocation {
  let cursor = start;
  while (cursor < input.length && /\s/.test(input[cursor])) cursor++;

  const ch = input[cursor];

  if (ch === '{') {
    const objectSource = extractBalancedObject(input, cursor);
    if (!objectSource) return { tool, args: { source: input } };

    try {
      const parsed: unknown = JSON.parse(objectSource);
      if (parsed && typeof parsed === 'object') {
        return { tool, args: parsed as Record<string, unknown> };
      }
    } catch {
      // Bare JS object literal - fall through to the tolerant scanner.
    }

    return { tool, args: scanObjectLiteral(objectSource) };
  }

  if (ch === '"' || ch === "'" || ch === '`') {
    const literal = readStringLiteral(input, cursor);
    if (literal) return { tool, args: { value: literal.value } };
  }

  const identifier = /^[\w$]+/.exec(input.slice(cursor));
  if (identifier) {
    const resolved = resolveIdentifierValue(input, identifier[0]);
    if (resolved !== null) return { tool, args: { value: resolved } };
  }

  return { tool, args: { source: input } };
}

/** Target file and action recorded in an apply_patch envelope. */
function readPatchTarget(patch: string): { filePath?: string; action?: string } {
  const match = /\*\*\*\s+(Add|Update|Delete|Move)\s+File:\s*(.+)/.exec(patch);
  if (!match) return {};

  return { action: match[1].toLowerCase(), filePath: match[2].trim() };
}

/**
 * Normalize Codex tool arguments into the field names the shared summary and
 * subagent-linking code reads, without renaming the tool itself.
 */
function normalizeToolInput(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { ...args };
  const kind = getToolKind(name, 'codex');
  const positional = typeof args.value === 'string' ? args.value : undefined;

  if (kind === 'shell') {
    const command = args.cmd ?? args.command ?? positional;
    if (typeof command === 'string') input.command = command;
    const workdir = args.workdir ?? args.cwd;
    if (typeof workdir === 'string') input.description = `in ${workdir}`;
  }

  if (kind === 'file-edit') {
    // `apply_patch` carries the whole envelope; the target is inside it.
    const patch = positional ?? args.patch ?? args.input;
    if (typeof patch === 'string') {
      input.patch = patch;
      const target = readPatchTarget(patch);
      if (target.filePath) input.file_path = target.filePath;
      if (target.action) input.patch_action = target.action;
    }
  }

  if (kind === 'file-read' || kind === 'image') {
    const filePath = args.path ?? args.file_path ?? positional;
    if (typeof filePath === 'string') input.file_path = filePath;
  }

  if (kind === 'todo') {
    const explanation = args.explanation ?? args.description;
    if (typeof explanation === 'string') input.description = explanation;
    if (typeof args.planCount === 'number') input.step_count = args.planCount;
  }

  if (kind === 'spawn-agent') {
    // `spawn_agent` names the child; surface it where Task descriptions read.
    const description =
      args.task_name ?? args.name ?? args.agent_name ?? args.nickname ?? args.task;
    if (typeof description === 'string') input.description = description;
    const subagentType = args.agent_path ?? args.agent ?? args.role;
    if (typeof subagentType === 'string') input.subagent_type = subagentType;
  }

  if (kind === 'agent-comms') {
    const target = args.target ?? args.agent_path ?? args.agent ?? args.recipient ?? args.name;
    if (typeof target === 'string') input.agent_path = target;
  }

  return input;
}

// =============================================================================
// Token usage conversion
// =============================================================================

/**
 * Convert Codex usage to Anthropic-shaped usage.
 *
 * Codex reports `input_tokens` INCLUSIVE of cached and cache-write tokens,
 * while `calculateMetrics` sums input + cacheRead + cacheCreation + output.
 * Subtracting here keeps totals honest instead of double counting.
 */
export function convertCodexUsage(usage: {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
}): TokenUsage {
  const cacheRead = usage.cached_input_tokens ?? 0;
  const cacheWrite = usage.cache_write_input_tokens ?? 0;
  const rawInput = usage.input_tokens ?? 0;

  return {
    input_tokens: Math.max(0, rawInput - cacheRead - cacheWrite),
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
}

/**
 * Difference between consecutive cumulative counters.
 *
 * Codex re-reports the same `last_token_usage` across multiple events, so
 * summing those double counts. The cumulative `total_token_usage` is the
 * unambiguous basis - except that it RESETS on compaction and thread
 * rollback, in which case the new value is itself the delta.
 */
function cumulativeDelta(
  previous: CodexTokenUsage | undefined,
  current: CodexTokenUsage
): CodexTokenUsage {
  const isReset = !previous || (current.total_tokens ?? 0) < (previous.total_tokens ?? 0);
  if (isReset) return current;

  const diff = (a?: number, b?: number): number => Math.max(0, (a ?? 0) - (b ?? 0));

  return {
    input_tokens: diff(current.input_tokens, previous.input_tokens),
    cached_input_tokens: diff(current.cached_input_tokens, previous.cached_input_tokens),
    cache_write_input_tokens: diff(
      current.cache_write_input_tokens,
      previous.cache_write_input_tokens
    ),
    output_tokens: diff(current.output_tokens, previous.output_tokens),
    total_tokens: diff(current.total_tokens, previous.total_tokens),
  };
}

/** Add two usage records. Codex reports one per model call; sessions sum them. */
function mergeUsage(base: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  if (!base) return next;
  return {
    input_tokens: (base.input_tokens ?? 0) + (next.input_tokens ?? 0),
    output_tokens: (base.output_tokens ?? 0) + (next.output_tokens ?? 0),
    cache_read_input_tokens:
      (base.cache_read_input_tokens ?? 0) + (next.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens:
      (base.cache_creation_input_tokens ?? 0) + (next.cache_creation_input_tokens ?? 0),
  };
}

// =============================================================================
// Adapter
// =============================================================================

interface AdapterState {
  messages: ParsedMessage[];
  parentUuid: string | null;
  /** Index of the most recent assistant message, for usage attribution. */
  lastAssistantIndex: number | null;
  /** Usage reported before any assistant message existed to carry it. */
  pendingUsage?: TokenUsage;
  /** Previous cumulative counter, for delta extraction. */
  prevCumulative?: CodexTokenUsage;
  /** call_id -> mapped tool name, so outputs can be linked and labelled. */
  toolNamesByCallId: Map<string, string>;
  /** Text already emitted from the response_item stream, to dedupe event_msg. */
  seenText: Set<string>;
  currentModel?: string;
  currentCwd?: string;
  stats: CodexAdaptStats;
}

function noteIgnored(state: AdapterState, key: string): void {
  state.stats.ignored[key] = (state.stats.ignored[key] ?? 0) + 1;
}

/** Read a string field defensively; payload shapes drift between versions. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function messageText(item: CodexMessageItem): string {
  return (item.content ?? [])
    .map((block) => block.text ?? '')
    .join('')
    .trim();
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof (part as { text?: unknown })?.text === 'string'
            ? (part as { text: string }).text
            : ''
      )
      .join('');
  }
  if (output && typeof output === 'object') {
    const asRecord = output as { output?: unknown; content?: unknown };
    if (typeof asRecord.output === 'string') return asRecord.output;
    if (typeof asRecord.content === 'string') return asRecord.content;
  }
  return '';
}

/**
 * Exit status recorded in a tool output's header. Codex writes it three ways:
 * `Process exited with code N` / `Exit code: N` as their own header line, or
 * as `"exit_code":N` when a script's `Output:` wraps a nested exec result.
 */
function readExitCode(text: string): number | undefined {
  const head = text.slice(0, 512);
  const line = /^(?:Process exited with code|Exit code:) (-?\d+)$/m.exec(head);
  if (line) return Number(line[1]);

  const nested = /Output:\n\{[^\n]*?"exit_code":(-?\d+)/.exec(head);
  if (nested) return Number(nested[1]);

  return undefined;
}

/** Whether a tool output reports failure: a non-zero exit or a leading error marker. */
export function isErrorOutput(text: string): boolean {
  const exitCode = readExitCode(text);
  if (exitCode !== undefined) return exitCode !== 0;

  // e.g. `write_stdin failed: stdin is closed`, `Error: GitHub API error 403`.
  return /^(?:\w+ failed|Error):/.test(text);
}

export class CodexSessionAdapter {
  /**
   * Adapt the lines of one rollout file.
   *
   * @param lines - Raw JSONL lines, in file order.
   * @param fallbackThreadId - Thread id from the filename, used when the
   *   rollout has no `session_meta` (legacy-flat era).
   */
  adaptLines(lines: string[], fallbackThreadId = 'unknown'): AdaptedCodexSession {
    const state: AdapterState = {
      messages: [],
      parentUuid: null,
      lastAssistantIndex: null,
      toolNamesByCallId: new Map(),
      seenText: new Set(),
      stats: {
        totalLines: lines.length,
        parseErrors: 0,
        emittedMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        encryptedReasoning: 0,
        ignored: {},
      },
    };

    const info: CodexSessionInfo = {
      threadId: fallbackThreadId,
      isSubagent: false,
      formatEra: 'enveloped',
    };

    let sawEnvelope = false;
    let sequence = 0;

    for (const line of lines) {
      if (!line.trim()) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        state.stats.parseErrors++;
        continue;
      }

      const timestamp = this.readTimestamp(parsed, info);

      if (isCodexLegacyHeader(parsed)) {
        // legacy-flat header: `{id, timestamp, instructions}`
        info.formatEra = 'legacy-flat';
        const header = parsed as { id?: string; timestamp?: string };
        if (header.id) info.threadId = header.id;
        if (header.timestamp) info.startedAt = new Date(header.timestamp);
        continue;
      }

      if (!isCodexEnvelope(parsed)) {
        noteIgnored(state, 'unrecognized-line');
        continue;
      }

      const envelope = parsed;

      switch (envelope.type) {
        case 'session_meta':
          sawEnvelope = true;
          Object.assign(info, this.readSessionMeta(envelope.payload as CodexSessionMetaPayload));
          break;

        case 'turn_context': {
          sawEnvelope = true;
          const turn = envelope.payload as CodexTurnContextPayload | undefined;
          if (turn?.model) {
            state.currentModel = turn.model;
            info.model ??= turn.model;
          }
          if (turn?.cwd) {
            state.currentCwd = turn.cwd;
            info.cwd ??= turn.cwd;
          }
          break;
        }

        case 'response_item':
          sawEnvelope = true;
          this.handleResponseItem(envelope.payload, timestamp, sequence++, state);
          break;

        case 'event_msg':
          sawEnvelope = true;
          this.handleEventMsg(envelope.payload, timestamp, sequence++, state);
          break;

        case 'compacted':
          sawEnvelope = true;
          this.emitCompaction(
            envelope.payload as CodexCompactedPayload,
            timestamp,
            sequence++,
            state
          );
          break;

        // PROTOTYPE: `world_state` (AGENTS.md, repo state) maps onto the
        // visible-context tracker, and `inter_agent_communication_metadata`
        // onto the Agent Teams model. Both are left for the next pass.
        case 'world_state':
        case 'inter_agent_communication_metadata':
          sawEnvelope = true;
          noteIgnored(state, envelope.type);
          break;

        default:
          // legacy-flat era: the line IS a bare response item.
          if (!sawEnvelope) {
            info.formatEra = 'legacy-flat';
            this.handleResponseItem(parsed, timestamp, sequence++, state);
          } else {
            noteIgnored(state, `envelope:${envelope.type}`);
          }
          break;
      }
    }

    state.stats.emittedMessages = state.messages.length;
    if (!info.startedAt && state.messages.length > 0) {
      info.startedAt = state.messages[0].timestamp;
    }

    return { info, messages: state.messages, stats: state.stats };
  }

  // ---------------------------------------------------------------------------
  // Line handlers
  // ---------------------------------------------------------------------------

  private readTimestamp(parsed: unknown, info: CodexSessionInfo): Date {
    const ts = (parsed as { timestamp?: unknown })?.timestamp;
    if (typeof ts === 'string') {
      const date = new Date(ts);
      if (!isNaN(date.getTime())) return date;
    }
    // legacy-flat lines carry no timestamp; anchor them to session start.
    return info.startedAt ?? new Date(0);
  }

  /** Translate `session_meta` into the fields of `CodexSessionInfo` it carries. */
  private readSessionMeta(payload: CodexSessionMetaPayload | undefined): Partial<CodexSessionInfo> {
    if (!payload) return {};

    const spawn = payload.source?.subagent?.thread_spawn;
    const parentThreadId = payload.parent_thread_id ?? spawn?.parent_thread_id;
    const startedAt = payload.timestamp ? new Date(payload.timestamp) : undefined;

    const patch: Partial<CodexSessionInfo> = {
      rootThreadId: payload.session_id,
      parentThreadId,
      cliVersion: payload.cli_version,
      modelProvider: payload.model_provider,
      agentNickname: payload.agent_nickname ?? spawn?.agent_nickname,
      agentPath: payload.agent_path ?? spawn?.agent_path,
      depth: spawn?.depth,
      isSubagent: Boolean(parentThreadId) || payload.thread_source === 'subagent',
    };

    if (payload.id) patch.threadId = payload.id;
    if (payload.cwd) patch.cwd = payload.cwd;
    if (startedAt && !isNaN(startedAt.getTime())) patch.startedAt = startedAt;

    return patch;
  }

  private handleResponseItem(
    payload: unknown,
    timestamp: Date,
    sequence: number,
    state: AdapterState
  ): void {
    const type = getCodexPayloadType(payload);

    switch (type) {
      case 'message':
        this.emitMessageItem(payload as CodexMessageItem, timestamp, sequence, state);
        break;

      case 'reasoning':
        this.emitReasoning(payload as CodexReasoningItem, timestamp, sequence, state);
        break;

      case 'function_call':
      case 'custom_tool_call':
        this.emitToolCall(
          payload as CodexFunctionCallItem | CodexCustomToolCallItem,
          timestamp,
          sequence,
          state
        );
        break;

      case 'function_call_output':
      case 'custom_tool_call_output':
        this.emitToolResult(
          payload as CodexFunctionCallOutputItem | CodexCustomToolCallOutputItem,
          timestamp,
          sequence,
          state
        );
        break;

      case 'web_search_call':
        this.emitWebSearch(payload as CodexWebSearchCallItem, timestamp, sequence, state);
        break;

      case 'agent_message':
        this.emitInterAgentMessage(payload, timestamp, sequence, state);
        break;

      default:
        noteIgnored(state, `response_item:${type ?? 'unknown'}`);
        break;
    }
  }

  private handleEventMsg(
    payload: unknown,
    timestamp: Date,
    sequence: number,
    state: AdapterState
  ): void {
    const type = getCodexPayloadType(payload);

    switch (type) {
      case 'token_count': {
        const info = (payload as CodexTokenCountPayload).info;
        const cumulative = info?.total_token_usage;
        if (!cumulative) break;

        const delta = cumulativeDelta(state.prevCumulative, cumulative);
        state.prevCumulative = cumulative;

        // Duplicate reports carry no new tokens.
        if ((delta.total_tokens ?? 0) === 0) break;

        const usage = convertCodexUsage(delta);
        if (state.lastAssistantIndex !== null) {
          // A second report with no intervening assistant message means another
          // model call (encrypted-only turn); add rather than overwrite.
          const target = state.messages[state.lastAssistantIndex];
          target.usage = mergeUsage(target.usage, usage);
        } else {
          // Usage before any assistant message - carry it to the next one.
          state.pendingUsage = mergeUsage(state.pendingUsage, usage);
        }
        break;
      }

      // Older eras emitted visible reasoning here, before it was encrypted.
      case 'agent_reasoning': {
        const text = asString((payload as { text?: unknown }).text).trim();
        if (text && !state.seenText.has(text)) {
          state.seenText.add(text);
          this.pushMessage(state, {
            uuid: this.uuid(state, sequence, 'reason-evt'),
            type: 'assistant',
            role: 'assistant',
            timestamp,
            content: [{ type: 'thinking', thinking: text, signature: '' }],
          });
        }
        break;
      }

      case 'agent_message': {
        const text = asString((payload as { message?: unknown }).message).trim();
        if (text && !state.seenText.has(text)) {
          state.seenText.add(text);
          this.pushMessage(state, {
            uuid: this.uuid(state, sequence, 'agent-evt'),
            type: 'assistant',
            role: 'assistant',
            timestamp,
            content: [{ type: 'text', text }],
          });
        }
        break;
      }

      case 'user_message': {
        const text = asString((payload as { message?: unknown }).message).trim();
        if (text && !state.seenText.has(text) && !isInjectedContext(text)) {
          state.seenText.add(text);
          this.pushMessage(state, {
            uuid: this.uuid(state, sequence, 'user-evt'),
            type: 'user',
            role: 'user',
            timestamp,
            content: text,
          });
        }
        break;
      }

      // Always accompanied by a top-level `compacted` line (verified across
      // the corpus: 99/99 files), so handling it here would double count.
      case 'context_compacted':
        noteIgnored(state, 'event_msg:context_compacted');
        break;

      default:
        // PROTOTYPE: `item_completed` carries a pre-normalized display stream
        // (CommandExecution/FileChange/...) on the newest builds. Ignored here
        // because it duplicates the response_item backbone; it is the right
        // source for exit codes and structured diffs in a later pass.
        noteIgnored(state, `event_msg:${type ?? 'unknown'}`);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Emitters
  // ---------------------------------------------------------------------------

  private emitMessageItem(
    item: CodexMessageItem,
    timestamp: Date,
    sequence: number,
    state: AdapterState
  ): void {
    const text = messageText(item);
    if (!text) return;

    const role = item.role ?? 'user';

    // Harness-injected context and developer instructions are not turns.
    if (role === 'developer' || role === 'system' || isInjectedContext(text)) {
      this.pushMessage(state, {
        uuid: item.id ?? this.uuid(state, sequence, 'sys'),
        type: 'system',
        role,
        timestamp,
        content: text,
        isMeta: true,
      });
      return;
    }

    state.seenText.add(text);

    if (role === 'assistant') {
      this.pushMessage(state, {
        uuid: item.id ?? this.uuid(state, sequence, 'asst'),
        type: 'assistant',
        role: 'assistant',
        timestamp,
        content: [{ type: 'text', text }],
      });
      return;
    }

    this.pushMessage(state, {
      uuid: item.id ?? this.uuid(state, sequence, 'user'),
      type: 'user',
      role: 'user',
      timestamp,
      content: text,
    });
  }

  private emitReasoning(
    item: CodexReasoningItem,
    timestamp: Date,
    sequence: number,
    state: AdapterState
  ): void {
    const summary = item.summary ?? [];
    const text = summary
      .map((entry) => (typeof entry === 'string' ? entry : (entry?.text ?? '')))
      .join('\n')
      .trim();

    if (!text) {
      // Modern models encrypt reasoning; there is no visible thinking to show.
      state.stats.encryptedReasoning++;
      return;
    }

    state.seenText.add(text);
    this.pushMessage(state, {
      uuid: item.id ?? this.uuid(state, sequence, 'reason'),
      type: 'assistant',
      role: 'assistant',
      timestamp,
      content: [{ type: 'thinking', thinking: text, signature: '' }],
    });
  }

  private emitToolCall(
    item: CodexFunctionCallItem | CodexCustomToolCallItem,
    timestamp: Date,
    sequence: number,
    state: AdapterState
  ): void {
    const callId = item.call_id ?? item.id ?? `call-${sequence}`;
    let codexName = item.name ?? 'unknown';
    let args: Record<string, unknown> = {};
    let additionalCalls: { tool: string; input: Record<string, unknown> }[] | undefined;

    if ('arguments' in item && typeof item.arguments === 'string') {
      try {
        const parsed: unknown = JSON.parse(item.arguments);
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
      } catch {
        args = { arguments: item.arguments };
      }
    } else if ('input' in item && typeof item.input === 'string') {
      // Freeform `exec` tool: the input is JavaScript wrapping the real call.
      const [extracted, ...rest] = parseCodexToolInvocations(item.input);
      if (codexName === 'exec' || codexName === 'unknown') codexName = extracted.tool;
      args = extracted.args;
      // One script can drive several tools but yields a single result, so the
      // extra calls ride along on the first tool_use instead of getting ids
      // that no output would ever resolve.
      if (rest.length > 0) {
        additionalCalls = rest.map((invocation) => ({
          tool: invocation.tool,
          input: normalizeToolInput(invocation.tool, invocation.args),
        }));
      }
    }

    const input = normalizeToolInput(codexName, args);
    if (additionalCalls) input.additional_calls = additionalCalls;

    state.toolNamesByCallId.set(callId, codexName);
    state.stats.toolCalls++;

    this.pushMessage(state, {
      uuid: item.id ?? this.uuid(state, sequence, 'tool'),
      type: 'assistant',
      role: 'assistant',
      timestamp,
      content: [{ type: 'tool_use', id: callId, name: codexName, input }],
    });
  }

  private emitToolResult(
    item: CodexFunctionCallOutputItem | CodexCustomToolCallOutputItem,
    timestamp: Date,
    sequence: number,
    state: AdapterState
  ): void {
    const callId = item.call_id ?? item.id ?? `call-${sequence}`;
    const text = outputText(item.output);
    const toolName = state.toolNamesByCallId.get(callId);

    state.stats.toolResults++;

    // Shell renderers read structured stdout; give them something to show.
    const toolUseResult =
      toolName && getToolKind(toolName, 'codex') === 'shell'
        ? { stdout: text, stderr: '', interrupted: false }
        : undefined;

    this.pushMessage(state, {
      uuid: item.id ?? this.uuid(state, sequence, 'tool-out'),
      type: 'user',
      role: 'user',
      timestamp,
      isMeta: true,
      content: [
        { type: 'tool_result', tool_use_id: callId, content: text, is_error: isErrorOutput(text) },
      ],
      sourceToolUseID: callId,
      toolUseResult,
    });
  }

  private emitWebSearch(
    item: CodexWebSearchCallItem,
    timestamp: Date,
    sequence: number,
    state: AdapterState
  ): void {
    const callId = item.id ?? `search-${sequence}`;
    state.stats.toolCalls++;
    this.pushMessage(state, {
      uuid: callId,
      type: 'assistant',
      role: 'assistant',
      timestamp,
      content: [
        {
          type: 'tool_use',
          id: callId,
          name: 'web_search_call',
          input: { query: item.action?.query ?? '' },
        },
      ],
    });
  }

  /**
   * Inter-agent traffic between Codex threads. Rendered through the existing
   * teammate-message surface by emitting the shape that guard recognizes.
   * The payload body is usually encrypted; only the routing header is visible.
   */
  private emitInterAgentMessage(
    payload: unknown,
    timestamp: Date,
    sequence: number,
    state: AdapterState
  ): void {
    const item = payload as {
      id?: string;
      author?: string;
      recipient?: string;
      content?: { text?: string }[];
    };

    const visible = (item.content ?? [])
      .map((block) => block.text ?? '')
      .join('')
      .trim();

    const author = item.author ?? 'agent';
    const summary = item.recipient ? `to ${item.recipient}` : '';

    this.pushMessage(state, {
      uuid: item.id ?? this.uuid(state, sequence, 'inter-agent'),
      type: 'user',
      role: 'user',
      timestamp,
      content:
        `<teammate-message teammate_id="${author}" color="" summary="${summary}">` +
        `${visible}</teammate-message>`,
    });
  }

  private emitCompaction(
    payload: CodexCompactedPayload | undefined,
    timestamp: Date,
    sequence: number,
    state: AdapterState
  ): void {
    const summary = payload?.message?.trim() ?? '';
    this.pushMessage(state, {
      uuid: this.uuid(state, sequence, 'compact'),
      type: 'user',
      role: 'user',
      timestamp,
      content: summary || 'Context compacted.',
      isCompactSummary: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Message construction
  // ---------------------------------------------------------------------------

  private uuid(state: AdapterState, sequence: number, kind: string): string {
    return `codex-${kind}-${sequence}`;
  }

  /**
   * Append a message, filling in the fields every downstream consumer expects
   * and maintaining the linear parent chain.
   */
  private pushMessage(
    state: AdapterState,
    partial: Pick<ParsedMessage, 'uuid' | 'type' | 'timestamp' | 'content'> & Partial<ParsedMessage>
  ): void {
    const message: ParsedMessage = {
      parentUuid: state.parentUuid,
      role: partial.role,
      usage: partial.usage,
      model: partial.type === 'assistant' ? (partial.model ?? state.currentModel) : partial.model,
      cwd: state.currentCwd,
      isSidechain: false,
      isMeta: partial.isMeta ?? false,
      userType: partial.type === 'user' && !partial.isMeta ? 'external' : undefined,
      toolCalls: extractToolCalls(partial.content, 'codex'),
      toolResults: extractToolResults(partial.content),
      ...partial,
    };

    state.messages.push(message);
    state.parentUuid = message.uuid;

    if (message.type === 'assistant') {
      state.lastAssistantIndex = state.messages.length - 1;
      if (state.pendingUsage) {
        message.usage = mergeUsage(message.usage, state.pendingUsage);
        state.pendingUsage = undefined;
      }
    }
  }
}

/** Convenience wrapper for adapting a rollout's raw text. */
export function adaptCodexRollout(content: string, fallbackThreadId?: string): AdaptedCodexSession {
  const adapter = new CodexSessionAdapter();
  try {
    return adapter.adaptLines(content.split('\n'), fallbackThreadId);
  } catch (error) {
    logger.error('Failed to adapt Codex rollout:', error);
    throw error;
  }
}

/**
 * Project a rollout's identity into the shape `buildSessionOverview` expects,
 * so the session header reads the same for Codex and Claude sessions.
 */
export function codexOverviewSource(info: CodexSessionInfo): {
  platform: 'codex';
  sessionId: string;
  cwd?: string;
  model?: string;
  cliVersion?: string;
  startedAt?: Date;
  isSubagent: boolean;
  agentNickname?: string;
  parentSessionId?: string;
} {
  return {
    platform: 'codex',
    sessionId: info.threadId,
    cwd: info.cwd,
    model: info.model,
    cliVersion: info.cliVersion,
    startedAt: info.startedAt,
    isSubagent: info.isSubagent,
    agentNickname: info.agentNickname,
    parentSessionId: info.parentThreadId,
  };
}

/** Extract the thread id from a rollout filename, if it follows the convention. */
export function threadIdFromRolloutFilename(filename: string): string | undefined {
  const match = /rollout-.*?-([0-9a-fA-F-]{36})\.jsonl$/.exec(filename);
  return match?.[1];
}
