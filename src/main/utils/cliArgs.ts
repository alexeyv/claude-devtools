/**
 * Command-line argument parsing for the main process.
 *
 * Supported flags (both `--flag value` and `--flag=value` forms):
 * - `--session <sessionId>` - open this session on launch
 * - `--project <projectId>` - encoded project path containing the session
 *
 * Malformed or unusable flags are dropped with a warning so that a bad command
 * line degrades into a normal startup instead of crashing the app.
 */

import { validateProjectId, validateSessionId } from '@main/ipc/guards';
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('CliArgs');

/** Flag requesting a session to open on launch. */
const SESSION_FLAG = '--session';

/** Flag scoping `--session` to a specific encoded project path. */
const PROJECT_FLAG = '--project';

/**
 * Session/project requested on the command line.
 * Both fields are absent when the flags were missing or invalid.
 */
export interface CliArgs {
  sessionId?: string;
  projectId?: string;
}

/**
 * Reads the value of `--flag value` or `--flag=value` from an argv array.
 * Returns null when the flag is absent or has no usable value.
 */
function readFlagValue(argv: readonly string[], flag: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === flag) {
      const hasValue = i + 1 < argv.length && !argv[i + 1].startsWith('--');
      if (!hasValue) {
        logger.warn(`${flag} requires a value - ignoring`);
        return null;
      }
      return argv[i + 1];
    }

    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1);
      if (value.length === 0) {
        logger.warn(`${flag} requires a value - ignoring`);
        return null;
      }
      return value;
    }
  }

  return null;
}

/**
 * Parses launch arguments out of an argv array.
 *
 * Electron's own leading arguments (executable path, app path, Chromium
 * switches) are harmless here because only values following a known flag are
 * consumed.
 *
 * @param argv - Raw argv, e.g. `process.argv`
 * @returns Validated CLI arguments; `{}` when nothing usable was supplied
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const rawSessionId = readFlagValue(argv, SESSION_FLAG);
  if (rawSessionId === null) {
    return {};
  }

  const session = validateSessionId(rawSessionId);
  if (!session.valid) {
    logger.warn(`${SESSION_FLAG} value rejected: ${session.error ?? 'invalid sessionId'}`);
    return {};
  }

  const result: CliArgs = { sessionId: session.value };

  const rawProjectId = readFlagValue(argv, PROJECT_FLAG);
  if (rawProjectId !== null) {
    const project = validateProjectId(rawProjectId);
    if (project.valid) {
      result.projectId = project.value;
    } else {
      // Keep the session request: it can still be resolved by scanning projects.
      logger.warn(`${PROJECT_FLAG} value rejected: ${project.error ?? 'invalid projectId'}`);
    }
  }

  return result;
}
