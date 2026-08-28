/**
 * IPC Handlers for the per-project Memory viewer.
 *
 * Surface:
 * - memory:hasMemory               → boolean
 * - memory:getIndex                → MemoryIndex | null
 * - memory:readFile                → { content, path }
 * - memory:listAvailableOpeners    → OpenTarget[]
 * - memory:openIn                  → { success, error? }
 * - memory:copyPath                → { success, error? }
 *
 * Reads are read-only — no IPC handler writes to memory files.
 */

import { listAvailableOpeners, openIn } from '@main/utils/openInLauncher';
import { createLogger } from '@shared/utils/logger';
import { clipboard, type IpcMain, type IpcMainInvokeEvent } from 'electron';

// Channel constants (mirrored from preload/constants/ipcChannels.ts to respect
// module boundaries — main process cannot import from preload).
const MEMORY_HAS_MEMORY = 'memory:hasMemory';
const MEMORY_GET_INDEX = 'memory:getIndex';
const MEMORY_READ_FILE = 'memory:readFile';
const MEMORY_LIST_OPENERS = 'memory:listAvailableOpeners';
const MEMORY_OPEN_IN = 'memory:openIn';
const MEMORY_COPY_PATH = 'memory:copyPath';

import { validateProjectId } from './guards';

import type { ServiceContextRegistry } from '../services';
import type { OpenTarget, OpenTargetId } from '@main/utils/openInLauncher';
import type { MemoryIndex } from '@shared/utils/memoryIndex';

const logger = createLogger('IPC:memory');

let registry: ServiceContextRegistry;

export function initializeMemoryHandlers(contextRegistry: ServiceContextRegistry): void {
  registry = contextRegistry;
}

export function registerMemoryHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(MEMORY_HAS_MEMORY, handleHasMemory);
  ipcMain.handle(MEMORY_GET_INDEX, handleGetIndex);
  ipcMain.handle(MEMORY_READ_FILE, handleReadFile);
  ipcMain.handle(MEMORY_LIST_OPENERS, handleListOpeners);
  ipcMain.handle(MEMORY_OPEN_IN, handleOpenIn);
  ipcMain.handle(MEMORY_COPY_PATH, handleCopyPath);
  logger.info('Memory handlers registered');
}

export function removeMemoryHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(MEMORY_HAS_MEMORY);
  ipcMain.removeHandler(MEMORY_GET_INDEX);
  ipcMain.removeHandler(MEMORY_READ_FILE);
  ipcMain.removeHandler(MEMORY_LIST_OPENERS);
  ipcMain.removeHandler(MEMORY_OPEN_IN);
  ipcMain.removeHandler(MEMORY_COPY_PATH);
}

// =============================================================================
// Result types
// =============================================================================

type MemoryReadFileResult =
  | { success: true; content: string; path: string }
  | { success: false; error: string };

type MemoryOpenResult = { success: true } | { success: false; error: string };

// =============================================================================
// Handlers
// =============================================================================

async function handleHasMemory(_event: IpcMainInvokeEvent, projectId: unknown): Promise<boolean> {
  const projectIdResult = validateProjectId(projectId);
  if (!projectIdResult.valid || !projectIdResult.value) return false;
  try {
    return await registry.getActive().memoryReader.hasMemory(projectIdResult.value);
  } catch (error) {
    logger.error('Error in memory:hasMemory:', error);
    return false;
  }
}

async function handleGetIndex(
  _event: IpcMainInvokeEvent,
  projectId: unknown
): Promise<MemoryIndex | null> {
  const projectIdResult = validateProjectId(projectId);
  if (!projectIdResult.valid || !projectIdResult.value) return null;
  try {
    return await registry.getActive().memoryReader.readIndex(projectIdResult.value);
  } catch (error) {
    logger.error('Error in memory:getIndex:', error);
    return null;
  }
}

async function handleReadFile(
  _event: IpcMainInvokeEvent,
  projectId: unknown,
  fileName: unknown
): Promise<MemoryReadFileResult> {
  const projectIdResult = validateProjectId(projectId);
  if (!projectIdResult.valid || !projectIdResult.value) {
    return { success: false, error: projectIdResult.error ?? 'Invalid projectId' };
  }
  if (typeof fileName !== 'string' || !fileName.trim()) {
    return { success: false, error: 'fileName must be a non-empty string' };
  }
  try {
    const file = await registry.getActive().memoryReader.readFile(projectIdResult.value, fileName);
    return { success: true, content: file.content, path: file.absolutePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Error in memory:readFile:', error);
    return { success: false, error: message };
  }
}

async function handleListOpeners(_event: IpcMainInvokeEvent): Promise<OpenTarget[]> {
  try {
    return await listAvailableOpeners();
  } catch (error) {
    logger.error('Error in memory:listAvailableOpeners:', error);
    return [];
  }
}

async function handleOpenIn(
  _event: IpcMainInvokeEvent,
  projectId: unknown,
  fileName: unknown,
  targetId: unknown
): Promise<MemoryOpenResult> {
  const projectIdResult = validateProjectId(projectId);
  if (!projectIdResult.valid || !projectIdResult.value) {
    return { success: false, error: projectIdResult.error ?? 'Invalid projectId' };
  }
  if (typeof targetId !== 'string' || !targetId) {
    return { success: false, error: 'targetId must be a non-empty string' };
  }
  try {
    const reader = registry.getActive().memoryReader;
    const dir = reader.getDirPath(projectIdResult.value);
    let absolutePath: string;
    let isDirectory: boolean;
    if (typeof fileName === 'string' && fileName.trim().length > 0) {
      absolutePath = reader.getFilePath(projectIdResult.value, fileName);
      isDirectory = false;
    } else {
      absolutePath = dir;
      isDirectory = true;
    }
    return await openIn(targetId as OpenTargetId, absolutePath, isDirectory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Error in memory:openIn:', error);
    return { success: false, error: message };
  }
}

async function handleCopyPath(
  _event: IpcMainInvokeEvent,
  projectId: unknown,
  fileName: unknown
): Promise<MemoryOpenResult> {
  const projectIdResult = validateProjectId(projectId);
  if (!projectIdResult.valid || !projectIdResult.value) {
    return { success: false, error: projectIdResult.error ?? 'Invalid projectId' };
  }
  try {
    const reader = registry.getActive().memoryReader;
    let absolutePath: string;
    if (typeof fileName === 'string' && fileName.trim().length > 0) {
      absolutePath = reader.getFilePath(projectIdResult.value, fileName);
    } else {
      absolutePath = reader.getDirPath(projectIdResult.value);
    }
    clipboard.writeText(absolutePath);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Error in memory:copyPath:', error);
    return { success: false, error: message };
  }
}
