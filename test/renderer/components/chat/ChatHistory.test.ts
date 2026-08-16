import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatHistory } from '../../../../src/renderer/components/chat/ChatHistory';
import { TabUIProvider } from '../../../../src/renderer/contexts/TabUIContext';
import { useStore } from '../../../../src/renderer/store';
import { createMockElectronAPI } from '../../../mocks/electronAPI';

import type { Process, SessionDetail, SwimlaneModel } from '../../../../src/main/types';
import type { ContextStats } from '../../../../src/renderer/types/contextInjection';
import type { ChatItem, SessionConversation } from '../../../../src/renderer/types/groups';
import type { Tab } from '../../../../src/renderer/types/tabs';
import { getSubagentDisplayItemId } from '../../../../src/renderer/types/tabs';

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

function makeAIItemWithChild(
  id: string,
  childId: string,
  spawnId?: string
): { item: ChatItem; process: Process } {
  const startTime = new Date('2026-08-16T12:00:01Z');
  const endTime = new Date('2026-08-16T12:00:02Z');
  const child: Process = {
    id: childId,
    parentTaskId: spawnId,
    filePath: `/tmp/${childId}.jsonl`,
    startTime,
    endTime,
    durationMs: 1000,
    metrics: {
      durationMs: 1000,
      totalTokens: 2,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      messageCount: 1,
    },
    isParallel: true,
    messages: [
      {
        uuid: `${childId}-message`,
        parentUuid: null,
        type: 'assistant',
        timestamp: startTime,
        content: [{ type: 'text', text: 'Child output' }],
        isSidechain: true,
        isMeta: false,
        toolCalls: [],
        toolResults: [],
      },
    ],
  };
  const item = makeAIItem(id);
  if (item.type !== 'ai') throw new Error('Expected AI item');
  item.group.processes = [child];
  item.group.steps = [
    {
      id: childId,
      type: 'subagent',
      startTime,
      endTime,
      durationMs: 1000,
      content: { subagentId: childId, subagentDescription: 'Child card' },
      context: 'subagent',
      agentId: childId,
      isParallel: true,
    },
  ];
  item.group.summary.subagentCount = 1;
  return { item, process: child };
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

function makeSwimlaneModel(id = 'default'): SwimlaneModel {
  const startTime = new Date('2026-08-16T12:00:00Z');
  const endTime = new Date('2026-08-16T12:00:01Z');
  return {
    startTime,
    endTime,
    durationMs: 1000,
    evidence: [],
    parentSegments: [
      {
        id: `${id}-work`,
        type: 'assistant-output',
        startTime,
        endTime,
        durationMs: 1000,
        metrics: {
          durationMs: 1000,
          totalTokens: 10,
          inputTokens: 4,
          outputTokens: 1,
          cacheReadTokens: 3,
          cacheCreationTokens: 2,
          messageCount: 1,
        },
      },
    ],
    hitlMarks: [],
    childRows: [],
  };
}

function makeChildTargetSwimlane(groupId: string, child: Process): SwimlaneModel {
  const model = makeSwimlaneModel('child-target');
  model.parentSegments[0].target = { kind: 'turn', groupId };
  model.hitlMarks = [
    {
      id: 'resume-boundary',
      type: 'resume',
      timestamp: model.endTime,
      source: 'linked-resume',
    },
  ];
  model.childRows = [
    {
      id: child.id,
      label: 'Parallel child',
      parentRowId: null,
      depth: 0,
      activations: [
        {
          id: child.id,
          processId: child.id,
          startTime: model.startTime,
          endTime: model.endTime,
          durationMs: 1000,
          metrics: child.metrics,
          target: {
            kind: 'subagent',
            groupId,
            processId: child.id,
            spawnId: child.parentTaskId ?? '',
          },
        },
      ],
    },
  ];
  return model;
}

function makeSessionDetail(swimlane: SwimlaneModel): SessionDetail {
  return { swimlane } as SessionDetail;
}

function setTabs(
  conversations: Record<string, SessionConversation>,
  contextStats: Record<string, Map<string, ContextStats> | null> = {},
  swimlanes: Record<string, SwimlaneModel> = {}
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
          sessionDetail: makeSessionDetail(swimlanes[tabId] ?? makeSwimlaneModel(tabId)),
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

  it('hands the selected tab projection to the surface only while the toggle is on', async () => {
    const conversation = makeConversation([makeUserItem('user-1')]);
    setTabs(
      { 'tab-1': conversation, 'tab-2': conversation },
      {},
      {
        'tab-1': makeSwimlaneModel('first-tab'),
        'tab-2': makeSwimlaneModel('selected-tab'),
      }
    );
    const host = await renderTab('tab-2');
    const turnList = host.querySelector<HTMLElement>('[data-testid="turn-list-surface"]');

    expect(
      host.querySelector('[data-testid="swimlane-parent-segment-selected-tab-work"]')
    ).toBeNull();
    await click(button(host, 'Swimlane'));

    expect(
      host.querySelector('[data-testid="swimlane-parent-segment-selected-tab-work"]')
    ).not.toBeNull();
    expect(host.querySelector('[data-testid="swimlane-parent-segment-first-tab-work"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="swimlane-parent-segment-selected-tab-work-duration"]')
        ?.textContent
    ).toBe('1.0s');
    expect(
      host
        .querySelector('[data-testid="swimlane-parent-segment-selected-tab-work"]')
        ?.getAttribute('aria-label')
    ).toBe('Parent assistant output');
    expect(turnList?.getAttribute('inert')).toBe('');

    await click(button(host, 'Swimlane'));
    expect(host.querySelector('[data-testid="swimlane-surface"]')).toBeNull();
    expect(turnList?.hasAttribute('inert')).toBe(false);
  });

  it('keeps the turn list visible and accessible when visibility is requested without a projection', async () => {
    setTabs({ 'tab-1': makeConversation([makeUserItem('user-1')]) });
    useStore.setState((state) => ({
      sessionDetail: null,
      tabSessionData: {
        ...state.tabSessionData,
        'tab-1': { ...state.tabSessionData['tab-1'], sessionDetail: null },
      },
    }));
    const host = await renderTab('tab-1');
    const turnList = host.querySelector<HTMLElement>('[data-testid="turn-list-surface"]');
    if (!turnList) throw new Error('Missing turn list');

    await click(button(host, 'Swimlane'));

    expect(button(host, 'Swimlane').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-testid="swimlane-surface"]')).toBeNull();
    expect(turnList.style.visibility).toBe('visible');
    expect(turnList.style.pointerEvents).toBe('auto');
    expect(turnList.hasAttribute('inert')).toBe(false);
    expect(turnList.hasAttribute('aria-hidden')).toBe(false);
  });

  it('does not borrow a global projection when the existing tab record has null detail', async () => {
    setTabs({ 'tab-1': makeConversation([makeUserItem('user-1')]) });
    useStore.setState((state) => ({
      sessionDetail: makeSessionDetail(makeSwimlaneModel('global-other-tab')),
      tabSessionData: {
        ...state.tabSessionData,
        'tab-1': { ...state.tabSessionData['tab-1'], sessionDetail: null },
      },
    }));
    const host = await renderTab('tab-1');
    const turnList = host.querySelector<HTMLElement>('[data-testid="turn-list-surface"]');

    await click(button(host, 'Swimlane'));

    expect(host.querySelector('[data-testid="swimlane-surface"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="swimlane-parent-segment-global-other-tab-work"]')
    ).toBeNull();
    expect(turnList?.style.visibility).toBe('visible');
    expect(turnList?.hasAttribute('inert')).toBe(false);
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

  it('navigates independent parallel child cards across a checkpoint/resume shape', async () => {
    const { item, process: firstChild } = makeAIItemWithChild(
      'ai-child-owner',
      'parallel-child-one',
      'spawn-parallel-child-one'
    );
    const { item: secondItem, process: secondChild } = makeAIItemWithChild(
      'unused-owner',
      'parallel-child-two',
      'spawn-parallel-child-two'
    );
    if (item.type !== 'ai' || secondItem.type !== 'ai') throw new Error('Expected AI items');
    item.group.processes.push(secondChild);
    item.group.steps.push(...secondItem.group.steps);
    item.group.summary.subagentCount = 2;

    const swimlane = makeChildTargetSwimlane('ai-child-owner', firstChild);
    const secondRow = makeChildTargetSwimlane('ai-child-owner', secondChild).childRows[0];
    swimlane.childRows.push(secondRow);
    const checkpointTime = new Date(swimlane.startTime.getTime() + 300);
    const resumeTime = new Date(swimlane.startTime.getTime() + 700);
    const parentWork = swimlane.parentSegments[0];
    swimlane.parentSegments = [
      {
        ...parentWork,
        id: 'work-before-checkpoint',
        endTime: checkpointTime,
        durationMs: 300,
      },
      {
        id: 'checkpoint-gap',
        type: 'human-wait',
        startTime: checkpointTime,
        endTime: resumeTime,
        durationMs: 400,
      },
      {
        ...parentWork,
        id: 'work-after-resume',
        startTime: resumeTime,
        durationMs: 300,
      },
    ];
    swimlane.hitlMarks = [
      {
        id: 'checkpoint-start',
        type: 'resume-start',
        timestamp: checkpointTime,
        source: 'linked-resume',
      },
      {
        id: 'checkpoint-resume',
        type: 'resume',
        timestamp: resumeTime,
        source: 'linked-resume',
      },
    ];
    setTabs(
      { 'tab-1': makeConversation([makeUserItem('user-1'), item]) },
      {},
      { 'tab-1': swimlane }
    );
    const host = await renderTab('tab-1');

    await click(button(host, 'Swimlane'));
    expect(
      host.querySelector('[data-testid="swimlane-parent-segment-checkpoint-gap"]')
    ).not.toBeNull();
    expect(host.querySelector('[data-testid="swimlane-mark-checkpoint-start"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="swimlane-mark-checkpoint-resume"]')).not.toBeNull();
    const firstActivation = host.querySelector<HTMLElement>(
      '[data-testid="swimlane-activation-parallel-child-one"]'
    );
    if (!firstActivation) throw new Error('Missing first targeted child activation');
    expect(firstActivation.tagName).toBe('BUTTON');
    await click(firstActivation);

    expect(host.querySelector('[data-testid="swimlane-surface"]')).toBeNull();
    await flushAnimationFrames(8);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await flushAnimationFrames(8);

    const firstCardId = getSubagentDisplayItemId(firstChild.id, firstChild.parentTaskId!);
    const firstCard = host.querySelector<HTMLElement>(`[data-subagent-card-id="${firstCardId}"]`);
    expect(firstCard).not.toBeNull();
    expect(firstCard?.className).toContain('ring-blue-500/30');
    expect(useStore.getState().isAIGroupExpandedForTab('tab-1', 'ai-child-owner')).toBe(true);
    expect(
      useStore
        .getState()
        .getExpandedDisplayItemIdsForTab('tab-1', 'ai-child-owner')
        .has(firstCardId)
    ).toBe(true);
    expect(useStore.getState().isSubagentTraceExpandedForTab('tab-1', firstChild.id)).toBe(true);
    expect(scrollToSpy).toHaveBeenCalled();
    expect(
      useStore.getState().openTabs.find((tab) => tab.id === 'tab-1')?.pendingNavigation
    ).toBeUndefined();

    scrollToSpy.mockClear();
    await click(button(host, 'Swimlane'));
    const secondActivation = host.querySelector<HTMLElement>(
      '[data-testid="swimlane-activation-parallel-child-two"]'
    );
    if (!secondActivation) throw new Error('Missing second targeted child activation');
    await click(secondActivation);
    await flushAnimationFrames(8);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await flushAnimationFrames(8);

    const secondCardId = getSubagentDisplayItemId(secondChild.id, secondChild.parentTaskId!);
    const secondCard = host.querySelector<HTMLElement>(`[data-subagent-card-id="${secondCardId}"]`);
    expect(secondCard).not.toBeNull();
    expect(secondCard?.className).toContain('ring-blue-500/30');
    expect(
      useStore
        .getState()
        .getExpandedDisplayItemIdsForTab('tab-1', 'ai-child-owner')
        .has(secondCardId)
    ).toBe(true);
    expect(useStore.getState().isSubagentTraceExpandedForTab('tab-1', secondChild.id)).toBe(true);
    expect(scrollToSpy).toHaveBeenCalled();
  });

  it('mounts and scrolls to an exact off-screen child card through the real virtualizer', async () => {
    const rowHeight = 260;
    const viewportHeight = 500;
    const targetIndex = 20;
    const { item: targetItem, process: child } = makeAIItemWithChild(
      'ai-virtualized-owner',
      'virtualized-child',
      'spawn-virtualized-child'
    );
    const items = [
      ...Array.from({ length: targetIndex }, (_, index) => makeUserItem(`before-${index}`)),
      targetItem,
      ...Array.from({ length: 80 }, (_, index) => makeUserItem(`after-${index}`)),
    ];
    const totalHeight = items.length * rowHeight;
    const swimlane = makeChildTargetSwimlane('ai-virtualized-owner', child);

    class MeasuredResizeObserver implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      disconnect(): void {
        // No-op test observer.
      }
      observe(element: Element): void {
        if (!(element instanceof HTMLElement) || element.dataset.testid !== 'turn-list-surface') {
          return;
        }
        queueMicrotask(() => {
          this.callback(
            [
              {
                target: element,
                borderBoxSize: [
                  { inlineSize: 1000, blockSize: viewportHeight } as ResizeObserverSize,
                ],
                contentBoxSize: [],
                contentRect: new DOMRect(0, 0, 1000, viewportHeight),
                devicePixelContentBoxSize: [],
              },
            ],
            this
          );
        });
      }
      unobserve(): void {
        // No-op test observer.
      }
    }

    vi.stubGlobal('ResizeObserver', MeasuredResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () {
      return this.dataset.testid === 'turn-list-surface' ? 1000 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
      return this.dataset.testid === 'turn-list-surface' ? viewportHeight : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () {
      return this.dataset.testid === 'turn-list-surface' ? viewportHeight : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      return this.dataset.testid === 'turn-list-surface' ? totalHeight : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.dataset.testid === 'turn-list-surface') {
        return new DOMRect(0, 0, 1000, viewportHeight);
      }
      const container = this.closest<HTMLElement>('[data-testid="turn-list-surface"]');
      const row = this.hasAttribute('data-index')
        ? this
        : this.closest<HTMLElement>('[data-index]');
      const index = Number(row?.dataset.index ?? 0);
      const rowTop = index * rowHeight - (container?.scrollTop ?? 0);
      const height = this.hasAttribute('data-index')
        ? rowHeight
        : this.hasAttribute('data-subagent-card-id')
          ? 120
          : 40;
      return new DOMRect(0, rowTop, 1000, height);
    });

    const scrollPositions: number[] = [];
    scrollToSpy.mockImplementation(function (this: HTMLElement, options?: ScrollToOptions) {
      const top = options?.top;
      if (typeof top !== 'number') return;
      this.scrollTop = top;
      scrollPositions.push(top);
      this.dispatchEvent(new Event('scroll'));
    });

    setTabs({ 'tab-1': makeConversation(items) }, {}, { 'tab-1': swimlane });
    const host = await renderTab('tab-1');
    const turnList = host.querySelector<HTMLElement>('[data-testid="turn-list-surface"]');
    if (!turnList) throw new Error('Missing virtualized turn list');

    turnList.scrollTop = totalHeight - viewportHeight;
    turnList.dispatchEvent(new Event('scroll'));
    await flushAnimationFrames(8);

    const cardId = getSubagentDisplayItemId(child.id, child.parentTaskId!);
    expect(host.querySelector(`[data-subagent-card-id="${cardId}"]`)).toBeNull();
    expect(
      Array.from(host.querySelectorAll<HTMLElement>('[data-index]')).some(
        (row) => row.dataset.index === String(targetIndex)
      )
    ).toBe(false);

    scrollPositions.length = 0;
    await click(button(host, 'Swimlane'));
    const activation = host.querySelector<HTMLElement>(
      '[data-testid="swimlane-activation-virtualized-child"]'
    );
    if (!activation) throw new Error('Missing virtualized child activation');
    await click(activation);
    await flushAnimationFrames(10);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await flushAnimationFrames(10);

    expect(host.querySelector(`[data-subagent-card-id="${cardId}"]`)).not.toBeNull();
    expect(
      Array.from(host.querySelectorAll<HTMLElement>('[data-index]')).some(
        (row) => row.dataset.index === String(targetIndex)
      )
    ).toBe(true);
    const expectedCenteredCardTop = targetIndex * rowHeight - (viewportHeight - 60) / 2;
    expect(scrollPositions.at(-1)).toBe(expectedCenteredCardTop);
    expect(turnList.scrollTop).toBe(expectedCenteredCardTop);
    expect(useStore.getState().isAIGroupExpandedForTab('tab-1', 'ai-virtualized-owner')).toBe(true);
    expect(
      useStore
        .getState()
        .getExpandedDisplayItemIdsForTab('tab-1', 'ai-virtualized-owner')
        .has(cardId)
    ).toBe(true);
    expect(useStore.getState().isSubagentTraceExpandedForTab('tab-1', child.id)).toBe(true);
    expect(
      useStore.getState().openTabs.find((tab) => tab.id === 'tab-1')?.pendingNavigation
    ).toBeUndefined();
  });

  it('navigates and highlights a shutdown-only timing-linked team child card', async () => {
    const { item, process: child } = makeAIItemWithChild(
      'ai-shutdown-owner',
      'shutdown-team-child'
    );
    child.team = {
      teamName: 'verification-team',
      memberName: 'shutdown-worker',
      memberColor: 'blue',
    };
    child.messages = [
      {
        uuid: 'shutdown-response-message',
        parentUuid: null,
        type: 'assistant',
        timestamp: child.startTime,
        content: [
          {
            type: 'tool_use',
            id: 'shutdown-response-call',
            name: 'SendMessage',
            input: { type: 'shutdown_response' },
          },
        ],
        isSidechain: true,
        isMeta: false,
        toolCalls: [
          {
            id: 'shutdown-response-call',
            name: 'SendMessage',
            input: { type: 'shutdown_response' },
            isTask: false,
          },
        ],
        toolResults: [],
      },
    ];
    const swimlane = makeChildTargetSwimlane('ai-shutdown-owner', child);
    setTabs(
      { 'tab-1': makeConversation([makeUserItem('user-1'), item]) },
      {},
      { 'tab-1': swimlane }
    );
    const host = await renderTab('tab-1');

    await click(button(host, 'Swimlane'));
    const activation = host.querySelector<HTMLElement>(
      '[data-testid="swimlane-activation-shutdown-team-child"]'
    );
    if (!activation) throw new Error('Missing shutdown child activation');
    await click(activation);
    await flushAnimationFrames(8);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await flushAnimationFrames(8);

    const cardId = getSubagentDisplayItemId(child.id);
    const card = host.querySelector<HTMLElement>(`[data-subagent-card-id="${cardId}"]`);
    expect(card?.textContent).toContain('Shutdown confirmed');
    expect(card?.className).toContain('ring-blue-500/30');
    expect(scrollToSpy).toHaveBeenCalled();
    expect(
      useStore.getState().getExpandedDisplayItemIdsForTab('tab-1', 'ai-shutdown-owner').has(cardId)
    ).toBe(true);
    expect(
      useStore.getState().openTabs.find((tab) => tab.id === 'tab-1')?.pendingNavigation
    ).toBeUndefined();
  });

  it('opens a targeted parent in a no-child session without changing its expansion state', async () => {
    const aiItem = makeAIItem('ai-parent-target');
    const swimlane = makeSwimlaneModel('parent-only');
    swimlane.parentSegments[0].target = { kind: 'turn', groupId: 'ai-parent-target' };
    setTabs(
      { 'tab-1': makeConversation([makeUserItem('user-1'), aiItem]) },
      {},
      { 'tab-1': swimlane }
    );
    const host = await renderTab('tab-1');
    expect(useStore.getState().isAIGroupExpandedForTab('tab-1', 'ai-parent-target')).toBe(false);

    await click(button(host, 'Swimlane'));
    const work = host.querySelector<HTMLElement>(
      '[data-testid="swimlane-parent-segment-parent-only-work"]'
    );
    if (!work) throw new Error('Missing targeted parent work');
    await click(work);
    await flushAnimationFrames(8);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await flushAnimationFrames(8);

    expect(host.querySelector('[data-testid="swimlane-surface"]')).toBeNull();
    expect(useStore.getState().isAIGroupExpandedForTab('tab-1', 'ai-parent-target')).toBe(false);
    expect(scrollToSpy).toHaveBeenCalled();
    expect(
      host.querySelector<HTMLElement>('[data-chat-group-id="ai-parent-target"]')?.className
    ).toContain('ring-blue-500/30');
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
