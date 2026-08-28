/**
 * Main process entry point for claude-devtools.
 *
 * Responsibilities:
 * - Initialize Electron app and main window
 * - Set up IPC handlers for data access
 * - Initialize ServiceContextRegistry with local context
 * - Start file watcher for live updates
 * - Manage application lifecycle
 */

import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  DEV_SERVER_PORT,
  getTrafficLightPositionForZoom,
  WINDOW_ZOOM_FACTOR_CHANGED_CHANNEL,
} from '@shared/constants';
import { createLogger } from '@shared/utils/logger';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { existsSync } from 'fs';
import { totalmem } from 'os';
import { join } from 'path';

import { initializeIpcHandlers, removeIpcHandlers } from './ipc/handlers';
import { resolveClaudeRootOverride } from './utils/claudeRootOverride';
import { parseCliArgs } from './utils/cliArgs';
import { getProjectsBasePath, getTodosBasePath } from './utils/pathDecoder';
import { formatSessionLaunchError, resolveLaunchTarget } from './utils/sessionLaunchTarget';

import type { SessionLaunchTarget } from '@shared/types/api';

// Dynamic renderer heap limit — proportional to system RAM so low-end devices
// are not starved.  50% of total RAM, clamped to [2 GB, 4 GB].
// Must run before app.whenReady() so the flag is picked up by the renderer.
const totalMB = Math.floor(totalmem() / (1024 * 1024));
const heapMB = Math.min(4096, Math.max(2048, Math.floor(totalMB * 0.5)));
app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${heapMB}`);

// Single instance: a second `claude-devtools --session <id>` should surface the
// session in the running window instead of starting a rival instance.
// Electron forwards the second process's argv to the 'second-instance' event.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

// Window icon path for non-mac platforms.
const getWindowIconPath = (): string | undefined => {
  const isDev = process.env.NODE_ENV === 'development';
  const candidates = isDev
    ? [join(process.cwd(), 'resources/icon.png')]
    : [
        join(process.resourcesPath, 'resources/icon.png'),
        join(__dirname, '../../resources/icon.png'),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
};

const logger = createLogger('App');
// IPC channel constants (duplicated from @preload to avoid boundary violation)
const SSH_STATUS = 'ssh:status';
const CONTEXT_CHANGED = 'context:changed';
const HTTP_SERVER_START = 'httpServer:start';
const HTTP_SERVER_STOP = 'httpServer:stop';
const HTTP_SERVER_GET_STATUS = 'httpServer:getStatus';
const SESSION_GET_LAUNCH_TARGET = 'session:getLaunchTarget';
const SESSION_OPEN_REQUEST = 'session:openRequest';

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection in main process:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception in main process:', error);
});

import { HttpServer } from './services/infrastructure/HttpServer';
import {
  configManager,
  configManagerPromise,
  LocalFileSystemProvider,
  NotificationManager,
  ServiceContext,
  ServiceContextRegistry,
  SshConnectionManager,
  UpdaterService,
} from './services';

// =============================================================================
// Application State
// =============================================================================

let mainWindow: BrowserWindow | null = null;

/**
 * Session requested via `--session`, still being resolved.
 * Consumed once by the renderer when it finishes booting; null when there is
 * nothing pending.
 */
let pendingLaunchTarget: Promise<SessionLaunchTarget | null> | null = null;

// Service registry and global services
let contextRegistry: ServiceContextRegistry;
let notificationManager: NotificationManager;
let updaterService: UpdaterService;
let sshConnectionManager: SshConnectionManager;
let httpServer: HttpServer;
let cliClaudeRootOverride: { projectsDir: string; todosDir: string } | null = null;

// File watcher event cleanup functions
let fileChangeCleanup: (() => void) | null = null;
let todoChangeCleanup: (() => void) | null = null;

/**
 * Resolve production renderer index path.
 * Main bundle lives in dist-electron/main, while renderer lives in out/renderer.
 */
function getRendererIndexPath(): string {
  const candidates = [
    join(__dirname, '../../out/renderer/index.html'),
    join(__dirname, '../renderer/index.html'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/**
 * Wires file watcher events from a ServiceContext to the renderer and HTTP SSE clients.
 * Cleans up previous listeners before adding new ones.
 */
function wireFileWatcherEvents(context: ServiceContext): void {
  logger.info(`Wiring FileWatcher events for context: ${context.id}`);

  // Clean up previous listeners
  if (fileChangeCleanup) {
    fileChangeCleanup();
    fileChangeCleanup = null;
  }
  if (todoChangeCleanup) {
    todoChangeCleanup();
    todoChangeCleanup = null;
  }

  // Wire file-change events to renderer and HTTP SSE
  const fileChangeHandler = (event: unknown): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('file-change', event);
    }
    httpServer?.broadcast('file-change', event);
  };
  context.fileWatcher.on('file-change', fileChangeHandler);
  fileChangeCleanup = () => context.fileWatcher.off('file-change', fileChangeHandler);

  // Forward checklist-change events to renderer and HTTP SSE (mirrors file-change pattern above)
  const todoChangeHandler = (event: unknown): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('todo-change', event);
    }
    httpServer?.broadcast('todo-change', event);
  };
  context.fileWatcher.on('todo-change', todoChangeHandler);
  todoChangeCleanup = () => context.fileWatcher.off('todo-change', todoChangeHandler);

  // Forward memory-change events to renderer and HTTP SSE
  const memoryChangeHandler = (event: unknown): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('memory:changed', event);
    }
    httpServer?.broadcast('memory:changed', event);
  };
  context.fileWatcher.on('memory-change', memoryChangeHandler);

  logger.info(`FileWatcher events wired for context: ${context.id}`);
}

/**
 * Handles mode switch requests from the HTTP server.
 * Switches the active context back to local when requested.
 */
async function handleModeSwitch(mode: 'local' | 'ssh'): Promise<void> {
  if (mode === 'local' && contextRegistry.getActiveContextId() !== 'local') {
    const { current } = contextRegistry.switch('local');
    onContextSwitched(current);
  }
}

/**
 * Re-wires file watcher events only. No renderer notification.
 * Used for renderer-initiated switches where the renderer already handles state.
 */
export function rewireContextEvents(context: ServiceContext): void {
  wireFileWatcherEvents(context);
}

/**
 * Full callback: re-wire + notify renderer.
 * Used for external/unexpected switches (e.g., HTTP server mode switch).
 */
function onContextSwitched(context: ServiceContext): void {
  rewireContextEvents(context);

  // Notify renderer of context change
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(SSH_STATUS, sshConnectionManager.getStatus());
    mainWindow.webContents.send(CONTEXT_CHANGED, {
      id: context.id,
      type: context.type,
    });
  }
}

/**
 * Rebuilds the local ServiceContext using the current configured Claude root paths.
 * Called when general.claudeRootPath changes.
 */
function reconfigureLocalContextForClaudeRoot(): void {
  try {
    const projectsDir = cliClaudeRootOverride?.projectsDir ?? getProjectsBasePath();
    const todosDir = cliClaudeRootOverride?.todosDir ?? getTodosBasePath();
    replaceLocalContext(projectsDir, todosDir);
  } catch (error) {
    logger.error('Failed to reconfigure local context for Claude root change:', error);
  }
}

function replaceLocalContext(projectsDir: string, todosDir: string): void {
  const currentLocal = contextRegistry.get('local');
  if (!currentLocal) {
    throw new Error('Cannot reconfigure local context: local context not found');
  }

  const wasLocalActive = contextRegistry.getActiveContextId() === 'local';
  logger.info(`Reconfiguring local context: projectsDir=${projectsDir}, todosDir=${todosDir}`);

  if (wasLocalActive) currentLocal.stopFileWatcher();

  const replacementLocal = new ServiceContext({
    id: 'local',
    type: 'local',
    fsProvider: new LocalFileSystemProvider(),
    projectsDir,
    todosDir,
  });
  if (notificationManager) {
    replacementLocal.fileWatcher.setNotificationManager(notificationManager);
  }
  replacementLocal.start();
  if (!wasLocalActive) replacementLocal.stopFileWatcher();

  contextRegistry.replaceContext('local', replacementLocal);
  if (wasLocalActive) wireFileWatcherEvents(replacementLocal);
}

/**
 * Resolves `--session` / `--project` arguments into an openable session.
 * Reports unusable arguments in a native dialog and lets startup continue.
 *
 * @param argv - argv of the launching process
 * @returns The session to open, or null when none was requested or found
 */
async function resolveLaunchTargetFromArgv(
  argv: string[],
  workingDirectory: string
): Promise<SessionLaunchTarget | null> {
  const args = parseCliArgs(argv);
  if (!args.session && !args.root && !args.error) {
    return null;
  }

  try {
    if (args.error) throw new Error(args.error);

    if (args.root) {
      const override = await resolveClaudeRootOverride(args.root, workingDirectory);
      cliClaudeRootOverride = {
        projectsDir: override.projectsDir,
        todosDir: override.todosDir,
      };
      replaceLocalContext(override.projectsDir, override.todosDir);
      logger.info(`Using process-local Claude root override: ${override.rootDir}`);

      // A root-only second launch means "show this Claude home". Reload the
      // existing renderer against the replacement local context so it cannot
      // keep displaying the old root's cached front page.
      if (!args.session && mainWindow && !mainWindow.isDestroyed()) {
        if (contextRegistry.getActiveContextId() !== 'local') {
          const { current } = contextRegistry.switch('local');
          wireFileWatcherEvents(current);
        }
        mainWindow.webContents.reload();
      }
    }

    const localContext = contextRegistry.get('local');
    if (!localContext) throw new Error('The local session service is unavailable');
    const activeContext = args.root ? localContext : contextRegistry.getActive();

    if (!args.session) return null;

    return await resolveLaunchTarget(activeContext.projectScanner, args, {
      workingDirectory,
      fileLocator: localContext.projectScanner,
      idContextId: activeContext.id,
      fileContextId: localContext.id,
    });
  } catch (error) {
    logger.error('Failed to resolve session from command line:', error);
    const reason = error instanceof Error ? error.message : String(error);
    const detail = formatSessionLaunchError(reason, workingDirectory);
    const sessionRequested = argv.some(
      (arg) => arg === '--session' || arg.startsWith('--session=')
    );
    const options = {
      type: 'error' as const,
      title: sessionRequested ? 'Unable to open session' : 'Unable to use Claude root',
      message: sessionRequested
        ? 'The requested session could not be opened.'
        : 'The requested Claude root could not be used.',
      detail,
      buttons: ['OK'],
      noLink: true,
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
      await dialog.showMessageBox(mainWindow, options);
    } else {
      await dialog.showMessageBox(options);
    }
    return null;
  }
}

/**
 * Brings the existing window to the front, recreating it if it was closed
 * (macOS keeps the app alive with no windows).
 */
function focusMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createWindow();
}

/**
 * Handles a second launch of the app: focuses the running window and opens the
 * session its command line asked for, instead of starting another instance.
 */
async function handleSecondInstance(argv: string[], workingDirectory: string): Promise<void> {
  const hadWindow = !!mainWindow && !mainWindow.isDestroyed();
  const targetPromise = resolveLaunchTargetFromArgv(argv, workingDirectory);

  if (!hadWindow) {
    // A fresh window pulls the target itself once its renderer boots.
    pendingLaunchTarget = targetPromise;
  }
  focusMainWindow();

  const target = await targetPromise;
  if (hadWindow && target && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(SESSION_OPEN_REQUEST, target);
  }
}

/**
 * Initializes all services.
 */
function initializeServices(): void {
  logger.info('Initializing services...');

  // Initialize SSH connection manager
  sshConnectionManager = new SshConnectionManager();

  // Create ServiceContextRegistry
  contextRegistry = new ServiceContextRegistry();

  const localProjectsDir = getProjectsBasePath();
  const localTodosDir = getTodosBasePath();

  // Create local context
  const localContext = new ServiceContext({
    id: 'local',
    type: 'local',
    fsProvider: new LocalFileSystemProvider(),
    projectsDir: localProjectsDir,
    todosDir: localTodosDir,
  });

  // Register and start local context
  contextRegistry.registerContext(localContext);
  localContext.start();

  logger.info(`Projects directory: ${localContext.projectScanner.getProjectsDir()}`);

  // Initialize notification manager (singleton, not context-scoped)
  notificationManager = NotificationManager.getInstance();

  // Set notification manager on local context's file watcher
  localContext.fileWatcher.setNotificationManager(notificationManager);

  // Wire file watcher events for local context
  wireFileWatcherEvents(localContext);

  // Initialize updater service
  updaterService = new UpdaterService();
  httpServer = new HttpServer();

  // Initialize IPC handlers with registry
  initializeIpcHandlers(contextRegistry, updaterService, sshConnectionManager, {
    rewire: rewireContextEvents,
    full: onContextSwitched,
    onClaudeRootPathUpdated: (_claudeRootPath: string | null) => {
      reconfigureLocalContextForClaudeRoot();
    },
  });

  // HTTP Server control IPC handlers
  ipcMain.handle(HTTP_SERVER_START, async () => {
    try {
      if (httpServer.isRunning()) {
        return { success: true, data: { running: true, port: httpServer.getPort() } };
      }
      await startHttpServer(handleModeSwitch);
      // Persist the enabled state
      configManager.updateConfig('httpServer', { enabled: true, port: httpServer.getPort() });
      return { success: true, data: { running: true, port: httpServer.getPort() } };
    } catch (error) {
      logger.error('Failed to start HTTP server via IPC:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start server',
      };
    }
  });

  ipcMain.handle(HTTP_SERVER_STOP, async () => {
    try {
      await httpServer.stop();
      // Persist the disabled state
      configManager.updateConfig('httpServer', { enabled: false });
      return { success: true, data: { running: false, port: httpServer.getPort() } };
    } catch (error) {
      logger.error('Failed to stop HTTP server via IPC:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop server',
      };
    }
  });

  ipcMain.handle(HTTP_SERVER_GET_STATUS, () => {
    return { success: true, data: { running: httpServer.isRunning(), port: httpServer.getPort() } };
  });

  // Session requested via `--session` on the command line. Consumed once by the
  // renderer during startup; returns null when nothing (valid) was requested.
  ipcMain.handle(SESSION_GET_LAUNCH_TARGET, async () => {
    const pending = pendingLaunchTarget;
    pendingLaunchTarget = null;
    try {
      return pending ? await pending : null;
    } catch (error) {
      logger.error('Failed to resolve pending launch session:', error);
      return null;
    }
  });

  // Forward SSH state changes to renderer and HTTP SSE clients
  sshConnectionManager.on('state-change', (status: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(SSH_STATUS, status);
    }
    httpServer.broadcast('ssh:status', status);
  });

  // Forward notification events to HTTP SSE clients
  notificationManager.on('notification-new', (notification: unknown) => {
    httpServer.broadcast('notification:new', notification);
  });
  notificationManager.on('notification-updated', (data: unknown) => {
    httpServer.broadcast('notification:updated', data);
  });
  notificationManager.on('notification-clicked', (data: unknown) => {
    httpServer.broadcast('notification:clicked', data);
  });

  // Start HTTP server if enabled in config
  const appConfig = configManager.getConfig();
  if (appConfig.httpServer?.enabled) {
    void startHttpServer(handleModeSwitch);
  }

  logger.info('Services initialized successfully');
}

/**
 * Starts the HTTP sidecar server with services from the active context.
 */
async function startHttpServer(
  modeSwitchHandler: (mode: 'local' | 'ssh') => Promise<void>
): Promise<void> {
  try {
    const config = configManager.getConfig();
    const activeContext = contextRegistry.getActive();
    const port = await httpServer.start(
      {
        projectScanner: activeContext.projectScanner,
        sessionParser: activeContext.sessionParser,
        subagentResolver: activeContext.subagentResolver,
        chunkBuilder: activeContext.chunkBuilder,
        dataCache: activeContext.dataCache,
        memoryReader: activeContext.memoryReader,
        updaterService,
        sshConnectionManager,
      },
      modeSwitchHandler,
      config.httpServer?.port ?? 3456
    );
    logger.info(`HTTP sidecar server running on port ${port}`);
  } catch (error) {
    logger.error('Failed to start HTTP server:', error);
  }
}

/**
 * Shuts down all services.
 */
function shutdownServices(): void {
  logger.info('Shutting down services...');

  // Stop HTTP server
  if (httpServer?.isRunning()) {
    void httpServer.stop();
  }

  // Clean up file watcher event listeners
  if (fileChangeCleanup) {
    fileChangeCleanup();
    fileChangeCleanup = null;
  }
  if (todoChangeCleanup) {
    todoChangeCleanup();
    todoChangeCleanup = null;
  }

  // Dispose all contexts (including local)
  if (contextRegistry) {
    contextRegistry.dispose();
  }

  // Dispose SSH connection manager
  if (sshConnectionManager) {
    sshConnectionManager.dispose();
  }

  // Remove IPC handlers
  removeIpcHandlers();

  logger.info('Services shut down successfully');
}

/**
 * Update native traffic-light position and notify renderer of the current zoom factor.
 */
function syncTrafficLightPosition(win: BrowserWindow): void {
  const zoomFactor = win.webContents.getZoomFactor();
  const position = getTrafficLightPositionForZoom(zoomFactor);
  // setWindowButtonPosition is macOS-only (traffic light buttons)
  if (process.platform === 'darwin') {
    win.setWindowButtonPosition(position);
  }
  win.webContents.send(WINDOW_ZOOM_FACTOR_CHANGED_CHANNEL, zoomFactor);
}

/**
 * Creates the main application window.
 */
function createWindow(): void {
  const isMac = process.platform === 'darwin';
  const iconPath = isMac ? undefined : getWindowIconPath();
  const useNativeTitleBar = !isMac && configManager.getConfig().general.useNativeTitleBar;
  mainWindow = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
    backgroundColor: '#1a1a1a',
    ...(useNativeTitleBar ? {} : { titleBarStyle: 'hidden' as const }),
    ...(isMac && { trafficLightPosition: getTrafficLightPositionForZoom(1) }),
    title: 'claude-devtools',
  });

  // Load the renderer
  if (process.env.NODE_ENV === 'development') {
    void mainWindow.loadURL(`http://localhost:${DEV_SERVER_PORT}`);
    mainWindow.webContents.openDevTools();
  } else {
    void mainWindow.loadFile(getRendererIndexPath()).catch((error: unknown) => {
      logger.error('Failed to load renderer entry HTML:', error);
    });
  }

  // Set traffic light position + notify renderer on first load, and auto-check for updates
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      syncTrafficLightPosition(mainWindow);
      // Auto-check for updates 3 seconds after window loads
      setTimeout(() => updaterService.checkForUpdates(), 3000);
    }
  });

  // Log top-level renderer load failures (helps diagnose blank/black window issues in packaged apps)
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) {
        logger.error(
          `Failed to load renderer (code=${errorCode}): ${errorDescription} - ${validatedURL}`
        );
      }
    }
  );

  // Sync traffic light position when zoom changes (Cmd+/-, Cmd+0)
  // zoom-changed event doesn't fire in Electron 40, so we detect zoom keys directly.
  // Also keeps zoom bounds within a practical readability range.
  const MIN_ZOOM_LEVEL = -3; // ~70%
  const MAX_ZOOM_LEVEL = 5;
  const ZOOM_IN_KEYS = new Set(['+', '=']);
  const ZOOM_OUT_KEYS = new Set(['-', '_']);
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (input.type !== 'keyDown') return;

    // Intercept Ctrl+R / Cmd+R to prevent Chromium's built-in page reload,
    // then notify the renderer via IPC so it can refresh the session (fixes #58, #85).
    // We must preventDefault here because Chromium handles Ctrl+R at the browser
    // engine level, which also blocks the keydown from reaching the renderer —
    // hence the IPC bridge.
    if ((input.control || input.meta) && !input.shift && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      mainWindow.webContents.send('session:refresh');
      return;
    }
    // Also block Ctrl+Shift+R (hard reload)
    if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      return;
    }

    if (!input.meta) return;

    const currentLevel = mainWindow.webContents.getZoomLevel();

    // Block zoom-out beyond minimum
    if (ZOOM_OUT_KEYS.has(input.key) && currentLevel <= MIN_ZOOM_LEVEL) {
      event.preventDefault();
      return;
    }
    // Block zoom-in beyond maximum
    if (ZOOM_IN_KEYS.has(input.key) && currentLevel >= MAX_ZOOM_LEVEL) {
      event.preventDefault();
      return;
    }

    // For zoom keys (including Cmd+0 reset), defer sync until zoom is applied
    if (ZOOM_IN_KEYS.has(input.key) || ZOOM_OUT_KEYS.has(input.key) || input.key === '0') {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          syncTrafficLightPosition(mainWindow);
        }
      }, 100);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Clear main window references
    if (notificationManager) {
      notificationManager.setMainWindow(null);
    }
    if (updaterService) {
      updaterService.setMainWindow(null);
    }
  });

  // Handle renderer process crashes (render-process-gone replaces deprecated 'crashed' event)
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Renderer process gone:', details.reason, details.exitCode);
    // Could show an error dialog or attempt to reload the window
  });

  // Set main window reference for notification manager and updater
  if (notificationManager) {
    notificationManager.setMainWindow(mainWindow);
  }
  if (updaterService) {
    updaterService.setMainWindow(mainWindow);
  }

  logger.info('Main window created');
}

