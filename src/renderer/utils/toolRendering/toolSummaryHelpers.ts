/**
 * Tool Summary Helpers
 *
 * Utilities for generating human-readable summaries for tool calls.
 */

import { getBaseName } from '@renderer/utils/pathUtils';
import { type AgentPlatform, getToolDisplayName, getToolKind } from '@shared/utils/toolIdentity';

/**
 * Truncates a string to a maximum length with ellipsis.
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + '...';
}

/**
 * Summary for a tool from a platform whose names this module does not enumerate.
 * Keyed on `ToolKind` so a tool keeps its own name while still getting a
 * meaningful one-line summary.
 */
function getSummaryByKind(
  toolName: string,
  input: Record<string, unknown>,
  platform: AgentPlatform
): string {
  const displayName = getToolDisplayName(toolName);

  switch (getToolKind(toolName, platform)) {
    case 'shell': {
      const command = input.command ?? input.cmd;
      if (typeof command === 'string' && command.length > 0) return truncate(command, 50);

      // Tools that drive an already-running shell identify it by session.
      const session = input.session_id;
      if (typeof session === 'string' || typeof session === 'number') {
        return `${displayName} → session ${session}`;
      }

      return displayName;
    }

    case 'file-read':
    case 'file-write':
    case 'image': {
      const filePath = input.file_path ?? input.path ?? input.filename;
      if (typeof filePath === 'string') return getBaseName(filePath);
      return displayName;
    }

    case 'file-edit': {
      const filePath = input.file_path ?? input.path;
      if (typeof filePath !== 'string') return displayName;

      const action = input.patch_action;
      const fileName = getBaseName(filePath);
      return typeof action === 'string' ? `${action} ${fileName}` : fileName;
    }

    case 'todo': {
      const description = input.description ?? input.explanation;
      if (typeof description === 'string' && description.length > 0) {
        return truncate(description, 50);
      }

      const stepCount = input.step_count;
      if (typeof stepCount === 'number') return `${stepCount} steps`;

      return displayName;
    }

    case 'spawn-agent': {
      const description = input.description ?? input.name;
      if (typeof description === 'string') return truncate(description, 50);
      return displayName;
    }

    case 'agent-comms': {
      const target = input.agent_path ?? input.recipient ?? input.agent;
      if (typeof target === 'string') return `${displayName} → ${target}`;
      return displayName;
    }

    case 'mcp': {
      const query = input.query ?? input.path ?? input.name;
      if (typeof query === 'string') return truncate(query, 50);
      return displayName;
    }

    case 'web-search':
    case 'web-fetch': {
      const query = input.query ?? input.url;
      if (typeof query === 'string') return truncate(query, 50);
      return displayName;
    }

    default:
      return displayName;
  }
}

/**
 * Generates a human-readable summary for a tool call.
 *
 * `platform` selects the naming the session was recorded with; tools keep
 * their native names, so only the summary logic differs.
 */
