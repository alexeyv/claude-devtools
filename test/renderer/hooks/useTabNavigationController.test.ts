import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTabNavigationController } from '../../../src/renderer/hooks/useTabNavigationController';
import { getSubagentDisplayItemId } from '../../../src/renderer/types/tabs';

import type { Process, SessionMetrics } from '../../../src/main/types';
import type { SessionConversation } from '../../../src/renderer/types/groups';
import type { TabNavigationRequest } from '../../../src/renderer/types/tabs';

class ImmediateResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  disconnect(): void {}
  observe(target: Element): void {
    const entry = { contentRect: target.getBoundingClientRect() } as ResizeObserverEntry;
    this.callback([entry], this);
    this.callback([entry], this);
    this.callback([entry], this);
  }
  unobserve(): void {}
}

const metrics: SessionMetrics = {
  durationMs: 1000,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  messageCount: 0,
};

function childProcess(): Process {
  return {
    id: 'child-process',
    parentTaskId: 'spawn-child',
    filePath: '/tmp/child.jsonl',
    messages: [],
    startTime: new Date(1),
    endTime: new Date(2),
    durationMs: 1,
    metrics,
    isParallel: false,
  };
}

function conversation(processes: Process[] = []): SessionConversation {
  return {
    sessionId: 'session',
    totalUserGroups: 0,
    totalSystemGroups: 0,
    totalAIGroups: 1,
    totalCompactGroups: 0,
    items: [
      {
        type: 'ai',
        group: {
          id: 'ai-group',
          processes,
          startTime: new Date(0),
          endTime: new Date(3),
        } as never,
      },
    ],
  };
}

interface HarnessProps {
  request: TabNavigationRequest;
  conversation: SessionConversation;
  aiGroupRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  subagentCardRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  actions: {
    consume: ReturnType<typeof vi.fn>;
    ensure: ReturnType<typeof vi.fn>;
    expandGroup: ReturnType<typeof vi.fn>;
    expandItem: ReturnType<typeof vi.fn>;
    expandTrace: ReturnType<typeof vi.fn>;
  };
  container: HTMLDivElement;
}

function Harness({
  request,
  conversation: sessionConversation,
  aiGroupRefs,
  subagentCardRefs,
  actions,
  container,
}: HarnessProps): null {
  useTabNavigationController({
    isActiveTab: true,
    pendingNavigation: request,
    conversation: sessionConversation,
    conversationLoading: false,
    consumeTabNavigation: actions.consume,
    tabId: 'tab',
    aiGroupRefs,
    chatItemRefs: { current: new Map() },
    toolItemRefs: { current: new Map() },
    subagentCardRefs,
    expandAIGroup: actions.expandGroup,
    expandDisplayItem: actions.expandItem,
    expandSubagentTrace: actions.expandTrace,
    scrollContainerRef: { current: container },
    ensureGroupVisible: actions.ensure,
    setSearchQuery: vi.fn(),
    selectSearchMatch: vi.fn(() => true),
    highlightDuration: 10,
  });
  return null;
}

const roots: Root[] = [];

async function mount(props: HarnessProps, waitMs = 700): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  document.body.appendChild(props.container);
  for (const element of [
    ...props.aiGroupRefs.current.values(),
    ...props.subagentCardRefs.current.values(),
  ]) {
    if (!element.isConnected) document.body.appendChild(element);
  }
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(Harness, props));
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  });
}

function setupActions() {
  const order: string[] = [];
  return {
    order,
    actions: {
      consume: vi.fn(() => order.push('consume')),
      ensure: vi.fn(async () => {
        order.push('ensure');
      }),
      expandGroup: vi.fn(() => order.push('group')),
      expandItem: vi.fn(() => order.push('item')),
      expandTrace: vi.fn(() => order.push('trace')),
    },
  };
}

