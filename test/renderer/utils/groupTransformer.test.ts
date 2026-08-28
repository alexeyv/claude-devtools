import { describe, expect, it } from 'vitest';

import { extractCommands } from '../../../src/renderer/utils/groupTransformer';

describe('extractCommands', () => {
  it('matches a bare slash command at the start of a line', () => {
    const commands = extractCommands('/compact');
    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe('compact');
    expect(commands[0].args).toBeUndefined();
  });

  it('matches a slash command with arguments', () => {
    const commands = extractCommands('/goal something to do');
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ name: 'goal', args: 'something to do' });
  });

  it('matches commands on their own line inside multi-line text', () => {
    const commands = extractCommands('first line\n/compact\nlast line');
    expect(commands.map((c) => c.name)).toEqual(['compact']);
  });

  it('does not match slashes in the middle of a line', () => {
    expect(extractCommands('this and/or that')).toEqual([]);
    expect(extractCommands('see https://x.com/foo')).toEqual([]);
    expect(extractCommands('see ./src/foo')).toEqual([]);
    expect(extractCommands('run /usr/bin/env')).toEqual([]);
  });

  it('matches an indented slash command', () => {
    expect(extractCommands('  /compact').map((c) => c.name)).toEqual(['compact']);
    expect(extractCommands('\t/goal ship it').map((c) => [c.name, c.args])).toEqual([
      ['goal', 'ship it'],
    ]);
  });

  it('does not match path-like lines', () => {
    expect(extractCommands('/src/foo')).toEqual([]);
  });
});
