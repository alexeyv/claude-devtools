/**
 * Tests for platform-aware tool identity.
 *
 * The point of this module is that a tool keeps the name its platform gave it
 * while behavior keys off a platform-neutral kind.
 */

import { describe, expect, it } from 'vitest';

import {
  getPlatformLabel,
  getToolDisplayName,
  getToolKind,
  isSpawnToolName,
  splitToolNamespace,
} from '../../../src/shared/utils/toolIdentity';

describe('getToolKind', () => {
  it.each([
    ['Bash', 'shell'],
    ['Read', 'file-read'],
    ['Edit', 'file-edit'],
    ['Grep', 'search'],
    ['Task', 'spawn-agent'],
    ['TodoWrite', 'todo'],
    ['SendMessage', 'agent-comms'],
  ])('classifies the Claude tool %s as %s', (name, kind) => {
    expect(getToolKind(name, 'claude')).toBe(kind);
  });

  it.each([
    ['exec_command', 'shell'],
    ['write_stdin', 'shell'],
    ['apply_patch', 'file-edit'],
    ['read_file', 'file-read'],
    ['update_plan', 'todo'],
    ['spawn_agent', 'spawn-agent'],
    ['wait_agent', 'agent-comms'],
    ['web__run', 'web-search'],
    ['view_image', 'image'],
  ])('classifies the Codex tool %s as %s', (name, kind) => {
    expect(getToolKind(name, 'codex')).toBe(kind);
  });

  it("does not apply one platform's naming to another", () => {
    // Codex has no `Bash`; Claude has no `exec_command`.
    expect(getToolKind('Bash', 'codex')).toBe('other');
    expect(getToolKind('exec_command', 'claude')).toBe('other');
  });

  it('classifies MCP tools by their namespace', () => {
    expect(getToolKind('mcp__linear__create_issue', 'codex')).toBe('mcp');
    expect(getToolKind('mcp__codebase-retrieval__search', 'claude')).toBe('mcp');
  });

  it('looks through versioned transport prefixes', () => {
    expect(getToolKind('multi_agent_v1__wait_agent', 'codex')).toBe('agent-comms');
  });

  it('falls back to other for unknown tools', () => {
    expect(getToolKind('some_new_tool', 'codex')).toBe('other');
  });
});

describe('getToolDisplayName', () => {
  it('leaves plain tool names untouched', () => {
    expect(getToolDisplayName('exec_command')).toBe('exec_command');
    expect(getToolDisplayName('Bash')).toBe('Bash');
  });

  it('renders MCP tools as server: tool', () => {
    expect(getToolDisplayName('mcp__linear__create_issue')).toBe('linear: create_issue');
  });

  it('drops meaningless transport prefixes', () => {
    expect(getToolDisplayName('multi_agent_v1__wait_agent')).toBe('wait_agent');
  });

  it('renders an MCP tool with no server segment by its bare name', () => {
    expect(getToolDisplayName('mcp__tool')).toBe('tool');
    expect(getToolDisplayName('mcp__server__tool')).toBe('server: tool');
  });

  it('keeps first-class namespaced tools like web__run intact', () => {
    expect(getToolDisplayName('web__run')).toBe('web__run');
  });
});

describe('splitToolNamespace', () => {
  it('splits on the last separator', () => {
    expect(splitToolNamespace('mcp__server__tool')).toEqual({
      namespace: 'mcp__server',
      bare: 'tool',
    });
  });

  it('reports no namespace for a bare name', () => {
    expect(splitToolNamespace('exec_command')).toEqual({ bare: 'exec_command' });
  });

  it('does not treat a leading separator as a namespace', () => {
    expect(splitToolNamespace('__weird')).toEqual({ bare: '__weird' });
  });
});

describe('isSpawnToolName', () => {
  it('recognizes the spawn tool of each platform', () => {
    expect(isSpawnToolName('Task', 'claude')).toBe(true);
    expect(isSpawnToolName('Agent', 'claude')).toBe(true);
    expect(isSpawnToolName('spawn_agent', 'codex')).toBe(true);
  });

  it('does not treat messaging an existing agent as spawning one', () => {
    expect(isSpawnToolName('followup_task', 'codex')).toBe(false);
    expect(isSpawnToolName('send_message', 'codex')).toBe(false);
  });

  it('defaults to Claude naming', () => {
    expect(isSpawnToolName('Task')).toBe(true);
  });
});

describe('getPlatformLabel', () => {
  it('names each platform', () => {
    expect(getPlatformLabel('claude')).toBe('Claude Code');
    expect(getPlatformLabel('codex')).toBe('Codex');
  });
});
