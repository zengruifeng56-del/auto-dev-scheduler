/**
 * Electron Main Process Entry
 * Auto-Dev Scheduler 主进程入口
 */
import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

import { IPC_CHANNELS } from '../shared/ipc-channels';
import { registerIpcHandlers } from './ipc-handlers';
import { Scheduler } from './scheduler-service';
import { Watchdog } from './watchdog';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const scheduler = new Scheduler();
const watchdog = new Watchdog({
  operationLogPath: path.join(app.getPath('userData'), 'logs', 'watchdog-operations.log'),
  // #3 Fix: Provide restartHandler to enable Watchdog to trigger worker restart
  restartHandler: async (worker) => {
    const workerId = Number.parseInt(worker.id, 10);
    if (Number.isFinite(workerId) && workerId > 0) {
      console.log(`[watchdog] Restarting worker ${workerId} (task=${worker.taskId})`);
      await scheduler.killWorker(workerId);
    }
  }
});

let mainWindow: BrowserWindow | null = null;

function sendFullStateToRenderer(): void {
  if (!mainWindow) return;
  const wc = mainWindow.webContents;
  if (wc.isDestroyed()) return;
  wc.send(IPC_CHANNELS.EVENT_FULL_STATE, scheduler.getState());
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    sendFullStateToRenderer();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpcHandlers({
      scheduler,
      watchdog,
      getWebContents: () => (mainWindow ? [mainWindow.webContents] : [])
    });

    // Integrate Watchdog with Scheduler: track worker lifecycle
    scheduler.on('workerState', (msg) => {
      const { workerId, taskId } = msg.payload;
      const state = scheduler.getState();
      const workerState = state.workers.find(w => w.id === workerId);

      if (workerState?.active) {
        // Worker is active, register or update in watchdog
        watchdog.upsertWorker({
          id: String(workerId),
          pid: null, // pid is not exposed by scheduler, but we track activity
          taskId: taskId ?? null,
          logFile: '', // Log file path would need to be passed separately
          lastActivity: Date.now()
        });
      } else {
        // Worker became inactive, remove from watchdog
        watchdog.removeWorker(String(workerId));
      }
    });

    // Track worker log events to update activity
    scheduler.on('workerLog', (msg) => {
      const { workerId, entry } = msg.payload;
      watchdog.touch(String(workerId), Date.now());

      // Track tool calls for Rule 3/4
      if (entry.type === 'tool' && entry.content) {
        const toolMatch = entry.content.match(/^([^→\s]+)/);
        const toolName = toolMatch?.[1] ?? 'unknown';
        const callId = `${workerId}-${Date.now()}`;
        watchdog.recordToolCallStarted(String(workerId), toolName, callId, entry.content);
      } else if (entry.type === 'result') {
        // Clear pending tool calls on result
        watchdog.clearToolCalls(String(workerId));
      }
    });

    // Start watchdog monitoring
    watchdog.start();

    // Listen for health warnings and broadcast to renderer
    watchdog.on('diagnosis', (worker, result) => {
      if (result.action === 'restart' || result.action === 'need_ai') {
        if (mainWindow && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.EVENT_WORKER_HEALTH_WARNING, {
            workerId: worker.id,
            taskId: worker.taskId,
            lastActivity: worker.lastActivity,
            idleMs: result.recoveryContext?.idleMs ?? 0,
            reason: result.reason
          });
        }
      }
    });

    createMainWindow();
  });

  app.on('before-quit', (event) => {
    watchdog.dispose();
    if (scheduler.getState().running || scheduler.getState().workers.some(w => w.active)) {
      event.preventDefault();
      scheduler.stop().finally(() => {
        app.quit();
      });
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}
