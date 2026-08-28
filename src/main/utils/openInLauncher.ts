/**
 * Cross-platform "Open in..." launcher.
 *
 * Powers the dropdown menu (Finder, Cursor, VS Code, Zed, Android Studio,
 * Xcode, Ghostty, iTerm, Terminal, Antigravity, Copy path) used by the
 * memory viewer. Detection is cached for the process lifetime.
 *
 * Targets fall into four categories:
 *   - reveal     → shell.showItemInFolder (Finder / Explorer / xdg-open)
 *   - editor     → opens the file path in a GUI editor
 *   - terminal   → opens a terminal in the parent directory
 *   - clipboard  → copies the absolute path
 */

import { createLogger } from '@shared/utils/logger';
import { execFile } from 'child_process';
import { clipboard, shell } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const logger = createLogger('OpenInLauncher');

export type OpenTargetId =
  | 'finder'
  | 'cursor'
  | 'vscode'
  | 'zed'
  | 'android-studio'
  | 'xcode'
  | 'ghostty'
  | 'iterm'
  | 'terminal'
  | 'antigravity'
  | 'copy-path';

export interface OpenTarget {
  id: OpenTargetId;
  label: string;
  iconName: string;
  shortcutKey?: string;
  available: boolean;
}

export type OpenInResult = { success: true } | { success: false; error: string };

