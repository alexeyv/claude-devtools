/**
 * Tab type definitions for the tabbed layout feature.
 * Based on specs/001-tabbed-layout-dashboard/contracts/tab-state.ts
 */

import { generateUUID } from '@renderer/utils/stringUtils';

import type { Session } from './data';
import type { TriggerColor } from '@shared/constants/triggerColors';
import type { SwimlaneNavigationTarget } from '@shared/types';

// =============================================================================
// Navigation Request Types
// =============================================================================

/**
 * Payload for error-based navigation (from notifications or trigger preview).
 */
export interface ErrorNavigationPayload {
  /** Error ID for tracking */
  errorId: string;
  /** Error timestamp for finding the correct AI group */
  errorTimestamp: number;
  /** Tool use ID for precise tool item highlighting */
  toolUseId?: string;
  /** Subagent ID for subagent-aware group lookup */
  subagentId?: string;
  /** Line number (fallback) */
  lineNumber?: number;
}

/**
 * Payload for search-based navigation (from Command Palette).
 */
export interface SearchNavigationPayload {
  /** The search query */
  query: string;
  /** Timestamp of the message containing the search match */
  messageTimestamp: number;
  /** The matched text */
  matchedText: string;
  /** Optional exact target group ID (e.g., "user-..." or "ai-...") */
  targetGroupId?: string;
  /** Optional exact match index within the target group's searchable text */
  targetMatchIndexInItem?: number;
  /** Optional character offset of the match in the searchable text */
  targetMatchStartOffset?: number;
  /** Optional source message UUID for diagnostics/fallback mapping */
  targetMessageUuid?: string;
}

/**
 * Unified tab navigation request.
 * Each click/action creates a new request with a unique nonce (id).
 * The nonce ensures repeated clicks produce new navigations.
 */
interface TabNavigationRequestBase {
  /** Unique nonce per click/action (crypto.randomUUID) */
  id: string;
  /** Highlight color to use */
  highlight: TriggerColor | 'yellow' | 'none';
}

/** Navigation requests retain a strict payload/source contract for each kind. */
export type TabNavigationRequest =
  | (TabNavigationRequestBase & {
      kind: 'error';
      source: 'notification' | 'triggerPreview';
      payload: ErrorNavigationPayload;
    })
  | (TabNavigationRequestBase & {
      kind: 'search';
      source: 'commandPalette';
      payload: SearchNavigationPayload;
    })
  | (TabNavigationRequestBase & {
      kind: 'swimlane';
      source: 'swimlane';
      payload: SwimlaneNavigationTarget;
    })
  | (TabNavigationRequestBase & {
      kind: 'autoBottom';
      source: 'sessionOpen';
      payload: Record<string, never>;
    });

// =============================================================================
// Core Types
// =============================================================================

/**
 * Represents a single open tab in the main content area
 */
export interface Tab {
  /** Unique identifier (UUID v4) */
  id: string;

  /** Type of content displayed in this tab */
  type: 'session' | 'dashboard' | 'notifications' | 'settings' | 'memory';

  /** Session ID (required when type === 'session') */
  sessionId?: string;

  /** Project ID (required when type === 'session', or when type === 'memory') */
  projectId?: string;

  /** Display name for the tab (max 50 chars) */
  label: string;

  /** Unix timestamp when tab was opened */
  createdAt: number;

  /** Whether this tab was opened from CommandPalette search */
  fromSearch?: boolean;

  /** Pending navigation request (replaces legacy deep-link fields) */
  pendingNavigation?: TabNavigationRequest;

  /** ID of the last consumed navigation request (prevents re-processing) */
  lastConsumedNavigationId?: string;

  /** Saved scroll position for restoring when tab becomes active again */
  savedScrollTop?: number;

  /** Whether the Context panel is shown (per-tab UI state) */
  showContextPanel?: boolean;
}

/**
 * Options for opening a tab
 */