/**
 * Application ready handler.
 */
void app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    // Another instance owns the session; this process is already quitting.
    return;
  }

  logger.info('App ready, initializing...');
  try {
    // Wait for config to finish loading from disk before using it
    await configManagerPromise;

    // Initialize services first
    initializeServices();

    // Start resolving `--session` while the window boots; the renderer picks
    // the result up via SESSION_GET_LAUNCH_TARGET once it is ready.
    pendingLaunchTarget = resolveLaunchTargetFromArgv(process.argv, process.cwd());

    // Apply configuration settings
    const config = configManager.getConfig();

    // Apply launch at login setting
    app.setLoginItemSettings({
      openAtLogin: config.general.launchAtLogin,
    });

    // Apply dock visibility and icon (macOS)
    if (process.platform === 'darwin') {
      if (!config.general.showDockIcon) {
        app.dock?.hide();
      }
      // macOS app icon is already provided by the signed bundle (.icns)
      // so we avoid runtime setIcon calls that can fail and block startup.
    }

    // Then create window
    createWindow();

    // Listen for notification click events
    notificationManager.on('notification-clicked', (_error) => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (error) {
    logger.error('Startup initialization failed:', error);
    if (!mainWindow) {
      createWindow();
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

/**
 * Second launch handler - forwards the new command line to the running window.
 */
app.on('second-instance', (_event, argv, workingDirectory) => {
  void handleSecondInstance(argv, workingDirectory);
});

/**
 * All windows closed handler.
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * Before quit handler - cleanup.
 */
app.on('before-quit', () => {
  if (hasSingleInstanceLock) {
    shutdownServices();
  }
});
