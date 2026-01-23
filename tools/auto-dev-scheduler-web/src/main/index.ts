/**
 * Electron Main Process Entry - 简化版
 * Auto-Dev Scheduler 主进程入口
 */

// Prevent EPIPE errors from crashing the app in GUI mode (no console)
// This must be done before any console.log calls
process.stdout?.on?.('error', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
  throw err;
});
process.stderr?.on?.('error', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
  throw err;
});

import { app, BrowserWindow, Menu } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

import { IPC_CHANNELS } from '../shared/ipc-channels';
import { registerIpcHandlers } from './ipc-handlers';
import { Scheduler } from './scheduler-service';
import { SettingsStore } from './settings-store';
import { Watchdog } from './watchdog';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const scheduler = new Scheduler();
const watchdog = new Watchdog({
  restartHandler: async (worker) => {
    const workerId = Number.parseInt(worker.id, 10);
    if (Number.isFinite(workerId) && workerId > 0) {
      console.log(`[watchdog] Restarting worker ${workerId} (task=${worker.taskId})`);
      await scheduler.killWorker(workerId);
    }
  }
});

const settingsStore = new SettingsStore();

let mainWindow: BrowserWindow | null = null;

function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '退出', accelerator: 'CmdOrCtrl+Q', role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: '强制重新加载', accelerator: 'CmdOrCtrl+Shift+R', role: 'forceReload' },
        { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn' },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', accelerator: 'CmdOrCtrl+M', role: 'minimize' },
        { label: '关闭', accelerator: 'CmdOrCtrl+W', role: 'close' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

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

  app.whenReady().then(async () => {
    createMenu();

    // Load persisted settings
    try {
      const settings = await settingsStore.load();
      watchdog.updateConfig(settings.watchdog);
      scheduler.updateAutoRetryConfig(settings.autoRetry);
      scheduler.setBlockerAutoPauseEnabled(settings.scheduler.blockerAutoPauseEnabled);
      console.log('[settings] Loaded settings from disk');
    } catch (err: unknown) {
      console.warn('[settings] Failed to load settings:', err);
    }

    registerIpcHandlers({
      scheduler,
      watchdog,
      settingsStore,
      getWebContents: () => (mainWindow ? [mainWindow.webContents] : [])
    });

    // Integrate Watchdog with Scheduler
    scheduler.on('workerState', (msg) => {
      const { workerId, taskId, active } = msg.payload;

      if (active) {
        watchdog.upsertWorker({
          id: String(workerId),
          pid: null,
          taskId: taskId ?? null,
          lastActivity: Date.now()
        });
      } else {
        watchdog.removeWorker(String(workerId));
      }
    });

    // Track worker activity
    scheduler.on('workerLog', (msg) => {
      const { workerId, entry } = msg.payload;
      watchdog.touch(String(workerId), Date.now());

      // Track tool calls
      if (entry.type === 'tool' && entry.content) {
        const toolMatch = entry.content.match(/^([^→\s]+)/);
        const toolName = toolMatch?.[1] ?? 'unknown';
        const callId = `${workerId}-${Date.now()}`;
        watchdog.recordToolCallStarted(String(workerId), toolName, callId);
      } else if (entry.type === 'result') {
        // Remove one pending tool call (FIFO) instead of clearing all
        watchdog.recordToolCallCompleted(String(workerId));
      }
    });

    // Start watchdog monitoring
    watchdog.start();

    // Broadcast health warnings to renderer
    watchdog.on('diagnosis', (worker, result) => {
      if (result.action === 'restart') {
        if (mainWindow && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.EVENT_WORKER_HEALTH_WARNING, {
            workerId: worker.id,
            taskId: worker.taskId,
            lastActivity: worker.lastActivity,
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
