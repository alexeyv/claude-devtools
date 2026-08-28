/**
 * Tests for CodexProjectIndex.
 *
 * Codex stores rollouts date-sharded with no project directories, so the index
 * has to recover project identity from each file's `cwd` and rebuild the
 * parent/child thread tree that Codex spreads across separate files.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { CodexProjectIndex } from '../../../../src/main/services/discovery/CodexProjectIndex';

let sessionsDir: string;

beforeEach(async () => {
  sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-index-'));
});

afterEach(async () => {
  await fs.rm(sessionsDir, { recursive: true, force: true });
});

/** Write a rollout under the date-sharded layout Codex uses. */
async function writeRollout(
  date: string,
  threadId: string,
  meta: Record<string, unknown> | null,
  extraLines: string[] = []
): Promise<string> {
  const [year, month, day] = date.split('-');
  const dir = path.join(sessionsDir, year, month, day);
  await fs.mkdir(dir, { recursive: true });

  const filePath = path.join(dir, `rollout-${date}T10-00-00-${threadId}.jsonl`);
  const lines = meta
    ? [JSON.stringify({ timestamp: `${date}T10:00:00.000Z`, type: 'session_meta', payload: meta })]
    : [];

  await fs.writeFile(filePath, [...lines, ...extraLines].join('\n'), 'utf8');
  return filePath;
}

function meta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'thread-a',
    session_id: 'thread-a',
    timestamp: '2026-08-19T10:00:00.000Z',
    cwd: '/Users/alex/src/demo',
    cli_version: '0.147.0',
    ...overrides,
  };
}

describe('CodexProjectIndex - scanning', () => {
  it('walks the date-sharded tree and finds every rollout', async () => {
    await writeRollout('2026-08-19', 'thread-a', meta());
    await writeRollout('2026-08-20', 'thread-b', meta({ id: 'thread-b' }));

    const built = await new CodexProjectIndex(sessionsDir).build();

    expect(built.stats.filesScanned).toBe(2);
    expect(built.byThreadId.size).toBe(2);
  });

  it('returns an empty index when the sessions directory is absent', async () => {
    const built = await new CodexProjectIndex(path.join(sessionsDir, 'nope')).build();

    expect(built.projects).toHaveLength(0);
    expect(built.stats.filesScanned).toBe(0);

    // The missing-directory warning is expected here; clear it so the shared
    // setup's "no unexpected console.warn" assertion still guards other cases.
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      expect.stringContaining('CodexProjectIndex'),
      expect.stringContaining('Codex sessions directory does not exist')
    );
    vi.mocked(console.warn).mockClear();
  });

  it('falls back to the filename thread id for rollouts without session_meta', async () => {
    const threadId = '7d6a0901-5512-40cf-a43d-9981a1747d3b';
    await writeRollout('2025-09-09', threadId, null, [
      JSON.stringify({ type: 'message', role: 'user', content: [] }),
    ]);

    const built = await new CodexProjectIndex(sessionsDir).build();

    expect(built.byThreadId.has(threadId)).toBe(true);
    expect(built.stats.missingCwd).toBe(1);
  });
});

describe('CodexProjectIndex - project grouping', () => {
  it('groups rollouts by cwd rather than by directory', async () => {
    await writeRollout('2026-08-19', 'thread-a', meta());
    await writeRollout('2026-08-20', 'thread-b', meta({ id: 'thread-b' }));
    await writeRollout(
      '2026-08-20',
      'thread-c',
      meta({ id: 'thread-c', cwd: '/Users/alex/src/other' })
    );

    const built = await new CodexProjectIndex(sessionsDir).build();

    expect(built.projects).toHaveLength(2);
    const demo = built.projects.find((p) => p.path === '/Users/alex/src/demo');
    expect(demo?.name).toBe('demo');
    expect(demo?.rootThreads).toHaveLength(2);
  });

  it('orders projects by most recent activity', async () => {
    const older = await writeRollout(
      '2026-08-01',
      'thread-old',
      meta({ id: 'thread-old', cwd: '/a/old' })
    );
    const newer = await writeRollout(
      '2026-08-19',
      'thread-new',
      meta({ id: 'thread-new', cwd: '/a/new' })
    );
    await fs.utimes(older, new Date(1_000_000), new Date(1_000_000));
    await fs.utimes(newer, new Date(2_000_000), new Date(2_000_000));

    const built = await new CodexProjectIndex(sessionsDir).build();

    expect(built.projects[0].path).toBe('/a/new');
  });
});

