/**
 * Pure parser for MEMORY.md — the index file that lives in
 * ~/.claude/projects/<encoded>/memory/MEMORY.md
 *
 * Format (loose):
 *   # Memory index
 *
 *   - [Title](file.md) — short hook describing the layer
 *   - [Another](other.md) - alt-dash also accepted
 *
 * Lines that don't match are kept in `rawMarkdown` so callers can still
 * render any preamble or section headers verbatim.
 */

export interface MemoryEntry {
  title: string;
  file: string;
  hook: string;
  lineNumber: number;
}

export interface MemoryIndex {
  rawMarkdown: string;
  entries: MemoryEntry[];
  orphanFiles: string[];
}

function parseEntryLine(line: string): { title: string; file: string; hook: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('-')) return null;

  const link = trimmed.slice(1).trimStart();
  if (!link.startsWith('[')) return null;
  const titleEnd = link.indexOf('](');
  if (titleEnd <= 1) return null;
  const fileEnd = link.indexOf(')', titleEnd + 2);
  if (fileEnd === -1) return null;

  const title = link.slice(1, titleEnd);
  const file = link.slice(titleEnd + 2, fileEnd);
  if (!file.endsWith('.md') || file.includes('\n')) return null;

  const suffix = link.slice(fileEnd + 1).trim();
  if (!suffix) return { title, file, hook: '' };
  if (!['—', '–', '-'].includes(suffix[0])) return null;
  return { title, file, hook: suffix.slice(1).trimStart() };
}

export function parseMemoryIndex(markdown: string, dirListing: readonly string[]): MemoryIndex {
  const entries: MemoryEntry[] = [];
  const seenFiles = new Set<string>();
  const lines = markdown.split(/\r?\n/);

  lines.forEach((line, idx) => {
    const entry = parseEntryLine(line);
    if (!entry) return;
    const { title, file, hook } = entry;
    entries.push({
      title: title.trim(),
      file: file.trim(),
      hook: hook.trim(),
      lineNumber: idx + 1,
    });
    seenFiles.add(file.trim());
  });

  const orphanFiles = dirListing
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .filter((name) => name !== 'MEMORY.md' && !seenFiles.has(name))
    .sort((a, b) => a.localeCompare(b));

  return { rawMarkdown: markdown, entries, orphanFiles };
}
