/**
 * Resolution of a `--session` command-line request into an openable
 * (projectId, sessionId) pair.
 *
 * A session is addressed by a project + session pair, but the command line may
 * only carry the session id. In that case every project directory is scanned
 * to find the one holding that session.
 *
 * Resolution errors are thrown so the main process can report them visibly.
 */

import { createLogger } from '@shared/utils/logger';
import * as os from 'os';
import * as path from 'path';

import { validateSessionId } from '../ipc/guards';

import type { CliArgs } from './cliArgs';
import type { FindSessionByIdResult, Session } from '@main/types';
import type { SessionLaunchTarget } from '@shared/types/api';

const logger = createLogger('SessionLaunchTarget');

/**
 * Minimal slice of ProjectScanner needed to resolve a launch target.
 * Declared structurally so tests can supply a lightweight fake.
 */
export interface SessionLocator {
  getSession(projectId: string, sessionId: string): Promise<Session | null>;
  findSessionById(sessionId: string): Promise<FindSessionByIdResult>;
  getProjectsDir(): string;
  resolveSessionFile(
    sessionPath: string,
    workingDirectory: string
  ): Promise<SessionLaunchTarget | null>;
}

export interface LaunchTargetOptions {
  workingDirectory?: string;
  fileLocator?: SessionLocator;
  idContextId?: string;
  fileContextId?: string;
}

function looksLikePath(value: string): boolean {
  return (
    value.endsWith('.jsonl') ||
    value.startsWith('.') ||
    value.startsWith('~') ||
    value.includes('/') ||
    value.includes('\\') ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  );
}

function resolveRequestedPath(value: string, workingDirectory: string): string {
  const expanded =
    value === '~' || value.startsWith('~/') || value.startsWith('~\\')
      ? path.join(os.homedir(), value.slice(2))
      : value;
  return path.resolve(workingDirectory, expanded);
}

export function formatSessionLaunchError(reason: string, workingDirectory: string): string {
  return `${reason}\n\nAccepted forms:\n  --session <session-id>\n  --session <path-to-session-log>\n  --root <path-to-claude-root>\n\nThe root must contain projects/. Relative paths are resolved from:\n  ${workingDirectory}`;
}

function withContext(
  target: SessionLaunchTarget,
  contextId: string | undefined
): SessionLaunchTarget {
  return contextId ? { ...target, contextId } : target;
}

/**
 * Searches every project for the session id.
 * @returns The launch target, or null when no project contains that session
 */
async function locateAcrossProjects(
  locator: SessionLocator,
  sessionId: string
): Promise<SessionLaunchTarget | null> {
  const found = await locator.findSessionById(sessionId);
  if (found.found && found.projectId) {
    return { projectId: found.projectId, sessionId };
  }

  return null;
}

/**
 * Resolves CLI arguments into a session that can be opened in a tab.
 *
 * - No `--session`: nothing to open (null, no warning).
 * - `--project` supplied: used directly when it holds the session, otherwise
 *   the session is searched for across all projects.
 * - Unknown session id: warn and return null.
 *
 * @returns Launch target, or null when there is nothing to open
 */
export async function resolveLaunchTarget(
  locator: SessionLocator,
  args: CliArgs,
  options: LaunchTargetOptions = {}
): Promise<SessionLaunchTarget | null> {
  if (args.error) {
    throw new Error(args.error);
  }

  const { session: sessionRequest, projectId } = args;
  if (!sessionRequest) {
    return null;
  }

  const workingDirectory = options.workingDirectory ?? process.cwd();
  const fileLocator = options.fileLocator ?? locator;
  const pathRequest = looksLikePath(sessionRequest);

  if (pathRequest && projectId) {
    throw new Error('--project cannot be combined with a session log file path');
  }

  try {
    if (!projectId) {
      const fileTarget = await fileLocator.resolveSessionFile(sessionRequest, workingDirectory);
      if (fileTarget) {
        return withContext(fileTarget, options.fileContextId);
      }
      if (pathRequest) {
        const resolved = resolveRequestedPath(sessionRequest, workingDirectory);
        throw new Error(`No session log file exists at ${resolved}`);
      }
    }

    const validatedSession = validateSessionId(sessionRequest);
    if (!validatedSession.valid) {
      throw new Error(
        `Invalid session ID ${JSON.stringify(sessionRequest)}: ${validatedSession.error ?? 'unsupported format'}`
      );
    }
    const sessionId = validatedSession.value!;

    if (projectId) {
      const session = await locator.getSession(projectId, sessionId);
      if (session) {
        return withContext({ projectId, sessionId }, options.idContextId);
      }
      logger.warn(
        `Session ${sessionId} not found in project ${projectId} - searching all projects`
      );
    }

    const target = await locateAcrossProjects(locator, sessionId);
    if (target) {
      return withContext(target, options.idContextId);
    }

    throw new Error(
      `No session log with ID ${JSON.stringify(sessionId)} was found under ${locator.getProjectsDir()}`
    );
  } catch (error) {
    logger.error(`Failed to resolve --session ${sessionRequest}:`, error);
    throw error;
  }
}
