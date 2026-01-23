/**
 * IPC Handlers - 简化版
 * 主进程 IPC 处理器 - 将渲染进程命令映射到 Scheduler
 */
import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron';
import path from 'node:path';

import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { Scheduler } from './scheduler-service';
import type { SettingsStore } from './settings-store';
import type { Watchdog, WatchdogConfig } from './watchdog';

export interface RegisterIpcHandlersOptions {
  scheduler: Scheduler;
  watchdog?: Watchdog;
  settingsStore?: SettingsStore;
  getWebContents: () => WebContents[];
}

let registered = false;
let lastOpenedDir: string | undefined;

function safeSend<T>(webContents: WebContents, channel: string, payload: T): void {
  if (webContents.isDestroyed()) return;
  try {
    webContents.send(channel, payload);
  } catch {
    // Ignore: window may be closing/reloading
  }
}

function broadcast<T>(getWebContents: () => WebContents[], channel: string, payload: T): void {
  for (const wc of getWebContents()) {
    safeSend(wc, channel, payload);
  }
}

function pickDialogParentWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

export function registerIpcHandlers(options: RegisterIpcHandlersOptions): void {
  if (registered) return;
  registered = true;

  const { scheduler, watchdog, settingsStore, getWebContents } = options;

  const emitFullState = (): void => {
    broadcast(getWebContents, IPC_CHANNELS.EVENT_FULL_STATE, scheduler.getState());
  };

  // --------------------------------------------------------------------------
  // Scheduler → Renderer Event Forwarding
  // --------------------------------------------------------------------------

  scheduler.on('fileLoaded', (msg) => {
    broadcast(getWebContents, IPC_CHANNELS.EVENT_FILE_LOADED, msg.payload);
    emitFullState();
  });

  scheduler.on('taskUpdate', (msg) => {
    broadcast(getWebContents, IPC_CHANNELS.EVENT_TASK_UPDATE, msg.payload);
  });

  scheduler.on('workerLog', (msg) => {
    broadcast(getWebContents, IPC_CHANNELS.EVENT_WORKER_LOG, msg.payload);
  });

  scheduler.on('progress', (msg) => {
    broadcast(getWebContents, IPC_CHANNELS.EVENT_PROGRESS, msg.payload);
  });

  scheduler.on('schedulerState', (msg) => {
    broadcast(getWebContents, IPC_CHANNELS.EVENT_SCHEDULER_STATE, msg.payload);
    emitFullState();
  });

  scheduler.on('workerState', (msg) => {
    broadcast(getWebContents, IPC_CHANNELS.EVENT_WORKER_STATE, msg.payload);
  });

  scheduler.on('issueReported', (msg) => {
    broadcast(getWebContents, IPC_CHANNELS.EVENT_ISSUE_REPORTED, msg.payload);
  });

  scheduler.on('issueUpdate', (msg) => {
    broadcast(getWebContents, IPC_CHANNELS.EVENT_ISSUE_UPDATE, msg.payload);
  });

  scheduler.on('apiError', (msg) => {
    broadcast(getWebContents, IPC_CHANNELS.EVENT_API_ERROR, msg.payload);
  });

  // --------------------------------------------------------------------------
  // Renderer → Main Command Handlers (ipcRenderer.invoke)
  // --------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.DIALOG_OPEN_FILE, async () => {
    const parent = pickDialogParentWindow();
    const dialogOptions: Electron.OpenDialogOptions = {
      title: '选择 AUTO-DEV.md',
      defaultPath: lastOpenedDir,
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    };

    const result = parent
      ? await dialog.showOpenDialog(parent, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0] ?? null;
    if (filePath) lastOpenedDir = path.dirname(filePath);
    return filePath;
  });

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_LOAD_FILE, async (_event, args: { filePath?: unknown } | undefined) => {
    const filePath = typeof args?.filePath === 'string' ? args.filePath.trim() : '';
    if (!filePath) throw new Error('scheduler:loadFile: filePath cannot be empty');
    await scheduler.loadFile(filePath);
    emitFullState();
  });

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_START, async (_event, args: { maxParallel?: unknown } | undefined) => {
    const maxParallel = typeof args?.maxParallel === 'number' ? args.maxParallel : 1;
    scheduler.start(maxParallel);
    emitFullState();
  });

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_PAUSE, async () => {
    scheduler.pause();
    emitFullState();
  });

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_RESUME, async () => {
    scheduler.resume();
    emitFullState();
  });

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_STOP, async () => {
    await scheduler.stop();
    emitFullState();
  });

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_GET_STATE, async () => {
    const state = scheduler.getState();
    broadcast(getWebContents, IPC_CHANNELS.EVENT_FULL_STATE, state);
    return state;
  });

  ipcMain.handle(IPC_CHANNELS.TASK_RETRY, async (_event, args: { taskId?: unknown } | undefined) => {
    const taskId = typeof args?.taskId === 'string' ? args.taskId.trim() : '';
    if (!taskId) throw new Error('task:retry: taskId cannot be empty');
    scheduler.retryTask(taskId);
    emitFullState();
  });

  ipcMain.handle(IPC_CHANNELS.WORKER_SEND, async (_event, args: { workerId?: unknown; content?: unknown } | undefined) => {
    const workerId = typeof args?.workerId === 'number' ? args.workerId : NaN;
    const content = typeof args?.content === 'string' ? args.content : '';

    if (!Number.isFinite(workerId)) throw new Error('worker:send: workerId is invalid');
    if (!content.trim()) throw new Error('worker:send: content cannot be empty');

    await scheduler.sendToWorker(workerId, content);
  });

  ipcMain.handle(IPC_CHANNELS.WORKER_KILL, async (_event, args: { workerId?: unknown } | undefined) => {
    const workerId = typeof args?.workerId === 'number' ? args.workerId : NaN;
    if (!Number.isFinite(workerId)) throw new Error('worker:kill: workerId is invalid');
    await scheduler.killWorker(workerId);
  });

  ipcMain.handle(IPC_CHANNELS.LOGS_EXPORT, async () => {
    return scheduler.exportLogs();
  });

  ipcMain.handle(IPC_CHANNELS.LOGS_CLEAR_TASK_LOGS, async (_event, args: { taskId?: unknown } | undefined) => {
    const taskId = typeof args?.taskId === 'string' ? args.taskId.trim() : '';
    if (!taskId) throw new Error('logs:clearTaskLogs: taskId cannot be empty');
    await scheduler.clearTaskLogs(taskId);
  });

  // --------------------------------------------------------------------------
  // Issue Handlers
  // --------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.ISSUE_UPDATE_STATUS, async (_event, args: { issueId?: unknown; status?: unknown } | undefined) => {
    const issueId = typeof args?.issueId === 'string' ? args.issueId.trim() : '';
    const status = typeof args?.status === 'string' ? args.status : '';

    if (!issueId) throw new Error('issue:updateStatus: issueId cannot be empty');
    if (!['open', 'fixed', 'ignored'].includes(status)) {
      throw new Error('issue:updateStatus: status must be "open", "fixed", or "ignored"');
    }

    scheduler.updateIssueStatus(issueId, status as 'open' | 'fixed' | 'ignored');
    emitFullState();
  });

  ipcMain.handle(IPC_CHANNELS.ISSUE_CLEAR_ALL, async () => {
    scheduler.clearAllIssues();
    emitFullState();
  });

  // --------------------------------------------------------------------------
  // Watchdog Config Handlers
  // --------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.WATCHDOG_GET_CONFIG, async () => {
    if (!watchdog) {
      return {
        checkIntervalMs: 5 * 60_000,
        activityTimeoutMs: 10 * 60_000,
        slowToolTimeouts: {
          codex: 60 * 60_000,
          gemini: 60 * 60_000,
          npmInstall: 15 * 60_000,
          npmBuild: 20 * 60_000,
          thinking: 15 * 60_000,
          default: 10 * 60_000
        }
      };
    }
    return watchdog.getConfig();
  });

  ipcMain.handle(IPC_CHANNELS.WATCHDOG_SET_CONFIG, async (_event, config: Partial<WatchdogConfig> | undefined) => {
    if (!watchdog || !config) return;
    watchdog.updateConfig(config);
    if (settingsStore) {
      await settingsStore.update({ watchdog: watchdog.getConfig() });
    }
  });

  // --------------------------------------------------------------------------
  // Auto-Retry Config Handlers
  // --------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.AUTO_RETRY_GET_CONFIG, async () => {
    return scheduler.getAutoRetryConfig();
  });

  ipcMain.handle(IPC_CHANNELS.AUTO_RETRY_SET_CONFIG, async (_event, config: unknown) => {
    if (!config || typeof config !== 'object') return;
    const partial: Record<string, unknown> = {};
    const cfg = config as Record<string, unknown>;
    if (typeof cfg.enabled === 'boolean') partial.enabled = cfg.enabled;
    if (typeof cfg.maxRetries === 'number' && Number.isFinite(cfg.maxRetries)) {
      partial.maxRetries = cfg.maxRetries;
    }
    if (typeof cfg.baseDelayMs === 'number' && Number.isFinite(cfg.baseDelayMs)) {
      partial.baseDelayMs = cfg.baseDelayMs;
    }
    scheduler.updateAutoRetryConfig(partial);
    if (settingsStore) {
      await settingsStore.update({ autoRetry: scheduler.getAutoRetryConfig() });
    }
  });

  // --------------------------------------------------------------------------
  // Scheduler Blocker Config Handlers
  // --------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_GET_BLOCKER_CONFIG, async () => {
    return { blockerAutoPauseEnabled: scheduler.getBlockerAutoPauseEnabled() };
  });

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_SET_BLOCKER_CONFIG, async (_event, config: { blockerAutoPauseEnabled?: unknown } | undefined) => {
    if (!config) return;
    if (typeof config.blockerAutoPauseEnabled === 'boolean') {
      scheduler.setBlockerAutoPauseEnabled(config.blockerAutoPauseEnabled);
      if (settingsStore) {
        await settingsStore.update({ scheduler: { blockerAutoPauseEnabled: config.blockerAutoPauseEnabled } });
      }
    }
  });

  // --------------------------------------------------------------------------
  // API Error Retry Handler
  // --------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.API_ERROR_RETRY, async () => {
    scheduler.retryFromApiError();
    emitFullState();
  });
}