describe('CodexProjectIndex - thread tree', () => {
  const subagentMeta = (id: string, parent: string, cwd?: string): Record<string, unknown> =>
    meta({
      id,
      cwd,
      parent_thread_id: parent,
      thread_source: 'subagent',
      source: {
        subagent: {
          thread_spawn: { parent_thread_id: parent, depth: 1, agent_nickname: 'Mendel' },
        },
      },
    });

  it('links spawned subagents to their parent thread', async () => {
    await writeRollout('2026-08-19', 'thread-a', meta());
    await writeRollout(
      '2026-08-19',
      'child-1',
      subagentMeta('child-1', 'thread-a', '/Users/alex/src/demo')
    );

    const built = await new CodexProjectIndex(sessionsDir).build();

    expect(built.childrenByParent.get('thread-a')).toHaveLength(1);
    expect(built.stats.subagentThreads).toBe(1);
    expect(built.stats.orphanedSubagents).toBe(0);
    expect(built.byThreadId.get('child-1')?.agentNickname).toBe('Mendel');
  });

  it('keeps subagents out of the project root-thread list', async () => {
    await writeRollout('2026-08-19', 'thread-a', meta());
    await writeRollout(
      '2026-08-19',
      'child-1',
      subagentMeta('child-1', 'thread-a', '/Users/alex/src/demo')
    );

    const built = await new CodexProjectIndex(sessionsDir).build();
    const project = built.projects[0];

    expect(project.rootThreads).toHaveLength(1);
    expect(project.allThreads).toHaveLength(2);
  });

  it('inherits a missing cwd from the spawning ancestor', async () => {
    await writeRollout('2026-08-19', 'thread-a', meta());
    await writeRollout('2026-08-19', 'child-1', subagentMeta('child-1', 'thread-a'));
    await writeRollout('2026-08-19', 'grandchild', subagentMeta('grandchild', 'child-1'));

    const built = await new CodexProjectIndex(sessionsDir).build();

    expect(built.byThreadId.get('grandchild')?.cwd).toBe('/Users/alex/src/demo');
    expect(built.projects).toHaveLength(1);
    expect(built.projects[0].allThreads).toHaveLength(3);
  });

  it('counts subagents whose parent rollout is missing', async () => {
    await writeRollout(
      '2026-08-19',
      'child-1',
      subagentMeta('child-1', 'vanished', '/Users/alex/src/demo')
    );

    const built = await new CodexProjectIndex(sessionsDir).build();

    expect(built.stats.orphanedSubagents).toBe(1);
  });

  it('collects descendants depth-first across generations', async () => {
    await writeRollout('2026-08-19', 'thread-a', meta());
    await writeRollout('2026-08-19', 'child-1', subagentMeta('child-1', 'thread-a', '/d'));
    await writeRollout('2026-08-19', 'child-2', subagentMeta('child-2', 'thread-a', '/d'));
    await writeRollout('2026-08-19', 'grandchild', subagentMeta('grandchild', 'child-1', '/d'));

    const index = new CodexProjectIndex(sessionsDir);
    const built = await index.build();

    expect(index.collectDescendants(built, 'thread-a')).toHaveLength(3);
    expect(index.collectDescendants(built, 'child-1')).toHaveLength(1);
    expect(index.collectDescendants(built, 'grandchild')).toHaveLength(0);
  });
});

describe('CodexProjectIndex - caching', () => {
  it('reuses cached heads for unchanged files on rescan', async () => {
    await writeRollout('2026-08-19', 'thread-a', meta());
    const index = new CodexProjectIndex(sessionsDir);

    const first = await index.build();
    expect(first.stats.headsRead).toBe(1);
    expect(first.stats.cacheHits).toBe(0);

    const second = await index.build();
    expect(second.stats.headsRead).toBe(0);
    expect(second.stats.cacheHits).toBe(1);
  });

  it('does not let an inherited cwd stick to the cached child on rebuild', async () => {
    const parentPath = await writeRollout('2026-08-19', 'thread-a', meta());
    await writeRollout(
      '2026-08-19',
      'child-1',
      meta({ id: 'child-1', cwd: undefined, parent_thread_id: 'thread-a', thread_source: 'subagent' })
    );
    const index = new CodexProjectIndex(sessionsDir);

    const first = await index.build();
    expect(first.projects.map((project) => project.path)).toEqual(['/Users/alex/src/demo']);

    // Parent moves project; the child head is unchanged and served from cache.
    await fs.writeFile(
      parentPath,
      JSON.stringify({
        timestamp: '2026-08-19T10:00:00.000Z',
        type: 'session_meta',
        payload: meta({ cwd: '/Users/alex/src/other' }),
      }),
      'utf8'
    );
    const second = await index.build();

    expect(second.stats.cacheHits).toBe(1);
    expect(second.projects.map((project) => project.path)).toEqual(['/Users/alex/src/other']);
  });

  it('re-reads a rollout after it changes', async () => {
    const filePath = await writeRollout('2026-08-19', 'thread-a', meta());
    const index = new CodexProjectIndex(sessionsDir);
    await index.build();

    await fs.appendFile(filePath, `\n${JSON.stringify({ type: 'event_msg', payload: {} })}`);
    const second = await index.build();

    expect(second.stats.headsRead).toBe(1);
  });
});
