/**
 * Raw Codex rollout JSONL types.
 *
 * These describe the on-disk format written by the Codex CLI at:
 * ~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{ISO-ts}-{threadId}.jsonl
 *
 * Three format eras exist in the wild and all are represented here:
 *
 * 1. `legacy-flat`  - earliest rollouts: each line IS a bare response item
 *                     (`{"type":"message","role":"user",...}`), preceded by a
 *                     `{id, timestamp, instructions}` header. No envelope, no
 *                     per-line timestamps.
 * 2. `enveloped`    - the dominant format: every line is a
 *                     `{timestamp, ordinal, type, payload}` envelope.
 * 3. `enveloped` +  - newest builds additionally emit `event_msg/item_completed`
 *    semantic items   carrying pre-normalized display items (CommandExecution,
 *                     FileChange, AgentMessage, ...). Treated as optional
 *                     enrichment: the adapter's backbone is the `response_item`
 *                     stream, which is present in every era.
 *
 * Payload shapes drift between Codex versions, so every field that is not
 * load-bearing for the adapter is optional and unknown-typed rather than
 * asserted. Guards below narrow only what the adapter actually reads.
 */

// =============================================================================
// Envelope
// =============================================================================

/** Enveloped rollout line (format era 2+). */
export interface CodexEnvelope {
  timestamp?: string;
  ordinal?: number;
  type: string;
  payload?: unknown;
}

// =============================================================================
// session_meta
// =============================================================================

/**
 * Subagent provenance. Present only when this rollout is a spawned child
 * thread; `parent_thread_id` is the join key back to the parent rollout.
 */
export interface CodexThreadSpawn {
  parent_thread_id?: string;
  depth?: number;
  agent_path?: string;
  agent_nickname?: string;
  agent_role?: string | null;
}

export interface CodexSessionMetaPayload {
  /** Root thread id of the conversation this rollout belongs to. */
  session_id?: string;
  /** This rollout's own thread id (matches the filename suffix). */
  id?: string;
  /** Set when this thread was spawned by another agent. */
  parent_thread_id?: string;
  timestamp?: string;
  /** Working directory - the project identity for this rollout. */
  cwd?: string;
  originator?: string;
  cli_version?: string;
  source?: { subagent?: { thread_spawn?: CodexThreadSpawn } };
  thread_source?: string;
  agent_nickname?: string;
  agent_path?: string;
  model_provider?: string;
  base_instructions?: { text?: string };
}

// =============================================================================
// response_item payloads (the adapter's backbone)
// =============================================================================

/** Content block inside a Codex `message` response item. */
export interface CodexMessageContent {
  type: string;
  text?: string;
}

export interface CodexMessageItem {
  type: 'message';
  id?: string;
  role?: string;
  content?: CodexMessageContent[];
}

export interface CodexReasoningItem {
  type: 'reasoning';
  id?: string;
  /** Visible reasoning summary. Empty on modern models (content is encrypted). */
  summary?: { type?: string; text?: string }[] | string[];
  encrypted_content?: string;
}

/** Classic JSON-argument tool call. */
export interface CodexFunctionCallItem {
  type: 'function_call';
  id?: string;
  name?: string;
  /** JSON-encoded argument object. */
  arguments?: string;
  call_id?: string;
}

export interface CodexFunctionCallOutputItem {
  type: 'function_call_output';
  id?: string;
  call_id?: string;
  output?: unknown;
}

/**
 * Freeform tool call. Modern Codex routes nearly everything through a single
 * `exec` custom tool whose `input` is JavaScript source, e.g.
 * `const r = await tools.exec_command({"cmd":"ls","workdir":"/x"}); text(r.output);`
 */
export interface CodexCustomToolCallItem {
  type: 'custom_tool_call';
  id?: string;
  status?: string;
  call_id?: string;
  name?: string;
  input?: string;
}

export interface CodexCustomToolCallOutputItem {
  type: 'custom_tool_call_output';
  id?: string;
  call_id?: string;
  output?: unknown;
}

export interface CodexWebSearchCallItem {
  type: 'web_search_call';
  id?: string;
  action?: { query?: string; type?: string };
  status?: string;
}

// =============================================================================
// event_msg payloads (enrichment)
// =============================================================================

/**
 * Codex token accounting. Note `input_tokens` INCLUDES `cached_input_tokens`,
 * unlike Anthropic usage where cache reads are a separate bucket - the adapter
 * subtracts to avoid double counting.
 */
export interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface CodexTokenCountPayload {
  type: 'token_count';
  info?: {
    total_token_usage?: CodexTokenUsage;
    /** Usage for the most recent model call only. */
    last_token_usage?: CodexTokenUsage;
    model_context_window?: number;
  };
  rate_limits?: unknown;
}

// =============================================================================
// turn_context / compacted
// =============================================================================

export interface CodexTurnContextPayload {
  turn_id?: string;
  cwd?: string;
  model?: string;
  approval_policy?: string;
  sandbox_policy?: { type?: string };
  personality?: string;
}

export interface CodexCompactedPayload {
  message?: string;
  replacement_history?: unknown[];
}

// =============================================================================
// Guards
// =============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** True when a parsed line carries the `{type, payload}` envelope. */
export function isCodexEnvelope(value: unknown): value is CodexEnvelope {
  return isRecord(value) && typeof value.type === 'string';
}

/**
 * True for the legacy-flat header line `{id, timestamp, instructions}`, which
 * has no `type` field and precedes bare response items.
 */
export function isCodexLegacyHeader(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && !('type' in value);
}

export function getCodexPayloadType(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload.type === 'string' ? payload.type : undefined;
}
