/**
 * Tests for command-line argument parsing (`--session` / `--project`).
 */

import { describe, expect, it, vi } from 'vitest';

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: logWarn,
    error: vi.fn(),
  }),
}));

import { parseCliArgs } from '../../../src/main/utils/cliArgs';

const SESSION_ID = 'a1b2c3d4-1111-2222-3333-444455556666';
const PROJECT_ID = '-Users-alex-src-claude-devtools';

/** argv as Electron hands it to a packaged app. */
const packagedArgv = (...args: string[]): string[] => ['/Applications/dev.app/dev', ...args];

/** argv as it looks in development (`electron . --session <id>`). */
const devArgv = (...args: string[]): string[] => [
  '/path/to/node_modules/electron/dist/electron',
  '.',
  ...args,
];

describe('parseCliArgs', () => {
  it('returns nothing for an argv without flags', () => {
    expect(parseCliArgs(packagedArgv())).toEqual({});
  });

  it('parses a process-local Claude root without a session', () => {
    expect(parseCliArgs(packagedArgv('--root', '../claude-home'))).toEqual({
      root: '../claude-home',
    });
  });

  it('parses session and root together', () => {
    expect(
      parseCliArgs(packagedArgv('--session', SESSION_ID, '--root', '/Users/test/claude-home'))
    ).toEqual({
      session: SESSION_ID,
      root: '/Users/test/claude-home',
    });
  });

  it('reports a root flag with no path', () => {
    expect(parseCliArgs(packagedArgv('--root'))).toEqual({
      error: '--root requires a path to a Claude root directory',
    });
  });

  it('parses "--session <id>"', () => {
    expect(parseCliArgs(packagedArgv('--session', SESSION_ID))).toEqual({
      session: SESSION_ID,
    });
  });

  it('parses "--session=<id>"', () => {
    expect(parseCliArgs(packagedArgv(`--session=${SESSION_ID}`))).toEqual({
      session: SESSION_ID,
    });
  });

  it('parses session and project together', () => {
    expect(parseCliArgs(packagedArgv('--session', SESSION_ID, '--project', PROJECT_ID))).toEqual({
      session: SESSION_ID,
      projectId: PROJECT_ID,
    });
  });

  it('parses the "=" form of both flags in either order', () => {
    expect(
      parseCliArgs(packagedArgv(`--project=${PROJECT_ID}`, `--session=${SESSION_ID}`))
    ).toEqual({
      session: SESSION_ID,
      projectId: PROJECT_ID,
    });
  });

  it('skips Electron leading arguments in development argv', () => {
    expect(parseCliArgs(devArgv('--session', SESSION_ID))).toEqual({ session: SESSION_ID });
  });

  it('ignores unrelated switches', () => {
    expect(
      parseCliArgs(packagedArgv('--inspect', '--session', SESSION_ID, '--no-sandbox'))
    ).toEqual({ session: SESSION_ID });
  });

  it('trims surrounding whitespace from values', () => {
    expect(parseCliArgs(packagedArgv('--session', `  ${SESSION_ID}  `))).toEqual({
      session: SESSION_ID,
    });
  });

  it('reports "--session" with no value', () => {
    expect(parseCliArgs(packagedArgv('--session'))).toEqual({
      error: '--session requires a session ID or a path to a session log file',
    });
  });

  it('reports "--session" followed by another flag', () => {
    expect(parseCliArgs(packagedArgv('--session', '--project', PROJECT_ID))).toEqual({
      error: '--session requires a session ID or a path to a session log file',
    });
  });

  it('reports an empty "--session=" value', () => {
    expect(parseCliArgs(packagedArgv('--session='))).toEqual({
      error: '--session requires a session ID or a path to a session log file',
    });
  });

  it('preserves a relative path for resolution', () => {
    expect(parseCliArgs(packagedArgv('--session', '../../logs/session.jsonl'))).toEqual({
      session: '../../logs/session.jsonl',
    });
  });

  it('preserves an absolute path for resolution', () => {
    expect(parseCliArgs(packagedArgv('--session', '/Users/test/logs/session.jsonl'))).toEqual({
      session: '/Users/test/logs/session.jsonl',
    });
  });

  it('parses the relative file passed through electron-vite dev --', () => {
    expect(parseCliArgs(devArgv('--session', 'logs/session.jsonl'))).toEqual({
      session: 'logs/session.jsonl',
    });
  });

  it('reports an invalid project id without dropping the session request', () => {
    expect(
      parseCliArgs(packagedArgv('--session', SESSION_ID, '--project', 'not/a/project'))
    ).toEqual({
      session: SESSION_ID,
      error: '--project is not a valid encoded Claude project path',
    });
  });

  it('ignores "--project" without "--session"', () => {
    expect(parseCliArgs(packagedArgv('--project', PROJECT_ID))).toEqual({});
  });

  // Chromium re-serializes a second instance's command line before Electron
  // emits 'second-instance': switches move to the front, plain values to the
  // back. These argv shapes were captured from a real macOS second launch.
  describe("Chromium-normalized 'second-instance' argv", () => {
    it('recovers a session value stranded at the tail', () => {
      const argv = [
        '/path/to/electron/dist/Electron.app/Contents/MacOS/Electron',
        '--session',
        '--allow-file-access-from-files',
        '--enable-avfoundation',
        '/Users/alex/src/claude-devtools',
        SESSION_ID,
      ];

      expect(parseCliArgs(argv)).toEqual({ session: SESSION_ID });
    });

    it('recovers session and project when both flags are detached', () => {
      const argv = [
        '/path/to/electron/dist/Electron.app/Contents/MacOS/Electron',
        '--session',
        '--project',
        PROJECT_ID,
        '--allow-file-access-from-files',
        '--enable-avfoundation',
        '/Users/alex/src/claude-devtools',
        SESSION_ID,
      ];

      expect(parseCliArgs(argv)).toEqual({ session: SESSION_ID, projectId: PROJECT_ID });
    });

    it('recovers an absolute JSONL path stranded at the tail', () => {
      const argv = [
        '/path/to/electron/dist/Electron.app/Contents/MacOS/Electron',
        '--session',
        '--allow-file-access-from-files',
        '/Users/alex/src/claude-devtools',
        '/Users/test/logs/session.jsonl',
      ];

      expect(parseCliArgs(argv)).toEqual({ session: '/Users/test/logs/session.jsonl' });
    });

    it('recovers detached session and root values', () => {
      const argv = [
        '/path/to/electron/dist/Electron.app/Contents/MacOS/Electron',
        '--session',
        '--root',
        '--allow-file-access-from-files',
        '/Users/alex/src/claude-devtools',
        SESSION_ID,
        '/Users/test/claude-home',
      ];

      expect(parseCliArgs(argv)).toEqual({
        session: SESSION_ID,
        root: '/Users/test/claude-home',
      });
    });

    it('does not mistake the project id for the session id', () => {
      const argv = [
        '/path/to/electron/dist/Electron.app/Contents/MacOS/Electron',
        '--session',
        '--project',
        PROJECT_ID,
        '/Users/alex/src/claude-devtools',
      ];

      // The session value never arrived; the project id must not stand in for it.
      expect(parseCliArgs(argv)).toEqual({
        error: '--session requires a session ID or a path to a session log file',
      });
    });
  });

  it('uses the first occurrence of a repeated flag', () => {
    const other = 'ffffffff-1111-2222-3333-444455556666';
    expect(parseCliArgs(packagedArgv('--session', SESSION_ID, '--session', other))).toEqual({
      session: SESSION_ID,
    });
  });
});
