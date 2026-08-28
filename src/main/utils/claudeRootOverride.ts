import * as os from 'os';
import * as path from 'path';

import { LocalFileSystemProvider } from '../services/infrastructure/LocalFileSystemProvider';

import type { FileSystemProvider } from '../services/infrastructure/FileSystemProvider';

export interface ClaudeRootOverride {
  rootDir: string;
  projectsDir: string;
  todosDir: string;
}

/** Resolve and validate a process-local `--root` override. */
export async function resolveClaudeRootOverride(
  requestedRoot: string,
  workingDirectory: string,
  fsProvider: FileSystemProvider = new LocalFileSystemProvider()
): Promise<ClaudeRootOverride> {
  const expanded =
    requestedRoot === '~' || requestedRoot.startsWith('~/') || requestedRoot.startsWith('~\\')
      ? path.join(os.homedir(), requestedRoot.slice(2))
      : requestedRoot;
  const rootDir = path.resolve(workingDirectory, expanded);

  if (!(await fsProvider.exists(rootDir))) {
    throw new Error(`Claude root does not exist: ${rootDir}`);
  }
  const rootStat = await fsProvider.stat(rootDir);
  if (!rootStat.isDirectory()) {
    throw new Error(`Claude root is not a directory: ${rootDir}`);
  }

  const projectsDir = path.join(rootDir, 'projects');
  if (!(await fsProvider.exists(projectsDir))) {
    throw new Error(
      `Claude root ${rootDir} has no projects directory; pass the directory that contains projects/`
    );
  }
  const projectsStat = await fsProvider.stat(projectsDir);
  if (!projectsStat.isDirectory()) {
    throw new Error(`Expected a projects directory under Claude root ${rootDir}`);
  }

  return { rootDir, projectsDir, todosDir: path.join(rootDir, 'todos') };
}