export interface OpenTabOptions {
  /** Force open in new tab even if session already exists (e.g., for Ctrl+click) */
  forceNewTab?: boolean;
  /** Replace the current active tab instead of creating a new one */
  replaceActiveTab?: boolean;
}

/**
 * Input type for creating a new tab (id and createdAt are auto-generated)
 */
export type TabInput = Omit<Tab, 'id' | 'createdAt'>;

/**
 * Categories for date-based session grouping
 */
export type DateCategory = 'Today' | 'Yesterday' | 'Previous 7 Days' | 'Older';

/**
 * Sessions grouped by relative date category
 */
export type DateGroupedSessions = Record<DateCategory, Session[]>;

// =============================================================================
// Constants
// =============================================================================

/** Maximum characters for tab label before truncation */
const TAB_LABEL_MAX_LENGTH = 50;

/** Date category order for rendering */
export const DATE_CATEGORY_ORDER: DateCategory[] = [
  'Today',
  'Yesterday',
  'Previous 7 Days',
  'Older',
];

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Find tab by session ID (for backwards compatibility)
 * NOTE: Prefer findTabBySessionAndProject when projectId is available
 */
export function findTabBySession(tabs: Tab[], sessionId: string): Tab | undefined {
  return tabs.find((t) => t.type === 'session' && t.sessionId === sessionId);
}

/**
 * Find tab by both session ID AND project ID
 * This prevents finding a tab with the same sessionId but different project
 * (e.g., same filename in different repositories)
 */
export function findTabBySessionAndProject(
  tabs: Tab[],
  sessionId: string,
  projectId: string
): Tab | undefined {
  return tabs.find(
    (t) => t.type === 'session' && t.sessionId === sessionId && t.projectId === projectId
  );
}

/**
 * Truncate label to max length with ellipsis
 */
export function truncateLabel(label: string): string {
  if (label.length <= TAB_LABEL_MAX_LENGTH) return label;
  return label.slice(0, TAB_LABEL_MAX_LENGTH - 1) + '…';
}

// =============================================================================
// Navigation Request Helpers
// =============================================================================

/**
 * Create an error navigation request (from notification click or trigger preview).
 */
export function createErrorNavigationRequest(
  payload: ErrorNavigationPayload,
  source: 'notification' | 'triggerPreview' = 'notification',
  highlightColor?: TriggerColor
): TabNavigationRequest {
  return {
    id: generateUUID(),
    kind: 'error',
    source,
    highlight: highlightColor ?? 'red',
    payload,
  };
}

/**
 * Create a search navigation request (from Command Palette).
 */
export function createSearchNavigationRequest(
  payload: SearchNavigationPayload
): TabNavigationRequest {
  return {
    id: generateUUID(),
    kind: 'search',
    source: 'commandPalette',
    highlight: 'yellow',
    payload,
  };
}

/** Create a navigation request for an exact target projected into the swimlane model. */
export function createSwimlaneNavigationRequest(
  payload: SwimlaneNavigationTarget
): TabNavigationRequest {
  return {
    id: generateUUID(),
    kind: 'swimlane',
    source: 'swimlane',
    highlight: 'blue',
    payload,
  };
}

/** Stable identity shared by the projected target, expansion state, and card ref. */
export function getSubagentDisplayItemId(processId: string, spawnId = ''): string {
  return `subagent-${processId.length}:${processId}-${spawnId.length}:${spawnId}`;
}

/**
 * Type guard for error navigation payload.
 */
export function isErrorPayload(
  request: TabNavigationRequest
): request is Extract<TabNavigationRequest, { kind: 'error' }> {
  return request.kind === 'error';
}

/**
 * Type guard for search navigation payload.
 */
export function isSearchPayload(
  request: TabNavigationRequest
): request is Extract<TabNavigationRequest, { kind: 'search' }> {
  return request.kind === 'search';
}

/** Type guard for exact swimlane targets. */
export function isSwimlanePayload(
  request: TabNavigationRequest
): request is Extract<TabNavigationRequest, { kind: 'swimlane' }> {
  return request.kind === 'swimlane';
}
