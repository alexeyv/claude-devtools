import { describe, expect, it, vi } from 'vitest';

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { DataCache } from '../../../../src/main/services/infrastructure/DataCache';

import type { SessionDetail } from '../../../../src/main/types';

interface InspectableCacheEntry {
  timestamp: number;
  value: SessionDetail;
  version: number;
}

function entries(cache: DataCache): Map<string, InspectableCacheEntry> {
  return (cache as unknown as { cache: Map<string, InspectableCacheEntry> }).cache;
}

describe('DataCache session detail schema version', () => {
  it('invalidates version 2 session details and stamps new entries with version 3', () => {
    const cache = new DataCache();
    const key = DataCache.buildKey('project', 'session');
    const staleDetail = {} as SessionDetail;
    entries(cache).set(key, {
      value: staleDetail,
      timestamp: Date.now(),
      version: 2,
    });

    expect(cache.get(key)).toBeUndefined();
    expect(cache.size()).toBe(0);

    const currentDetail = { swimlane: { schemaVersion: 1 } } as unknown as SessionDetail;
    cache.set(key, currentDetail);

    expect(entries(cache).get(key)?.version).toBe(3);
    expect(cache.get(key)).toBe(currentDetail);
  });
});
