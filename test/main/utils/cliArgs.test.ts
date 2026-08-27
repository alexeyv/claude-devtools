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

  it('parses "--session <id>"', () => {
    expect(parseCliArgs(packagedArgv('--session', SESSION_ID))).toEqual({
      sessionId: SESSION_ID,
    });
  });

  it('parses "--session=<id>"', () => {
    expect(parseCliArgs(packagedArgv(`--session=${SESSION_ID}`))).toEqual({
      sessionId: SESSION_ID,
    });
  });

  it('parses session and project together', () => {
    expect(parseCliArgs(packagedArgv('--session', SESSION_ID, '--project', PROJECT_ID))).toEqual({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
    });
  });

  it('parses the "=" form of both flags in either order', () => {
    expect(
      parseCliArgs(packagedArgv(`--project=${PROJECT_ID}`, `--session=${SESSION_ID}`))
    ).toEqual({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
    });
  });

  it('skips Electron leading arguments in development argv', () => {
    expect(parseCliArgs(devArgv('--session', SESSION_ID))).toEqual({ sessionId: SESSION_ID });
  });

  it('ignores unrelated switches', () => {
    expect(
      parseCliArgs(packagedArgv('--inspect', '--session', SESSION_ID, '--no-sandbox'))
    ).toEqual({ sessionId: SESSION_ID });
  });

  it('trims surrounding whitespace from values', () => {
    expect(parseCliArgs(packagedArgv('--session', `  ${SESSION_ID}  `))).toEqual({
      sessionId: SESSION_ID,
    });
  });

  it('ignores "--session" with no value', () => {
    expect(parseCliArgs(packagedArgv('--session'))).toEqual({});
  });

  it('ignores "--session" followed by another flag', () => {
    expect(parseCliArgs(packagedArgv('--session', '--project', PROJECT_ID))).toEqual({});
  });

  it('ignores an empty "--session=" value', () => {
    expect(parseCliArgs(packagedArgv('--session='))).toEqual({});
  });

  it('rejects a session id with invalid characters and warns', () => {
    logWarn.mockClear();
    expect(parseCliArgs(packagedArgv('--session', '../../etc/passwd'))).toEqual({});
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it('rejects an over-long session id', () => {
    expect(parseCliArgs(packagedArgv('--session', 'a'.repeat(129)))).toEqual({});
  });

  it('keeps the session when the project id is invalid', () => {
    expect(
      parseCliArgs(packagedArgv('--session', SESSION_ID, '--project', 'not/a/project'))
    ).toEqual({ sessionId: SESSION_ID });
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

      expect(parseCliArgs(argv)).toEqual({ sessionId: SESSION_ID });
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

      expect(parseCliArgs(argv)).toEqual({ sessionId: SESSION_ID, projectId: PROJECT_ID });
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
      expect(parseCliArgs(argv)).toEqual({});
    });
  });

  it('uses the first occurrence of a repeated flag', () => {
    const other = 'ffffffff-1111-2222-3333-444455556666';
    expect(parseCliArgs(packagedArgv('--session', SESSION_ID, '--session', other))).toEqual({
      sessionId: SESSION_ID,
    });
  });
});
