/**
 * Resolution of a `--session` command-line request into an openable
 * (projectId, sessionId) pair.
 *
 * A session is addressed by a project + session pair, but the command line may
 * only carry the session id. In that case every project directory is scanned
 * to find the one holding that session.
 *
 * All failures are non-fatal: they log a warning and resolve to null so the app
 * falls back to a normal startup.
 */

import { createLogger } from '@shared/utils/logger';

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

  logger.warn(`No project contains session ${sessionId} - ignoring --session`);
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
  args: CliArgs
): Promise<SessionLaunchTarget | null> {
  const { sessionId, projectId } = args;
  if (!sessionId) {
    return null;
  }

  try {
    if (projectId) {
      const session = await locator.getSession(projectId, sessionId);
      if (session) {
        return { projectId, sessionId };
      }
      logger.warn(
        `Session ${sessionId} not found in project ${projectId} - searching all projects`
      );
    }

    return await locateAcrossProjects(locator, sessionId);
  } catch (error) {
    logger.error(`Failed to resolve --session ${sessionId}:`, error);
    return null;
  }
}