interface TargetSpec {
  id: OpenTargetId;
  label: string;
  iconName: string;
  shortcutKey?: string;
  platforms: readonly NodeJS.Platform[];
  detect: () => Promise<boolean>;
  dispatch: (absolutePath: string, isDirectory: boolean) => Promise<void>;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    await execFileAsync(probe, [cmd], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

async function macAppExists(appName: string): Promise<boolean> {
  const candidates = [
    `/Applications/${appName}.app`,
    `${process.env.HOME ?? ''}/Applications/${appName}.app`,
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return true;
  }
  return false;
}

async function macOpenWithApp(appName: string, target: string): Promise<void> {
  await execFileAsync('open', ['-a', appName, target], { timeout: 5000 });
}

async function spawnEditor(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 5000 });
    const timer = setTimeout(() => resolve(), 400);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const TARGETS: TargetSpec[] = [
  {
    id: 'finder',
    label:
      process.platform === 'win32'
        ? 'Explorer'
        : process.platform === 'darwin'
          ? 'Finder'
          : 'Files',
    iconName: 'finder',
    shortcutKey: '1',
    platforms: ['darwin', 'win32', 'linux'],
    detect: async () => true,
    dispatch: async (absolutePath) => {
      shell.showItemInFolder(absolutePath);
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    iconName: 'cursor',
    shortcutKey: '2',
    platforms: ['darwin', 'win32', 'linux'],
    detect: async () =>
      (await commandExists('cursor')) || (process.platform === 'darwin' && macAppExists('Cursor')),
    dispatch: async (absolutePath) => {
      try {
        await spawnEditor('cursor', [absolutePath]);
      } catch {
        if (process.platform === 'darwin') await macOpenWithApp('Cursor', absolutePath);
        else throw new Error('Cursor not found');
      }
    },
  },
  {
    id: 'vscode',
    label: 'VS Code',
    iconName: 'vscode',
    shortcutKey: '3',
    platforms: ['darwin', 'win32', 'linux'],
    detect: async () =>
      (await commandExists('code')) ||
      (process.platform === 'darwin' && macAppExists('Visual Studio Code')),
    dispatch: async (absolutePath) => {
      try {
        await spawnEditor('code', [absolutePath]);
      } catch {
        if (process.platform === 'darwin') await macOpenWithApp('Visual Studio Code', absolutePath);
        else throw new Error('VS Code not found');
      }
    },
  },
  {
    id: 'zed',
    label: 'Zed',
    iconName: 'zed',
    shortcutKey: '4',
    platforms: ['darwin', 'win32', 'linux'],
    detect: async () =>
      (await commandExists('zed')) || (process.platform === 'darwin' && macAppExists('Zed')),
    dispatch: async (absolutePath) => {
      try {
        await spawnEditor('zed', [absolutePath]);
      } catch {
        if (process.platform === 'darwin') await macOpenWithApp('Zed', absolutePath);
        else throw new Error('Zed not found');
      }
    },
  },
  {
    id: 'android-studio',
    label: 'Android Studio',
    iconName: 'android-studio',
    shortcutKey: '5',
    platforms: ['darwin', 'win32', 'linux'],
    detect: async () =>
      (await commandExists('studio')) ||
      (process.platform === 'darwin' && macAppExists('Android Studio')),
    dispatch: async (absolutePath) => {
      try {
        await spawnEditor('studio', [absolutePath]);
      } catch {
        if (process.platform === 'darwin') await macOpenWithApp('Android Studio', absolutePath);
        else throw new Error('Android Studio not found');
      }
    },
  },
  {
    id: 'xcode',
    label: 'Xcode',
    iconName: 'xcode',
    shortcutKey: '6',
    platforms: ['darwin'],
    detect: async () => macAppExists('Xcode'),
    dispatch: async (absolutePath) => {
      await macOpenWithApp('Xcode', absolutePath);
    },
  },
  {
    id: 'ghostty',
    label: 'Ghostty',
    iconName: 'ghostty',
    shortcutKey: '7',
    platforms: ['darwin', 'linux'],
    detect: async () =>
      (await commandExists('ghostty')) ||
      (process.platform === 'darwin' && macAppExists('Ghostty')),
    dispatch: async (absolutePath, isDirectory) => {
      const dir = isDirectory ? absolutePath : path.dirname(absolutePath);
      if (process.platform === 'darwin') await macOpenWithApp('Ghostty', dir);
      else await spawnEditor('ghostty', ['--working-directory', dir]);
    },
  },
  {
    id: 'iterm',
    label: 'iTerm',
    iconName: 'iterm',
    shortcutKey: '8',
    platforms: ['darwin'],
    detect: async () => macAppExists('iTerm'),
    dispatch: async (absolutePath, isDirectory) => {
      const dir = isDirectory ? absolutePath : path.dirname(absolutePath);
      await macOpenWithApp('iTerm', dir);
    },
  },
  {
    id: 'terminal',
    label: 'Terminal',
    iconName: 'terminal',
    shortcutKey: '9',
    platforms: ['darwin', 'linux'],
    detect: async () => {
      if (process.platform === 'darwin') return macAppExists('Terminal');
      return (
        (await commandExists('gnome-terminal')) ||
        (await commandExists('konsole')) ||
        (await commandExists('xterm'))
      );
    },
    dispatch: async (absolutePath, isDirectory) => {
      const dir = isDirectory ? absolutePath : path.dirname(absolutePath);
      if (process.platform === 'darwin') {
        await macOpenWithApp('Terminal', dir);
        return;
      }
      if (await commandExists('gnome-terminal')) {
        await spawnEditor('gnome-terminal', [`--working-directory=${dir}`]);
        return;
      }
      if (await commandExists('konsole')) {
        await spawnEditor('konsole', ['--workdir', dir]);
        return;
      }
      await spawnEditor('xterm', ['-e', `cd "${dir}" && $SHELL`]);
    },
  },
  {
    // Antigravity's CLI/bundle identifier isn't documented yet. Detection
    // probes the obvious names (`antigravity` on PATH, `/Applications/
    // Antigravity.app`) and the entry stays hidden from the menu unless one
    // of those probes succeeds — so we never advertise a broken option.
    id: 'antigravity',
    label: 'Antigravity',
    iconName: 'antigravity',
    platforms: ['darwin', 'win32', 'linux'],
    detect: async () =>
      (await commandExists('antigravity')) ||
      (process.platform === 'darwin' && macAppExists('Antigravity')),
    dispatch: async (absolutePath) => {
      try {
        await spawnEditor('antigravity', [absolutePath]);
      } catch {
        if (process.platform === 'darwin') await macOpenWithApp('Antigravity', absolutePath);
        else throw new Error('Antigravity not found');
      }
    },
  },
  {
    id: 'copy-path',
    label: 'Copy path',
    iconName: 'clipboard',
    shortcutKey: '⌘⇧C',
    platforms: ['darwin', 'win32', 'linux'],
    detect: async () => true,
    dispatch: async (absolutePath) => {
      clipboard.writeText(absolutePath);
    },
  },
];

let availabilityCache: OpenTarget[] | null = null;

export async function listAvailableOpeners(): Promise<OpenTarget[]> {
  if (availabilityCache) return availabilityCache;
  const platform = process.platform;
  const results = await Promise.all(
    TARGETS.map(async (spec) => {
      const platformOk = spec.platforms.includes(platform);
      const available = platformOk && (await spec.detect().catch(() => false));
      return {
        id: spec.id,
        label: spec.label,
        iconName: spec.iconName,
        shortcutKey: spec.shortcutKey,
        available,
      };
    })
  );
  availabilityCache = results.filter((t) => t.available);
  return availabilityCache;
}

export async function openIn(
  targetId: OpenTargetId,
  absolutePath: string,
  isDirectory: boolean
): Promise<OpenInResult> {
  const spec = TARGETS.find((t) => t.id === targetId);
  if (!spec) return { success: false, error: `Unknown opener: ${targetId}` };
  if (!spec.platforms.includes(process.platform))
    return { success: false, error: `${spec.label} is not available on this platform` };
  try {
    await spec.dispatch(absolutePath, isDirectory);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to open ${absolutePath} in ${targetId}:`, error);
    return { success: false, error: message };
  }
}
