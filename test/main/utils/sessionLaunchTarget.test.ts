/**
 * Tests for resolving a `--session` request into a (projectId, sessionId) pair.
 */

import { describe, expect, it, vi } from 'vitest';

const { logWarn, logError } = vi.hoisted(() => ({ logWarn: vi.fn(), logError: vi.fn() }));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: logWarn,
    error: logError,
  }),
}));

import { resolveLaunchTarget } from '../../../src/main/utils/sessionLaunchTarget';

import type { SessionLocator } from '../../../src/main/utils/sessionLaunchTarget';
import type { Session } from '../../../src/main/types';

const SESSION_ID = 'a1b2c3d4-1111-2222-3333-444455556666';
const PROJECT_ID = '-Users-alex-src-claude-devtools';
const OTHER_PROJECT_ID = '-Users-alex-src-other';

function makeSession(id: string): Session {
  return { id, filePath: `/tmp/${id}.jsonl` } as Session;
}

/**
 * Builds a locator backed by an in-memory projectId -> sessionIds map.
 */
function makeLocator(index: Record<string, string[]>): SessionLocator {
  return {
    getSession: vi.fn((projectId: string, sessionId: string) =>
      Promise.resolve(index[projectId]?.includes(sessionId) ? makeSession(sessionId) : null)
    ),
    findSessionById: vi.fn((sessionId: string) => {
      const projectId = Object.keys(index).find((id) => index[id].includes(sessionId));
      return Promise.resolve(
        projectId ? { found: true, projectId, session: makeSession(sessionId) } : { found: false }
      );
    }),
  };
}

describe('resolveLaunchTarget', () => {
  it('returns null when no session was requested', async () => {
    const locator = makeLocator({ [PROJECT_ID]: [SESSION_ID] });

    expect(await resolveLaunchTarget(locator, {})).toBeNull();
    expect(locator.findSessionById).not.toHaveBeenCalled();
    expect(locator.getSession).not.toHaveBeenCalled();
  });

  it('locates the project containing the session when none was given', async () => {
    const locator = makeLocator({ [OTHER_PROJECT_ID]: [], [PROJECT_ID]: [SESSION_ID] });

    expect(await resolveLaunchTarget(locator, { sessionId: SESSION_ID })).toEqual({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
    });
  });

  it('uses the supplied project without scanning when it holds the session', async () => {
    const locator = makeLocator({ [PROJECT_ID]: [SESSION_ID] });

    expect(
      await resolveLaunchTarget(locator, { sessionId: SESSION_ID, projectId: PROJECT_ID })
    ).toEqual({ projectId: PROJECT_ID, sessionId: SESSION_ID });
    expect(locator.getSession).toHaveBeenCalledWith(PROJECT_ID, SESSION_ID);
    expect(locator.findSessionById).not.toHaveBeenCalled();
  });

  it('falls back to a full scan when the supplied project lacks the session', async () => {
    logWarn.mockClear();
    const locator = makeLocator({ [OTHER_PROJECT_ID]: [SESSION_ID], [PROJECT_ID]: [] });

    expect(
      await resolveLaunchTarget(locator, { sessionId: SESSION_ID, projectId: PROJECT_ID })
    ).toEqual({ projectId: OTHER_PROJECT_ID, sessionId: SESSION_ID });
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it('returns null and warns for an unknown session id', async () => {
    logWarn.mockClear();
    const locator = makeLocator({ [PROJECT_ID]: [] });

    expect(await resolveLaunchTarget(locator, { sessionId: SESSION_ID })).toBeNull();
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it('returns null when the located result carries no project id', async () => {
    logWarn.mockClear();
    const locator: SessionLocator = {
      getSession: vi.fn(() => Promise.resolve(null)),
      findSessionById: vi.fn(() => Promise.resolve({ found: true })),
    };

    expect(await resolveLaunchTarget(locator, { sessionId: SESSION_ID })).toBeNull();
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it('returns null instead of throwing when the locator fails', async () => {
    logError.mockClear();
    const locator: SessionLocator = {
      getSession: vi.fn(() => Promise.reject(new Error('disk error'))),
      findSessionById: vi.fn(() => Promise.reject(new Error('disk error'))),
    };

    expect(await resolveLaunchTarget(locator, { sessionId: SESSION_ID })).toBeNull();
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
