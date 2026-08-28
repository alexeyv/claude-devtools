/**
 * Session detail slice tests: per-tab fetch isolation and in-place refresh seeding.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installMockElectronAPI, type MockElectronAPI } from '../../mocks/electronAPI';

import { createTestStore, type TestStore } from './storeTestUtils';

import type { SessionConversation } from '../../../src/renderer/types/groups';

const incrementalUpdateSpy = vi.fn();

vi.mock('@renderer/utils/groupTransformer', async (importOriginal) => {
  const original = await importOriginal<typeof import('@renderer/utils/groupTransformer')>();
  return {
    ...original,
    transformChunksToConversation: (chunks: { sessionId?: string }[]) =>
      conversationFor(chunks[0]?.sessionId ?? 'unknown', 'fresh'),
    incrementalUpdateConversation: (
      prev: SessionConversation,
      chunks: { sessionId?: string }[]
    ) => {
      incrementalUpdateSpy(prev, chunks);
      return conversationFor(chunks[0]?.sessionId ?? 'unknown', 'incremental');
    },
  };
});

function conversationFor(sessionId: string, marker: string): SessionConversation {
  return {
    sessionId,
    items: [{ type: 'system', group: { id: `${sessionId}-${marker}` } } as never],
    totalUserGroups: 0,
    totalSystemGroups: 1,
    totalAIGroups: 0,
    totalCompactGroups: 0,
  };
}

/** Minimal chunk that satisfies asEnhancedChunkArray's structural check. */
function chunksFor(sessionId: string): unknown[] {
  return [{ chunkType: 'user', rawMessages: [], sessionId }];
}

let fingerprintCounter = 0;

function detailFor(sessionId: string): unknown {
  return {
    session: { id: sessionId, projectPath: '/proj', isOngoing: true },
    chunks: chunksFor(sessionId),
    processes: [],
    fingerprint: `fp-${sessionId}-${++fingerprintCounter}`,
  };
}

describe('sessionDetailSlice', () => {
  let store: TestStore;
  let mockAPI: MockElectronAPI;

  beforeEach(() => {
    mockAPI = installMockElectronAPI();
    store = createTestStore();
    incrementalUpdateSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchSessionDetail', () => {
    it('completes concurrent fetches for different tabs without cancelling either', async () => {
      const state = store.getState();
      state.openTab({ type: 'session', sessionId: 'session-a', projectId: 'p1', label: 'A' });
      state.openTab({ type: 'session', sessionId: 'session-b', projectId: 'p1', label: 'B' });
      const [tabA, tabB] = store.getState().paneLayout.panes[0].tabs;

      const resolvers = new Map<string, (value: unknown) => void>();
      mockAPI.getSessionDetail.mockImplementation(
        (_projectId: string, sessionId: string) =>
          new Promise((resolve) => {
            resolvers.set(sessionId, resolve);
          })
      );

      const fetchA = store.getState().fetchSessionDetail('p1', 'session-a', tabA.id);
      const fetchB = store.getState().fetchSessionDetail('p1', 'session-b', tabB.id);
      expect(store.getState().tabSessionData[tabA.id].sessionDetailLoading).toBe(true);
      expect(store.getState().tabSessionData[tabB.id].sessionDetailLoading).toBe(true);

      // Resolve in the order they were issued: the first must not be treated as stale.
      resolvers.get('session-a')?.(detailFor('session-a'));
      await fetchA;
      resolvers.get('session-b')?.(detailFor('session-b'));
      await fetchB;

      const { tabSessionData } = store.getState();
      expect(tabSessionData[tabA.id].sessionDetailLoading).toBe(false);
      expect(tabSessionData[tabA.id].conversationLoading).toBe(false);
      expect(tabSessionData[tabA.id].sessionDetail?.session.id).toBe('session-a');
      expect(tabSessionData[tabA.id].conversation?.sessionId).toBe('session-a');
      expect(tabSessionData[tabB.id].sessionDetailLoading).toBe(false);
      expect(tabSessionData[tabB.id].sessionDetail?.session.id).toBe('session-b');
      expect(tabSessionData[tabB.id].conversation?.sessionId).toBe('session-b');
    });

    it('lets a newer fetch for the same tab supersede an older one without a stuck spinner', async () => {
      const state = store.getState();
      state.openTab({ type: 'session', sessionId: 'session-a', projectId: 'p1', label: 'A' });
      const [tab] = store.getState().paneLayout.panes[0].tabs;

      const resolvers = new Map<string, (value: unknown) => void>();
      mockAPI.getSessionDetail.mockImplementation(
        (_projectId: string, sessionId: string) =>
          new Promise((resolve) => {
            resolvers.set(sessionId, resolve);
          })
      );

      const first = store.getState().fetchSessionDetail('p1', 'session-a', tab.id);
      const second = store.getState().fetchSessionDetail('p1', 'session-b', tab.id);
      resolvers.get('session-b')?.(detailFor('session-b'));
      resolvers.get('session-a')?.(detailFor('session-a'));
      await Promise.all([first, second]);

      const tabData = store.getState().tabSessionData[tab.id];
      expect(tabData.sessionDetailLoading).toBe(false);
      expect(tabData.sessionDetail?.session.id).toBe('session-b');
    });
  });

  describe('refreshSessionInPlace', () => {
    it('seeds the incremental update from the refreshed tab, not the active pane', async () => {
      const state = store.getState();
      state.openTab({ type: 'session', sessionId: 'session-a', projectId: 'p1', label: 'A' });
      state.openTab({ type: 'session', sessionId: 'session-b', projectId: 'p1', label: 'B' });
      const [tabA, tabB] = store.getState().paneLayout.panes[0].tabs;
      // Split so both are visible, then make A the active/global session.
      store.getState().splitPane('pane-default', tabB.id, 'right');
      store.getState().setActiveTab(tabA.id);

      const conversationA = conversationFor('session-a', 'seed');
      const conversationB = conversationFor('session-b', 'seed');
      store.setState({
        selectedSessionId: 'session-a',
        conversation: conversationA,
        tabSessionData: {
          [tabA.id]: {
            ...store.getState().tabSessionData[tabA.id],
            sessionDetail: null,
            conversation: conversationA,
            conversationLoading: false,
            sessionDetailLoading: false,
            sessionDetailError: null,
            sessionClaudeMdStats: null,
            sessionContextStats: null,
            sessionPhaseInfo: null,
            visibleAIGroupId: null,
            selectedAIGroup: null,
          },
          [tabB.id]: {
            sessionDetail: null,
            conversation: conversationB,
            conversationLoading: false,
            sessionDetailLoading: false,
            sessionDetailError: null,
            sessionClaudeMdStats: null,
            sessionContextStats: null,
            sessionPhaseInfo: null,
            visibleAIGroupId: null,
            selectedAIGroup: null,
          },
        },
      });

      mockAPI.getSessionDetail.mockResolvedValue(detailFor('session-b') as never);
      await store.getState().refreshSessionInPlace('p1', 'session-b');

      expect(incrementalUpdateSpy).toHaveBeenCalledTimes(1);
      expect(incrementalUpdateSpy.mock.calls[0][0]).toBe(conversationB);

      const after = store.getState();
      // Background pane B updated with B's data; active pane A untouched.
      expect(after.tabSessionData[tabB.id].conversation?.sessionId).toBe('session-b');
      expect(after.tabSessionData[tabA.id].conversation).toBe(conversationA);
      expect(after.conversation).toBe(conversationA);
    });
  });
});
