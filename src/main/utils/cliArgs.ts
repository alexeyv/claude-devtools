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

const isSessionIdValue = (value: string): boolean => validateSessionId(value).valid;
const isProjectIdValue = (value: string): boolean => validateProjectId(value).valid;

/** Whether argv carries the flag at all, with or without an attached value. */
function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * Reads the value belonging to a flag.
 *
 * `--flag=value` is unambiguous and is taken as-is. For `--flag value` the
 * value is not always adjacent: Chromium re-serializes a second instance's
 * command line before Electron hands it to the 'second-instance' event, moving
 * switches to the front and plain values to the back, so `--session <id>`
 * arrives as a bare `--session` plus a trailing `<id>`. Scanning forward for
 * the first argument that validates recovers both layouts — executable paths
 * and other switches fail validation, so they are skipped.
 *
 * @returns The value, or null when the flag is absent or carries nothing usable
 */
function readFlagValue(
  argv: readonly string[],
  flag: string,
  isValid: (value: string) => boolean
): string | null {
  const index = argv.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (index === -1) {
    return null;
  }

  const flagArg = argv[index];
  if (flagArg.startsWith(`${flag}=`)) {
    // An explicit value is never guessed at: it is used or rejected.
    const value = flagArg.slice(flag.length + 1).trim();
    return isValid(value) ? value : null;
  }

  for (let i = index + 1; i < argv.length; i++) {
    const candidate = argv[i].trim();
    if (isValid(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Parses launch arguments out of an argv array.
 *
 * Electron's own leading arguments (executable path, app path, Chromium
 * switches) are harmless here because only values that validate as ids are
 * consumed.
 *
 * @param argv - Raw argv, e.g. `process.argv` or a 'second-instance' argv
 * @returns Validated CLI arguments; `{}` when nothing usable was supplied
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  if (!hasFlag(argv, SESSION_FLAG)) {
    return {};
  }

  const sessionId = readFlagValue(argv, SESSION_FLAG, isSessionIdValue);
  if (!sessionId) {
    logger.warn(`${SESSION_FLAG} has no valid session id - ignoring`);
    return {};
  }

  const result: CliArgs = { sessionId };

  if (hasFlag(argv, PROJECT_FLAG)) {
    const projectId = readFlagValue(argv, PROJECT_FLAG, isProjectIdValue);
    if (projectId) {
      result.projectId = projectId;
    } else {
      // Keep the session request: it can still be resolved by scanning projects.
      logger.warn(`${PROJECT_FLAG} has no valid encoded project path - ignoring`);
    }
  }

  return result;
}
