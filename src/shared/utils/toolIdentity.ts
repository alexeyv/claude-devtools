/**
 * Platform-aware tool identity.
 *
 * Sessions can come from more than one agent CLI, and each names its tools
 * differently: Claude Code runs `Bash`, Codex runs `exec_command`. Renaming one
 * to the other would misreport what actually ran, so tools keep their native
 * name for display and carry a platform-neutral `ToolKind` for behavior
 * (icons, summaries, subagent linking).
 */

// =============================================================================
// Platform
// =============================================================================

/** Agent CLI a session was recorded by. */
export type AgentPlatform = 'claude' | 'codex';

/** Human-facing platform label. */
export function getPlatformLabel(platform: AgentPlatform): string {
  return platform === 'codex' ? 'Codex' : 'Claude Code';
}

// =============================================================================
// Tool kinds
// =============================================================================

/**
 * What a tool does, independent of platform naming. Display code switches on
 * this so a new platform only needs a name->kind table, not new renderers.
 */
export type ToolKind =
  | 'shell'
  | 'file-read'
  | 'file-edit'
  | 'file-write'
  | 'search'
  | 'spawn-agent'
  | 'agent-comms'
  | 'todo'
  | 'web-search'
  | 'web-fetch'
  | 'mcp'
  | 'image'
  | 'notebook'
  | 'skill'
  | 'other';

const CLAUDE_TOOL_KINDS: Record<string, ToolKind> = {
  Bash: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  Read: 'file-read',
  Edit: 'file-edit',
  MultiEdit: 'file-edit',
  Write: 'file-write',
  NotebookEdit: 'notebook',
  Grep: 'search',
  Glob: 'search',
  LSP: 'search',
  Task: 'spawn-agent',
  Agent: 'spawn-agent',
  TodoWrite: 'todo',
  WebSearch: 'web-search',
  WebFetch: 'web-fetch',
  Skill: 'skill',
  TeamCreate: 'agent-comms',
  TaskCreate: 'agent-comms',
  TaskUpdate: 'agent-comms',
  TaskList: 'agent-comms',
  TaskGet: 'agent-comms',
  SendMessage: 'agent-comms',
  TeamDelete: 'agent-comms',
};

const CODEX_TOOL_KINDS: Record<string, ToolKind> = {
  exec: 'shell',
  exec_command: 'shell',
  shell: 'shell',
  shell_command: 'shell',
  local_shell: 'shell',
  unified_exec: 'shell',
  write_stdin: 'shell',
  send_input: 'shell',
  read_file: 'file-read',
  apply_patch: 'file-edit',
  update_plan: 'todo',
  view_image: 'image',
  web__run: 'web-search',
  web_search: 'web-search',
  web_search_call: 'web-search',
  spawn_agent: 'spawn-agent',
  followup_task: 'agent-comms',
  send_message: 'agent-comms',
  wait_agent: 'agent-comms',
  wait: 'agent-comms',
  list_agents: 'agent-comms',
  close_agent: 'agent-comms',
  interrupt_agent: 'agent-comms',
  tool_search: 'search',
};

/**
 * Codex namespaces some tools by transport, e.g. `multi_agent_v1__wait_agent`
 * or `mcp__server__tool`. Strip the namespace before looking up the kind.
 */
const NAMESPACE_SEPARATOR = '__';

/** Split a namespaced tool name into its prefix and bare name. */
export function splitToolNamespace(name: string): { namespace?: string; bare: string } {
  const index = name.lastIndexOf(NAMESPACE_SEPARATOR);
  if (index <= 0) return { bare: name };

  return {
    namespace: name.slice(0, index),
    bare: name.slice(index + NAMESPACE_SEPARATOR.length),
  };
}

/** Classify a tool by what it does, using the platform's naming. */
export function getToolKind(name: string, platform: AgentPlatform = 'claude'): ToolKind {
  const table = platform === 'codex' ? CODEX_TOOL_KINDS : CLAUDE_TOOL_KINDS;

  const direct = table[name];
  if (direct) return direct;

  const { namespace, bare } = splitToolNamespace(name);
  if (namespace) {
    if (namespace.startsWith('mcp')) return 'mcp';
    const namespaced = table[bare];
    if (namespaced) return namespaced;
  }

  return 'other';
}

/** Versioned transport prefixes (`multi_agent_v1__`) carry no user meaning. */
const TRANSPORT_NAMESPACE = /_v\d+$/;

/**
 * Name to show for a tool: its own, cleaned of transport namespacing.
 * `mcp__linear__create_issue` reads as `linear: create_issue`; everything else
 * keeps the exact name the platform recorded. Namespacing is spelled the same
 * way on every platform, so this needs no platform argument.
 */
export function getToolDisplayName(name: string): string {
  const { namespace, bare } = splitToolNamespace(name);
  if (!namespace) return name;

  if (namespace.startsWith('mcp')) {
    const serverIndex = namespace.indexOf(NAMESPACE_SEPARATOR);
    const server =
      serverIndex >= 0 ? namespace.slice(serverIndex + NAMESPACE_SEPARATOR.length) : '';
    return server ? `${server}: ${bare}` : bare;
  }

  // `web__run` is a first-class Codex tool, not a transport namespace: keep it.
  return TRANSPORT_NAMESPACE.test(namespace) ? bare : name;
}

/** Whether a tool call spawns a child agent process. */
export function isSpawnToolName(name: string, platform: AgentPlatform = 'claude'): boolean {
  return getToolKind(name, platform) === 'spawn-agent';
}