export function getToolSummary(
  toolName: string,
  input: Record<string, unknown>,
  platform: AgentPlatform = 'claude'
): string {
  if (platform !== 'claude') {
    return getSummaryByKind(toolName, input, platform);
  }

  switch (toolName) {
    case 'Edit': {
      const filePath = input.file_path as string | undefined;
      const oldString = input.old_string as string | undefined;
      const newString = input.new_string as string | undefined;

      if (!filePath) return 'Edit';

      const fileName = getBaseName(filePath);

      // Count line changes if we have old/new strings
      if (oldString && newString) {
        const oldLines = oldString.split('\n').length;
        const newLines = newString.split('\n').length;
        if (oldLines === newLines) {
          return `${fileName} - ${oldLines} line${oldLines > 1 ? 's' : ''}`;
        }
        return `${fileName} - ${oldLines} -> ${newLines} lines`;
      }

      return fileName;
    }

    case 'Read': {
      const filePath = input.file_path as string | undefined;
      const limit = input.limit as number | undefined;
      const offset = input.offset as number | undefined;

      if (!filePath) return 'Read';

      const fileName = getBaseName(filePath);

      if (limit) {
        const start = offset ?? 1;
        return `${fileName} - lines ${start}-${start + limit - 1}`;
      }

      return fileName;
    }

    case 'Write': {
      const filePath = input.file_path as string | undefined;
      const content = input.content as string | undefined;

      if (!filePath) return 'Write';

      const fileName = getBaseName(filePath);

      if (content) {
        const lineCount = content.split('\n').length;
        return `${fileName} - ${lineCount} lines`;
      }

      return fileName;
    }

    case 'Bash': {
      const command = input.command as string | undefined;
      const description = input.description as string | undefined;

      // Prefer description if available
      if (description) {
        return truncate(description, 50);
      }

      if (command) {
        return truncate(command, 50);
      }

      return 'Bash';
    }

    case 'Grep': {
      const pattern = input.pattern as string | undefined;
      const path = input.path as string | undefined;
      const glob = input.glob as string | undefined;

      if (!pattern) return 'Grep';

      const patternStr = `"${truncate(pattern, 30)}"`;

      if (glob) {
        return `${patternStr} in ${glob}`;
      }
      if (path) {
        return `${patternStr} in ${getBaseName(path)}`;
      }

      return patternStr;
    }

    case 'Glob': {
      const pattern = input.pattern as string | undefined;
      const path = input.path as string | undefined;

      if (!pattern) return 'Glob';

      const patternStr = `"${truncate(pattern, 30)}"`;

      if (path) {
        return `${patternStr} in ${getBaseName(path)}`;
      }

      return patternStr;
    }

    case 'Task': {
      const prompt = input.prompt as string | undefined;
      const subagentType = input.subagentType as string | undefined;
      const description = input.description as string | undefined;

      const desc = description ?? prompt;
      const typeStr = subagentType ? `${subagentType} - ` : '';

      if (desc) {
        return `${typeStr}${truncate(desc, 40)}`;
      }

      return subagentType ?? 'Task';
    }

    case 'LSP': {
      const operation = input.operation as string | undefined;
      const filePath = input.filePath as string | undefined;

      if (!operation) return 'LSP';

      if (filePath) {
        return `${operation} - ${getBaseName(filePath)}`;
      }

      return operation;
    }

    case 'WebFetch': {
      const url = input.url as string | undefined;

      if (url) {
        try {
          const urlObj = new URL(url);
          return truncate(urlObj.hostname + urlObj.pathname, 50);
        } catch {
          return truncate(url, 50);
        }
      }

      return 'WebFetch';
    }

    case 'WebSearch': {
      const query = input.query as string | undefined;

      if (query) {
        return `"${truncate(query, 40)}"`;
      }

      return 'WebSearch';
    }

    case 'TodoWrite': {
      const todos = input.todos as unknown[] | undefined;

      if (todos && Array.isArray(todos)) {
        return `${todos.length} item${todos.length !== 1 ? 's' : ''}`;
      }

      return 'TodoWrite';
    }

    case 'NotebookEdit': {
      const notebookPath = input.notebook_path as string | undefined;
      const editMode = input.edit_mode as string | undefined;

      if (notebookPath) {
        const fileName = getBaseName(notebookPath);
        return editMode ? `${editMode} - ${fileName}` : fileName;
      }

      return 'NotebookEdit';
    }

    // =========================================================================
    // Team Tools
    // =========================================================================

    case 'TeamCreate': {
      const teamName = input.team_name as string | undefined;
      const desc = input.description as string | undefined;
      if (teamName) return `${teamName}${desc ? ' - ' + truncate(desc, 30) : ''}`;
      return 'Create team';
    }

    case 'TaskCreate': {
      const subject = input.subject as string | undefined;
      return subject ? truncate(subject, 50) : 'Create task';
    }

    case 'TaskUpdate': {
      const taskId = input.taskId as string | undefined;
      const status = input.status as string | undefined;
      const owner = input.owner as string | undefined;
      const parts: string[] = [];
      if (taskId) parts.push(`#${taskId}`);
      if (status) parts.push(status);
      if (owner) parts.push(`-> ${owner}`);
      return parts.length > 0 ? parts.join(' ') : 'Update task';
    }

    case 'TaskList':
      return 'List tasks';

    case 'TaskGet': {
      const taskId = input.taskId as string | undefined;
      return taskId ? `Get task #${taskId}` : 'Get task';
    }

    case 'SendMessage': {
      const msgType = input.type as string | undefined;
      const recipient = input.recipient as string | undefined;
      const summary = input.summary as string | undefined;
      if (msgType === 'shutdown_request' && recipient) return `Shutdown ${recipient}`;
      if (msgType === 'shutdown_response') return 'Shutdown response';
      if (msgType === 'broadcast') return `Broadcast: ${truncate(summary ?? '', 30)}`;
      if (recipient) return `To ${recipient}: ${truncate(summary ?? '', 30)}`;
      return 'Send message';
    }

    case 'TeamDelete':
      return 'Delete team';

    default: {
      // For unknown tools, try to extract a meaningful summary
      const keys = Object.keys(input);
      if (keys.length === 0) return toolName;

      // Try common parameter names
      const nameField = input.name ?? input.path ?? input.file ?? input.query ?? input.command;
      if (typeof nameField === 'string') {
        return truncate(nameField, 50);
      }

      // Fallback to showing first parameter
      const firstValue = input[keys[0]];
      if (typeof firstValue === 'string') {
        return truncate(firstValue, 40);
      }

      return toolName;
    }
  }
}
