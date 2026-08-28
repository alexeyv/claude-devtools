/**
 * Metadata extraction utilities for parsing first messages and session context from JSONL files.
 */

import { createLogger } from '@shared/utils/logger';
import * as readline from 'readline';

import { LocalFileSystemProvider } from '../services/infrastructure/LocalFileSystemProvider';
import { type ChatHistoryEntry } from '../types';

import { translateWslMountPath } from './pathDecoder';

import type { FileSystemProvider } from '../services/infrastructure/FileSystemProvider';

const logger = createLogger('Util:metadataExtraction');

/**
 * Normalize Windows drive letter to uppercase for consistent path comparison.
 * CLI uses uppercase (C:\...) while VS Code extension uses lowercase (c:\...).
 */
function normalizeDriveLetter(p: string): string {
  if (p.length >= 2 && p[1] === ':') {
    return p[0].toUpperCase() + p.slice(1);
  }
  return p;
}

const defaultProvider = new LocalFileSystemProvider();

/**
 * Extract CWD (current working directory) from the first entry.
 * Used to get the actual project path from encoded directory names.
 */
export async function extractCwd(
  filePath: string,
  fsProvider: FileSystemProvider = defaultProvider
): Promise<string | null> {
  if (!(await fsProvider.exists(filePath))) {
    return null;
  }

  const fileStream = fsProvider.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      const entry = JSON.parse(line) as ChatHistoryEntry;
      // Only conversational entries have cwd
      if ('cwd' in entry && entry.cwd) {
        rl.close();
        fileStream.destroy();
        return normalizeDriveLetter(translateWslMountPath(entry.cwd));
      }
    }
  } catch (error) {
    logger.error(`Error extracting cwd from ${filePath}:`, error);
  } finally {
    rl.close();
    fileStream.destroy();
  }

  return null;
}