describe('useTabNavigationController swimlane navigation', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('preserves parent expansion and ensures visibility before scrolling', async () => {
    const { actions, order } = setupActions();
    const group = document.createElement('div');
    document.body.appendChild(group);
    const aiGroupRefs = { current: new Map<string, HTMLElement>() };
    actions.ensure.mockImplementation(async () => {
      order.push('ensure');
      aiGroupRefs.current.set('ai-group', group);
    });
    const container = document.createElement('div');
    container.scrollTo = vi.fn(() => order.push('scroll'));

    await mount({
      request: {
        id: 'parent-request',
        kind: 'swimlane',
        source: 'swimlane',
        highlight: 'blue',
        payload: { kind: 'turn', groupId: 'ai-group' },
      },
      conversation: conversation(),
      aiGroupRefs,
      subagentCardRefs: { current: new Map() },
      actions,
      container,
    });

    expect(actions.expandGroup).not.toHaveBeenCalled();
    expect(aiGroupRefs.current.get('ai-group')).toBe(group);
    expect(order.indexOf('ensure')).toBeLessThan(order.indexOf('scroll'));
    expect(actions.consume).toHaveBeenCalledWith('tab', 'parent-request');
  });

  it('expands group, exact outer item, and trace before visibility and exact-card scroll', async () => {
    const { actions, order } = setupActions();
    const child = childProcess();
    const cardId = getSubagentDisplayItemId(child.id, child.parentTaskId!);
    const card = document.createElement('div');
    const container = document.createElement('div');
    container.scrollTo = vi.fn(() => order.push('scroll'));

    await mount({
      request: {
        id: 'child-request',
        kind: 'swimlane',
        source: 'swimlane',
        highlight: 'blue',
        payload: {
          kind: 'subagent',
          groupId: 'ai-group',
          processId: child.id,
          spawnId: child.parentTaskId!,
        },
      },
      conversation: conversation([child]),
      aiGroupRefs: { current: new Map() },
      subagentCardRefs: { current: new Map([[cardId, card]]) },
      actions,
      container,
    });

    expect(order.slice(0, 5)).toEqual(['group', 'item', 'trace', 'ensure', 'scroll']);
    expect(actions.expandItem).toHaveBeenCalledWith('ai-group', cardId);
    expect(actions.consume).toHaveBeenCalledWith('tab', 'child-request');
  });

  it('uses the same empty-spawn identity as a timing-linked rendered card', async () => {
    const { actions, order } = setupActions();
    const child = childProcess();
    delete child.parentTaskId;
    const cardId = getSubagentDisplayItemId(child.id);
    const card = document.createElement('div');
    const container = document.createElement('div');
    container.scrollTo = vi.fn(() => order.push('scroll'));

    await mount({
      request: {
        id: 'orphan-child-request',
        kind: 'swimlane',
        source: 'swimlane',
        highlight: 'blue',
        payload: {
          kind: 'subagent',
          groupId: 'ai-group',
          processId: child.id,
        },
      },
      conversation: conversation([child]),
      aiGroupRefs: { current: new Map() },
      subagentCardRefs: { current: new Map([[cardId, card]]) },
      actions,
      container,
    });

    expect(actions.expandItem).toHaveBeenCalledWith('ai-group', cardId);
    expect(container.scrollTo).toHaveBeenCalled();
    expect(actions.consume).toHaveBeenCalledWith('tab', 'orphan-child-request');
  });

  it('rejects a target card that detaches during stability without scrolling', async () => {
    class DetachingResizeObserver implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      disconnect(): void {}
      observe(target: Element): void {
        const entry = { contentRect: target.getBoundingClientRect() } as ResizeObserverEntry;
        this.callback([entry], this);
        this.callback([entry], this);
        this.callback([entry], this);
        target.remove();
      }
      unobserve(): void {}
    }
    vi.stubGlobal('ResizeObserver', DetachingResizeObserver);
    const { actions } = setupActions();
    const child = childProcess();
    const cardId = getSubagentDisplayItemId(child.id, child.parentTaskId!);
    const card = document.createElement('div');
    const container = document.createElement('div');
    container.scrollTo = vi.fn();

    await mount({
      request: {
        id: 'detached-card-request',
        kind: 'swimlane',
        source: 'swimlane',
        highlight: 'blue',
        payload: {
          kind: 'subagent',
          groupId: 'ai-group',
          processId: child.id,
          spawnId: child.parentTaskId!,
        },
      },
      conversation: conversation([child]),
      aiGroupRefs: { current: new Map() },
      subagentCardRefs: { current: new Map([[cardId, card]]) },
      actions,
      container,
    });

    expect(card.isConnected).toBe(false);
    expect(container.scrollTo).not.toHaveBeenCalled();
    expect(actions.consume).toHaveBeenCalledWith('tab', 'detached-card-request');
  });

  it('consumes but does not report success by scrolling when the exact card never mounts', async () => {
    const { actions } = setupActions();
    const child = childProcess();
    const container = document.createElement('div');
    container.scrollTo = vi.fn();

    await mount(
      {
        request: {
          id: 'missing-card-request',
          kind: 'swimlane',
          source: 'swimlane',
          highlight: 'blue',
          payload: {
            kind: 'subagent',
            groupId: 'ai-group',
            processId: child.id,
            spawnId: child.parentTaskId!,
          },
        },
        conversation: conversation([child]),
        aiGroupRefs: { current: new Map() },
        subagentCardRefs: { current: new Map() },
        actions,
        container,
      },
      1400
    );

    expect(container.scrollTo).not.toHaveBeenCalled();
    expect(actions.consume).toHaveBeenCalledWith('tab', 'missing-card-request');
  });
});
