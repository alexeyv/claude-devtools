/**
 * Command-line argument parsing for the main process.
 *
 * Supported flags (both `--flag value` and `--flag=value` forms):
 * - `--session <sessionId>` - open this session on launch
 * - `--project <projectId>` - encoded project path containing the session
 * - `--root <path>` - use this Claude root for this process only
 *
 * Parsing preserves malformed requests as errors so the main process can show
 * the user why the requested session was not opened.
 */

import { validateProjectId, validateSessionId } from '@main/ipc/guards';
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('CliArgs');

/** Flag requesting a session to open on launch. */
const SESSION_FLAG = '--session';

/** Flag scoping `--session` to a specific encoded project path. */
const PROJECT_FLAG = '--project';

/** Flag overriding the configured Claude root for this process. */
const ROOT_FLAG = '--root';

/**
 * Session/project requested on the command line. A present but malformed
 * request carries `error` so it cannot be mistaken for no request at all.
 */
export interface CliArgs {
  session?: string;
  projectId?: string;
  root?: string;
  error?: string;
}

const isProjectIdValue = (value: string): boolean => validateProjectId(value).valid;

const isSessionValue = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 4096;
};

const isDetachedSessionValue = (value: string): boolean =>
  validateSessionId(value).valid || value.toLowerCase().endsWith('.jsonl');

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

function readSessionValue(argv: readonly string[]): string | null {
  const index = argv.findIndex((arg) => arg === SESSION_FLAG || arg.startsWith(`${SESSION_FLAG}=`));
  if (index === -1) return null;

  const flagArg = argv[index];
  if (flagArg.startsWith(`${SESSION_FLAG}=`)) {
    const value = flagArg.slice(SESSION_FLAG.length + 1).trim();
    return isSessionValue(value) ? value : null;
  }

  const adjacent = argv[index + 1]?.trim();
  if (adjacent && !adjacent.startsWith('-')) {
    return isSessionValue(adjacent) ? adjacent : null;
  }

  // Chromium can detach the value from a bare switch for a second instance.
  // Ignore its executable/app paths and recover only an ID or JSONL filename.
  for (let i = argv.length - 1; i > index; i--) {
    const candidate = argv[i].trim();
    if (isSessionValue(candidate) && isDetachedSessionValue(candidate)) {
      return candidate;
    }
  }

  return null;
}

function readRootValue(argv: readonly string[]): string | null {
  const index = argv.findIndex((arg) => arg === ROOT_FLAG || arg.startsWith(`${ROOT_FLAG}=`));
  if (index === -1) return null;

  const flagArg = argv[index];
  if (flagArg.startsWith(`${ROOT_FLAG}=`)) {
    const value = flagArg.slice(ROOT_FLAG.length + 1).trim();
    return isSessionValue(value) ? value : null;
  }

  const adjacent = argv[index + 1]?.trim();
  if (adjacent && !adjacent.startsWith('-')) {
    return isSessionValue(adjacent) ? adjacent : null;
  }

  // Same second-instance normalization as --session. Root values are paths,
  // so a slash/dot/tilde distinguishes them from a detached session ID.
  for (let i = argv.length - 1; i > index; i--) {
    const candidate = argv[i].trim();
    if (
      isSessionValue(candidate) &&
      !candidate.toLowerCase().endsWith('.jsonl') &&
      (candidate.startsWith('.') ||
        candidate.startsWith('~') ||
        candidate.includes('/') ||
        candidate.includes('\\'))
    ) {
      return candidate;
    }
  }

  return null;
}

/**
 * Parses launch arguments out of an argv array.
 *
 * Electron's own leading arguments (executable path, app path, Chromium
 * switches) are skipped while recovering detached flag values.
 *
 * @param argv - Raw argv, e.g. `process.argv` or a 'second-instance' argv
 * @returns Validated CLI arguments; `{}` when nothing usable was supplied
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const hasSession = hasFlag(argv, SESSION_FLAG);
  const hasRoot = hasFlag(argv, ROOT_FLAG);
  if (!hasSession && !hasRoot) {
    return {};
  }

  const result: CliArgs = {};

  if (hasRoot) {
    const root = readRootValue(argv);
    if (!root) {
      result.error = `${ROOT_FLAG} requires a path to a Claude root directory`;
      logger.warn(result.error);
    } else {
      result.root = root;
    }
  }

  if (!hasSession) {
    return result;
  }

  const session = readSessionValue(argv);
  if (!session) {
    result.error = `${SESSION_FLAG} requires a session ID or a path to a session log file`;
    logger.warn(result.error);
    return result;
  }
  result.session = session;

  if (hasFlag(argv, PROJECT_FLAG)) {
    const projectId = readFlagValue(argv, PROJECT_FLAG, isProjectIdValue);
    if (projectId) {
      result.projectId = projectId;
    } else {
      result.error = `${PROJECT_FLAG} is not a valid encoded Claude project path`;
      logger.warn(result.error);
    }
  }

  return result;
}
