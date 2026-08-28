/**
 * Session slice unit tests.
 * Tests session state management including fetching, pagination, and selection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installMockElectronAPI, type MockElectronAPI } from '../../mocks/electronAPI';

import { createTestStore, type TestStore } from './storeTestUtils';

describe('sessionSlice', () => {
  let store: TestStore;
  let mockAPI: MockElectronAPI;

  beforeEach(() => {
    mockAPI = installMockElectronAPI();
    store = createTestStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchSessionsInitial', () => {
    it('should fetch first page of sessions', async () => {
      const mockSessions = [
        { id: 'session-1', createdAt: '2024-01-15T10:00:00Z' },
        { id: 'session-2', createdAt: '2024-01-14T10:00:00Z' },
      ];

      mockAPI.getSessionsPaginated.mockResolvedValue({
        sessions: mockSessions as never[],
        nextCursor: 'cursor-1',
        hasMore: true,
        totalCount: 50,
      });

      await store.getState().fetchSessionsInitial('project-1');

      expect(mockAPI.getSessionsPaginated).toHaveBeenCalledWith('project-1', null, 20, {
        includeTotalCount: false,
        prefilterAll: false,
        metadataLevel: 'light',
      });
      expect(store.getState().sessions).toHaveLength(2);
      expect(store.getState().sessionsCursor).toBe('cursor-1');
      expect(store.getState().sessionsHasMore).toBe(true);
      expect(store.getState().sessionsTotalCount).toBe(50);
      expect(store.getState().sessionsLoading).toBe(false);
    });

    it('caches under the requested project and ignores a superseded fetch', async () => {
      const resolvers = new Map<string, (value: unknown) => void>();
      mockAPI.getSessionsPaginated.mockImplementation(
        (projectId: string) =>
          new Promise((resolve) => {
            resolvers.set(projectId, resolve);
          })
      );

      store.setState({ selectedProjectId: 'project-a' });
      const fetchA = store.getState().fetchSessionsInitial('project-a');
      store.setState({ selectedProjectId: 'project-b' });
      const fetchB = store.getState().fetchSessionsInitial('project-b');

      // B resolves first, then the stale A response lands.
      resolvers.get('project-b')?.({
        sessions: [{ id: 'b-1' }],
        nextCursor: null,
        hasMore: false,
        totalCount: 1,
      });
      await fetchB;
      resolvers.get('project-a')?.({
        sessions: [{ id: 'a-1' }],
        nextCursor: null,
        hasMore: false,
        totalCount: 1,
      });
      await fetchA;

      expect(store.getState().sessions.map((s) => s.id)).toEqual(['b-1']);
      expect(store.getState().sessionsLoading).toBe(false);
      expect(store.getState()._sessionCache.get('project-a')?.sessions.map((s) => s.id)).toEqual([
        'a-1',
      ]);
      expect(store.getState()._sessionCache.get('project-b')?.sessions.map((s) => s.id)).toEqual([
        'b-1',
      ]);
    });

    it('should set loading state during fetch', async () => {
      mockAPI.getSessionsPaginated.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  sessions: [],
                  nextCursor: null,
                  hasMore: false,
                  totalCount: 0,
                }),
              100
            );
          })
      );

      const fetchPromise = store.getState().fetchSessionsInitial('project-1');
      expect(store.getState().sessionsLoading).toBe(true);

      vi.useFakeTimers();
      vi.advanceTimersByTime(100);
      await fetchPromise;
      vi.useRealTimers();

      expect(store.getState().sessionsLoading).toBe(false);
    });

    it('should handle fetch error', async () => {
      mockAPI.getSessionsPaginated.mockRejectedValue(new Error('Network error'));

      await store.getState().fetchSessionsInitial('project-1');

      expect(store.getState().sessionsError).toBe('Network error');
      expect(store.getState().sessionsLoading).toBe(false);
    });
  });

  describe('fetchSessionsMore', () => {
    it('should append sessions to existing list', async () => {
      // Setup initial state
      store.setState({
        selectedProjectId: 'project-1',
        sessions: [{ id: 'session-1' }] as never[],
        sessionsCursor: 'cursor-1',
        sessionsHasMore: true,
        sessionsLoadingMore: false,
      });

      mockAPI.getSessionsPaginated.mockResolvedValue({
        sessions: [{ id: 'session-2' }] as never[],
        nextCursor: 'cursor-2',
        hasMore: true,
        totalCount: 50,
      });

      await store.getState().fetchSessionsMore();

      expect(store.getState().sessions).toHaveLength(2);
      expect(store.getState().sessionsCursor).toBe('cursor-2');
    });

    it('should not fetch if no more pages', async () => {
      store.setState({
        selectedProjectId: 'project-1',
        sessionsHasMore: false,
        sessionsCursor: null,
      });

      await store.getState().fetchSessionsMore();

      expect(mockAPI.getSessionsPaginated).not.toHaveBeenCalled();
    });

    it('should not fetch if already loading', async () => {
      store.setState({
        selectedProjectId: 'project-1',
        sessionsHasMore: true,
        sessionsCursor: 'cursor-1',
        sessionsLoadingMore: true,
      });

      await store.getState().fetchSessionsMore();

      expect(mockAPI.getSessionsPaginated).not.toHaveBeenCalled();
    });
  });

  describe('selectSession', () => {
    it('should update selected session ID', () => {
      store.setState({
        selectedProjectId: 'project-1',
      });

      mockAPI.getSessionDetail.mockResolvedValue({
        session: { id: 'session-1' },
        chunks: [],
      } as never);

      store.getState().selectSession('session-1');

      expect(store.getState().selectedSessionId).toBe('session-1');
    });

    it('should clear previous session detail', () => {
      store.setState({
        selectedProjectId: 'project-1',
        sessionDetail: { session: { id: 'old-session' } } as never,
        sessionContextStats: new Map() as never,
      });

      mockAPI.getSessionDetail.mockResolvedValue({
        session: { id: 'session-2' },
        chunks: [],
      } as never);

      store.getState().selectSession('session-2');

      expect(store.getState().sessionDetail).toBeNull();
      expect(store.getState().sessionContextStats).toBeNull();
    });
  });

  describe('clearSelection', () => {
    it('should clear all selection state', () => {
      store.setState({
        selectedProjectId: 'project-1',
        selectedSessionId: 'session-1',
        sessions: [{ id: 'session-1' }] as never[],
        sessionDetail: { session: { id: 'session-1' } } as never,
      });

      store.getState().clearSelection();

      expect(store.getState().selectedProjectId).toBeNull();
      expect(store.getState().selectedSessionId).toBeNull();
      expect(store.getState().sessions).toHaveLength(0);
      expect(store.getState().sessionDetail).toBeNull();
    });
  });

  describe('refreshSessionsInPlace', () => {
    it('should refresh sessions without loading state', async () => {
      store.setState({
        selectedProjectId: 'project-1',
        sessions: [{ id: 'session-1' }] as never[],
        sessionsLoading: false,
      });

      mockAPI.getSessionsPaginated.mockResolvedValue({
        sessions: [{ id: 'session-1' }, { id: 'session-2' }] as never[],
        nextCursor: null,
        hasMore: false,
        totalCount: 2,
      });

      await store.getState().refreshSessionsInPlace('project-1');

      expect(store.getState().sessions).toHaveLength(2);
      expect(mockAPI.getSessionsPaginated).toHaveBeenCalledWith('project-1', null, 20, {
        includeTotalCount: false,
        prefilterAll: false,
        metadataLevel: 'light',
      });
      // Should not have set loading state
      expect(store.getState().sessionsLoading).toBe(false);
    });

    it('should skip refresh if different project selected', async () => {
      store.setState({
        selectedProjectId: 'project-1',
      });

      await store.getState().refreshSessionsInPlace('project-2');

      expect(mockAPI.getSessionsPaginated).not.toHaveBeenCalled();
    });

    it('should ignore stale refresh responses and keep latest result', async () => {
      store.setState({
        selectedProjectId: 'project-1',
        sessions: [{ id: 'seed' }] as never[],
      });

      let resolveFirst: ((value: unknown) => void) | undefined;
      let resolveSecond: ((value: unknown) => void) | undefined;

      mockAPI.getSessionsPaginated
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSecond = resolve;
            })
        );

      const first = store.getState().refreshSessionsInPlace('project-1');
      const second = store.getState().refreshSessionsInPlace('project-1');

      resolveSecond?.({
        sessions: [{ id: 'newest' }] as never[],
        nextCursor: null,
        hasMore: false,
        totalCount: 1,
      });
      resolveFirst?.({
        sessions: [{ id: 'stale' }] as never[],
        nextCursor: null,
        hasMore: false,
        totalCount: 1,
      });

      await Promise.all([first, second]);
      expect(store.getState().sessions[0]?.id).toBe('newest');
    });
  });

  describe('fetchSessionDetail', () => {
    it('should ignore stale responses and keep the latest session detail', async () => {
      store.setState({
        selectedSessionId: 'session-2',
      });

      let resolveFirst: ((value: unknown) => void) | undefined;
      let resolveSecond: ((value: unknown) => void) | undefined;

      mockAPI.getSessionDetail
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSecond = resolve;
            })
        );

      const first = store.getState().fetchSessionDetail('project-1', 'session-1');
      const second = store.getState().fetchSessionDetail('project-1', 'session-2');

      resolveSecond?.({
        session: { id: 'session-2' },
        chunks: [],
        processes: [],
      });
      resolveFirst?.({
        session: { id: 'session-1' },
        chunks: [],
        processes: [],
      });

      await Promise.all([first, second]);
      expect(store.getState().sessionDetail?.session.id).toBe('session-2');
    });
  });
});
