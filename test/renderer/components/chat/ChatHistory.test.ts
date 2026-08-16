import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatHistory } from '../../../../src/renderer/components/chat/ChatHistory';
import { TabUIProvider } from '../../../../src/renderer/contexts/TabUIContext';
import { useStore } from '../../../../src/renderer/store';
import { createMockElectronAPI } from '../../../mocks/electronAPI';

import type { ContextStats } from '../../../../src/renderer/types/contextInjection';
import type { ChatItem, SessionConversation } from '../../../../src/renderer/types/groups';
import type { Tab } from '../../../../src/renderer/types/tabs';

class FakeIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds = [];
  disconnect(): void {
    // No-op test observer.
  }
  observe(): void {
    // No-op test observer.
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  unobserve(): void {
    // No-op test observer.
  }
}

class FakeResizeObserver implements ResizeObserver {
  disconnect(): void {
    // No-op test observer.
  }
  observe(): void {
    // No-op test observer.
  }
  unobserve(): void {
    // No-op test observer.
  }
}

const mountedRoots: Root[] = [];
let scrollIntoViewSpy: ReturnType<typeof vi.fn>;
let scrollToSpy: ReturnType<typeof vi.fn>;

function makeUserItem(id: string, text = `Message ${id}`): ChatItem {
  const timestamp = new Date('2026-08-16T12:00:00Z');
  return {
    type: 'user',
    group: {
      id,
      timestamp,
      index: 0,
      content: {
        text,
        rawText: text,
        commands: [],
        images: [],
        fileReferences: [],
      },
      message: {
        uuid: `${id}-message`,
        parentUuid: null,
        type: 'user',
        timestamp,
        role: 'user',
        content: text,
        isSidechain: false,
        isMeta: false,
        toolCalls: [],
        toolResults: [],
      },
    },
  };
}

function makeAIItem(id: string): ChatItem {
  return {
    type: 'ai',
    group: {
      id,
      turnIndex: 0,
      startTime: new Date('2026-08-16T12:00:01Z'),
      endTime: new Date('2026-08-16T12:00:02Z'),
      durationMs: 1000,
      steps: [],
      tokens: { input: 0, output: 0, cached: 0 },
      summary: {
        toolCallCount: 0,
        outputMessageCount: 0,
        subagentCount: 0,
        totalDurationMs: 1000,
        totalTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
      },
      status: 'complete',
      processes: [],
      chunkId: `${id}-chunk`,
      metrics: {} as never,
      responses: [],
    },
  };
}

function makeConversation(items: ChatItem[]): SessionConversation {
  return {
    sessionId: 'session-1',
    items,
    totalUserGroups: items.filter((item) => item.type === 'user').length,
    totalSystemGroups: items.filter((item) => item.type === 'system').length,
    totalAIGroups: items.filter((item) => item.type === 'ai').length,
    totalCompactGroups: items.filter((item) => item.type === 'compact').length,
  };
}

function makeTab(id: string): Tab {
  return {
    id,
    type: 'session',
    sessionId: 'session-1',
    projectId: 'project-1',
    label: id,
    createdAt: 1,
  };
}

function setTabs(
  conversations: Record<string, SessionConversation>,
  contextStats: Record<string, Map<string, ContextStats> | null> = {}
): void {
  const tabIds = Object.keys(conversations);
  const tabs = tabIds.map(makeTab);
  const contextStatsByTab = new Map(Object.entries(contextStats));
  useStore.setState({
    openTabs: tabs,
    activeTabId: tabIds[0] ?? null,
    paneLayout: {
      panes: [
        {
          id: 'pane-default',
          tabs,
          activeTabId: tabIds[0] ?? null,
          selectedTabIds: [],
          widthFraction: 1,
        },
      ],
      focusedPaneId: 'pane-default',
    },
    tabUIStates: new Map(),
    tabSessionData: Object.fromEntries(
      Object.entries(conversations).map(([tabId, conversation]) => [
        tabId,
        {
          sessionDetail: null,
          conversation,
          conversationLoading: false,
          sessionDetailLoading: false,
          sessionDetailError: null,
          sessionClaudeMdStats: null,
          sessionContextStats: contextStatsByTab.get(tabId) ?? null,
          sessionPhaseInfo: null,
          visibleAIGroupId: null,
          selectedAIGroup: null,
        },
      ])
    ),
    searchQuery: '',
    currentSearchIndex: -1,
    searchMatches: [],
    searchMatchItemIds: new Set(),
  });
}

