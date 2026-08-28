import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ProjectScanner } from '../../../../src/main/services/discovery/ProjectScanner';
import { SessionParser } from '../../../../src/main/services/parsing/SessionParser';

const SESSION_ID = 'fbf00fa7-bf56-4f73-a220-9542f4e3a019';

describe('ProjectScanner.resolveSessionFile', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-file-'));
    tempDirs.push(dir);
    return dir;
  }

  it('loads a relative session log outside the configured projects directory', async () => {
    const root = tempDir();
    const projectsDir = path.join(root, 'configured-claude-home', 'projects');
    const logsDir = path.join(root, 'external', 'logs');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    const filePath = path.join(logsDir, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({
        type: 'user',
        sessionId: SESSION_ID,
        cwd: '/work/project',
        uuid: 'message-1',
        timestamp: '2026-08-28T12:00:00.000Z',
        message: { role: 'user', content: 'Open this exact file' },
      })}\n`
    );

    const scanner = new ProjectScanner(projectsDir);
    const target = await scanner.resolveSessionFile(path.relative(root, filePath), root);

    expect(target).toEqual({
      projectId: expect.stringMatching(/^-session-file-[0-9a-f]{24}$/),
      sessionId: SESSION_ID,
    });
    expect(scanner.getSessionPath(target!.projectId, target!.sessionId)).toBe(filePath);
    await expect(scanner.getSession(target!.projectId, target!.sessionId)).resolves.toMatchObject({
      id: SESSION_ID,
      projectId: target!.projectId,
      projectPath: '/work/project',
      firstMessage: 'Open this exact file',
    });

    const parsed = await new SessionParser(scanner).parseSession(
      target!.projectId,
      target!.sessionId
    );
    expect(parsed.byType.realUser).toHaveLength(1);
  });

  it('returns null when the resolved path does not exist', async () => {
    const root = tempDir();
    const scanner = new ProjectScanner(path.join(root, 'projects'));

    await expect(scanner.resolveSessionFile('missing.jsonl', root)).resolves.toBeNull();
  });

  it('explains when an existing file is not a Claude session log', async () => {
    const root = tempDir();
    const filePath = path.join(root, 'events.jsonl');
    fs.writeFileSync(filePath, `${JSON.stringify({ type: 'unrelated-event', value: 1 })}\n`);
    const scanner = new ProjectScanner(path.join(root, 'projects'));

    await expect(scanner.resolveSessionFile(filePath, root)).rejects.toThrow(
      `${filePath} does not contain recognizable Claude session records`
    );
  });
});
