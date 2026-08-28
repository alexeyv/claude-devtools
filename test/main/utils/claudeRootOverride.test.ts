import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveClaudeRootOverride } from '../../../src/main/utils/claudeRootOverride';

describe('resolveClaudeRootOverride', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-root-'));
    tempDirs.push(dir);
    return dir;
  }

  it('resolves a relative Claude root containing projects', async () => {
    const workingDirectory = tempDir();
    const rootDir = path.join(workingDirectory, 'fixtures', 'claude-home');
    fs.mkdirSync(path.join(rootDir, 'projects'), { recursive: true });

    await expect(
      resolveClaudeRootOverride('fixtures/claude-home', workingDirectory)
    ).resolves.toEqual({
      rootDir,
      projectsDir: path.join(rootDir, 'projects'),
      todosDir: path.join(rootDir, 'todos'),
    });
  });

  it('explains when the root does not exist', async () => {
    const workingDirectory = tempDir();

    await expect(resolveClaudeRootOverride('missing', workingDirectory)).rejects.toThrow(
      `Claude root does not exist: ${path.join(workingDirectory, 'missing')}`
    );
  });

  it('explains that the supplied root must contain projects', async () => {
    const rootDir = tempDir();

    await expect(resolveClaudeRootOverride(rootDir, '/unused')).rejects.toThrow(
      `Claude root ${rootDir} has no projects directory; pass the directory that contains projects/`
    );
  });
});