async function renderTab(tabId: string): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      React.createElement(TabUIProvider, { tabId }, React.createElement(ChatHistory, { tabId }))
    );
    await Promise.resolve();
  });
  return host;
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(host.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing ${label} button`);
  return match;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

async function hover(element: HTMLElement, hovered: boolean): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent(hovered ? 'mouseover' : 'mouseout', { bubbles: true, relatedTarget: null })
    );
    await Promise.resolve();
  });
}

async function flushAnimationFrames(count = 4): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      let remaining = count;
      const tick = (): void => {
        remaining -= 1;
        if (remaining <= 0) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await Promise.resolve();
  });
}

describe('ChatHistory swimlane', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: createMockElectronAPI(),
    });
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    scrollIntoViewSpy = vi.fn();
    scrollToSpy = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(scrollIntoViewSpy);
    vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(scrollToSpy);
  });

  afterEach(() => {
    act(() => {
      while (mountedRoots.length > 0) mountedRoots.pop()?.unmount();
    });
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows an inactive Swimlane control without context or child processes', async () => {
    setTabs({ 'tab-1': makeConversation([makeUserItem('user-1')]) });

    const host = await renderTab('tab-1');

    expect(button(host, 'Swimlane').getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('[data-testid="swimlane-surface"]')).toBeNull();
    expect(host.textContent).not.toContain('Context (');
    expect(
      host.querySelector<HTMLElement>('[data-testid="turn-list-control-offset"]')?.style.paddingTop
    ).toBe('60px');
  });

  it('keeps a stateful turn mounted and preserves list scroll across toggles', async () => {
    const longText = 'x'.repeat(700);
    setTabs({ 'tab-1': makeConversation([makeUserItem('user-1', longText)]) });
    const host = await renderTab('tab-1');
    const turnList = host.querySelector<HTMLElement>('[data-testid="turn-list-surface"]');
    if (!turnList) throw new Error('Missing turn list');
    Object.defineProperty(turnList, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(turnList, 'clientHeight', { configurable: true, value: 500 });
    turnList.scrollTop = 420;
    turnList.dispatchEvent(new Event('scroll'));

    await click(button(host, 'Show more'));
    expect(button(host, 'Show less')).toBeTruthy();

    await click(button(host, 'Swimlane'));
    expect(button(host, 'Swimlane').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-testid="swimlane-surface"]')).not.toBeNull();
    expect(turnList.getAttribute('inert')).toBe('');
    expect(turnList.getAttribute('aria-hidden')).toBe('true');
    expect(button(host, 'Show less')).toBeTruthy();
    expect(turnList.scrollTop).toBe(420);

    const moveHiddenList = vi.fn(({ top }: ScrollToOptions) => {
      if (typeof top === 'number') turnList.scrollTop = top;
    });
    Object.defineProperty(turnList, 'scrollTo', { configurable: true, value: moveHiddenList });
    window.dispatchEvent(new CustomEvent('session-refresh-scroll-bottom'));
    await act(async () => {
      useStore.setState((state) => ({
        tabSessionData: {
          ...state.tabSessionData,
          'tab-1': {
            ...state.tabSessionData['tab-1'],
            conversation: makeConversation([
              makeUserItem('user-1', longText),
              makeUserItem('user-2'),
            ]),
          },
        },
      }));
      await Promise.resolve();
    });
    await flushAnimationFrames();
    expect(moveHiddenList).not.toHaveBeenCalled();
    expect(turnList.scrollTop).toBe(420);

    await click(button(host, 'Swimlane'));
    await flushAnimationFrames(5);
    expect(host.querySelector('[data-testid="swimlane-surface"]')).toBeNull();
    expect(host.querySelector('[data-testid="turn-list-surface"]')).toBe(turnList);
    expect(turnList.hasAttribute('inert')).toBe(false);
    expect(turnList.hasAttribute('aria-hidden')).toBe(false);
    expect(button(host, 'Show less')).toBeTruthy();
    expect(turnList.scrollTop).toBe(420);
  });

  it('isolates visibility through the real per-tab provider and store path', async () => {
    const conversation = makeConversation([makeUserItem('user-1')]);
    setTabs({ 'tab-1': conversation, 'tab-2': conversation, 'tab-3': conversation });
    const firstHost = await renderTab('tab-1');
    const secondHost = await renderTab('tab-2');

    await click(button(firstHost, 'Swimlane'));

    expect(useStore.getState().isSwimlaneVisibleForTab('tab-1')).toBe(true);
    expect(button(secondHost, 'Swimlane').getAttribute('aria-pressed')).toBe('false');
    expect(useStore.getState().isSwimlaneVisibleForTab('tab-2')).toBe(false);
    expect(useStore.getState().isSwimlaneVisibleForTab('tab-3')).toBe(false);
  });

  it('reapplies inert accessibility state when the loaded list container remounts', async () => {
    setTabs({ 'tab-1': makeConversation([makeUserItem('user-1')]) });
    const host = await renderTab('tab-1');
    await click(button(host, 'Swimlane'));
    const originalList = host.querySelector('[data-testid="turn-list-surface"]');

    await act(async () => {
      useStore.setState((state) => ({
        tabSessionData: {
          ...state.tabSessionData,
          'tab-1': { ...state.tabSessionData['tab-1'], conversationLoading: true },
        },
      }));
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="turn-list-surface"]')).toBeNull();

    await act(async () => {
      useStore.setState((state) => ({
        tabSessionData: {
          ...state.tabSessionData,
          'tab-1': { ...state.tabSessionData['tab-1'], conversationLoading: false },
        },
      }));
      await Promise.resolve();
    });
    const remountedList = host.querySelector<HTMLElement>('[data-testid="turn-list-surface"]');
    expect(remountedList).not.toBe(originalList);
    expect(remountedList?.getAttribute('inert')).toBe('');
    expect(remountedList?.getAttribute('aria-hidden')).toBe('true');

    await click(button(host, 'Swimlane'));
    await flushAnimationFrames(5);
    expect(remountedList?.hasAttribute('inert')).toBe(false);
    expect(remountedList?.hasAttribute('aria-hidden')).toBe(false);
  });

  it('keeps token-matched Context and Swimlane controls in the same row', async () => {
    const aiId = 'ai-1';
    const stats = {
      newInjections: [],
      accumulatedInjections: [
        {
          id: 'user-injection-1',
          category: 'user-message',
          turnIndex: 0,
          aiGroupId: aiId,
          estimatedTokens: 5,
          textPreview: 'hello',
        },
      ],
      totalEstimatedTokens: 5,
      tokensByCategory: {
        claudeMd: 0,
        mentionedFiles: 0,
        toolOutputs: 0,
        thinkingText: 0,
        taskCoordination: 0,
        userMessages: 5,
      },
      newCounts: {
        claudeMd: 0,
        mentionedFiles: 0,
        toolOutputs: 0,
        thinkingText: 0,
        taskCoordination: 0,
        userMessages: 1,
      },
      accumulatedCounts: {
        claudeMd: 0,
        mentionedFiles: 0,
        toolOutputs: 0,
        thinkingText: 0,
        taskCoordination: 0,
        userMessages: 1,
      },
    } satisfies ContextStats;
    setTabs(
      { 'tab-1': makeConversation([makeUserItem('user-1'), makeAIItem(aiId)]) },
      { 'tab-1': new Map([[aiId, stats]]) }
    );
    const host = await renderTab('tab-1');

    const contextButton = button(host, 'Context (1)');
    const swimlaneButton = button(host, 'Swimlane');
    expect(contextButton.parentElement).toBe(swimlaneButton.parentElement);
    expect(contextButton.className).toBe(swimlaneButton.className);
    for (const requiredClass of ['px-2.5', 'py-1.5', 'text-xs', 'rounded-md']) {
      expect(swimlaneButton.classList.contains(requiredClass)).toBe(true);
    }
    expect(contextButton.style.backgroundColor).toBe('var(--context-btn-bg)');
    expect(swimlaneButton.style.backgroundColor).toBe('var(--context-btn-bg)');

    await hover(contextButton, true);
    expect(contextButton.style.backgroundColor).toBe('var(--context-btn-bg-hover)');
    await hover(contextButton, false);
    await hover(swimlaneButton, true);
    expect(swimlaneButton.style.backgroundColor).toBe('var(--context-btn-bg-hover)');
    await hover(swimlaneButton, false);

    await click(contextButton);
    expect(contextButton.getAttribute('aria-pressed')).toBe('true');
    expect(contextButton.style.backgroundColor).toBe('var(--context-btn-active-bg)');
    expect(contextButton.style.color).toBe('var(--context-btn-active-text)');
    await click(swimlaneButton);
    expect(swimlaneButton.style.backgroundColor).toBe('var(--context-btn-active-bg)');
    expect(swimlaneButton.style.color).toBe('var(--context-btn-active-text)');
    expect(button(host, 'Context (1)')).toBeTruthy();
    expect(button(host, 'Swimlane')).toBeTruthy();

    const turnLink = Array.from(host.querySelectorAll<HTMLElement>('[role="link"]')).find(
      (element) => element.textContent?.trim() === '@Turn 1'
    );
    if (!turnLink) throw new Error('Missing Context turn link');
    scrollIntoViewSpy.mockClear();
    await click(turnLink);
    await flushAnimationFrames();
    expect(button(host, 'Swimlane').getAttribute('aria-pressed')).toBe('false');
    expect(scrollIntoViewSpy).toHaveBeenCalled();
    expect(
      Array.from(host.querySelectorAll<HTMLElement>('div')).some((element) =>
        element.className.includes('ring-blue-500/30')
      )
    ).toBe(true);
  });

  it('preserves the scrollTop owned by a virtualized list while covered', async () => {
    const items = Array.from({ length: 31 }, (_, index) => makeUserItem(`user-${index}`));
    setTabs({ 'tab-1': makeConversation(items) });
    const host = await renderTab('tab-1');
    const turnList = host.querySelector<HTMLElement>('[data-testid="turn-list-surface"]');
    if (!turnList) throw new Error('Missing turn list');
    turnList.scrollTop = 1750;

    await click(button(host, 'Swimlane'));
    await click(button(host, 'Swimlane'));
    await flushAnimationFrames(5);

    expect(turnList.scrollTop).toBe(1750);
  });

  it('closes Swimlane before a pending list deep link is processed', async () => {
    setTabs({ 'tab-1': makeConversation([makeUserItem('user-1')]) });
    const host = await renderTab('tab-1');
    await click(button(host, 'Swimlane'));
    scrollToSpy.mockClear();

    await act(async () => {
      useStore.getState().enqueueTabNavigation('tab-1', {
        id: 'navigation-1',
        kind: 'search',
        source: 'commandPalette',
        highlight: 'yellow',
        payload: {
          query: 'Message',
          messageTimestamp: 0,
          matchedText: 'Message',
          targetGroupId: 'user-1',
          targetMatchIndexInItem: 0,
        },
      });
      await Promise.resolve();
    });
    await flushAnimationFrames(10);

    expect(button(host, 'Swimlane').getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('[data-testid="swimlane-surface"]')).toBeNull();
    const updatedTab = useStore.getState().openTabs.find((tab) => tab.id === 'tab-1');
    expect(updatedTab?.pendingNavigation).toBeUndefined();
    expect(updatedTab?.lastConsumedNavigationId).toBe('navigation-1');
    expect(scrollToSpy).toHaveBeenCalled();
    expect(
      Array.from(host.querySelectorAll<HTMLElement>('div')).some((element) =>
        element.className.includes('ring-yellow-500/30')
      )
    ).toBe(true);
  });

  it('keeps an already-handled search open and reveals for a genuinely new selection', async () => {
    const conversation = makeConversation([makeUserItem('user-1', 'Message one Message two')]);
    setTabs({ 'tab-1': conversation });
    const host = await renderTab('tab-1');

    await act(async () => {
      useStore.getState().setSearchQuery('Message', conversation);
      await Promise.resolve();
    });
    await flushAnimationFrames();
    expect(useStore.getState().searchMatches).toHaveLength(2);

    scrollIntoViewSpy.mockClear();
    await click(button(host, 'Swimlane'));
    await flushAnimationFrames();
    expect(button(host, 'Swimlane').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-testid="swimlane-surface"]')).not.toBeNull();
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();

    await act(async () => {
      useStore.setState({ currentSearchIndex: 1 });
      await Promise.resolve();
    });
    await flushAnimationFrames();

    expect(button(host, 'Swimlane').getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('[data-testid="swimlane-surface"]')).toBeNull();
    expect(scrollIntoViewSpy).toHaveBeenCalled();
    expect(
      host
        .querySelector('mark[data-search-item-id="user-1"][data-search-match-index="1"]')
        ?.getAttribute('data-search-result')
    ).toBe('current');
  });
});
