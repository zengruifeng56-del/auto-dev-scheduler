/**
 * Preload Script - 简化版
 * 预加载脚本 - 通过 contextBridge 暴露安全的 IPC API 给渲染进程
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type {
  ElectronAPI,
  IpcFileLoadedPayload,
  IpcTaskUpdatePayload,
  IpcWorkerLogPayload,
  IpcProgressPayload,
  IpcSchedulerStatePayload,
  IpcWorkerStatePayload,
  IpcFullStatePayload,
  IpcWorkerHealthWarningPayload,
  IpcIssueReportedPayload,
  IpcIssueUpdatePayload,
  IpcApiErrorPayload,
  WatchdogConfigPayload,
  AutoRetryConfigPayload,
} from '../shared/electron-api.d';
import type { IssueStatus } from '../shared/types';
import { IPC_CHANNELS } from '../shared/ipc-channels';

// Helper: Create event subscription with automatic cleanup
function createEventSubscription<T>(
  channel: string,
  callback: (payload: T) => void
): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const electronAPI: ElectronAPI = {
  // ==========================================================================
  // Dialog
  // ==========================================================================
  openFileDialog: () => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN_FILE),

  // ==========================================================================
  // Scheduler Commands
  // ==========================================================================
  loadFile: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_LOAD_FILE, { filePath }),

  start: (maxParallel: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_START, { maxParallel }),

  pause: () => ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_PAUSE),

  resume: () => ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_RESUME),

  stop: () => ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_STOP),

  getState: () => ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_GET_STATE),

  // ==========================================================================
  // Task Commands
  // ==========================================================================
  retryTask: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_RETRY, { taskId }),

  // ==========================================================================
  // Worker Commands
  // ==========================================================================
  sendToWorker: (workerId: number, content: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKER_SEND, { workerId, content }),

  killWorker: (workerId: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKER_KILL, { workerId }),

  // ==========================================================================
  // Logs
  // ==========================================================================
  exportLogs: () => ipcRenderer.invoke(IPC_CHANNELS.LOGS_EXPORT),

  clearTaskLogs: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LOGS_CLEAR_TASK_LOGS, { taskId }),

  // ==========================================================================
  // Watchdog Config
  // ==========================================================================
  getWatchdogConfig: () => ipcRenderer.invoke(IPC_CHANNELS.WATCHDOG_GET_CONFIG),

  setWatchdogConfig: (config: Partial<WatchdogConfigPayload>) =>
    ipcRenderer.invoke(IPC_CHANNELS.WATCHDOG_SET_CONFIG, config),

  // ==========================================================================
  // Auto-Retry Config
  // ==========================================================================
  getAutoRetryConfig: () => ipcRenderer.invoke(IPC_CHANNELS.AUTO_RETRY_GET_CONFIG),

  setAutoRetryConfig: (config: Partial<AutoRetryConfigPayload>) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTO_RETRY_SET_CONFIG, config),

  // ==========================================================================
  // Scheduler Blocker Config
  // ==========================================================================
  getBlockerConfig: () => ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_GET_BLOCKER_CONFIG),

  setBlockerConfig: (config: { blockerAutoPauseEnabled: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_SET_BLOCKER_CONFIG, config),

  // ==========================================================================
  // Issue Commands
  // ==========================================================================
  updateIssueStatus: (issueId: string, status: IssueStatus) =>
    ipcRenderer.invoke(IPC_CHANNELS.ISSUE_UPDATE_STATUS, { issueId, status }),

  clearAllIssues: () =>
    ipcRenderer.invoke(IPC_CHANNELS.ISSUE_CLEAR_ALL),

  // ==========================================================================
  // API Error Commands
  // ==========================================================================
  retryFromApiError: () => ipcRenderer.invoke(IPC_CHANNELS.API_ERROR_RETRY),

  // ==========================================================================
  // Event Subscriptions
  // ==========================================================================
  onFileLoaded: (callback: (payload: IpcFileLoadedPayload) => void) =>
    createEventSubscription(IPC_CHANNELS.EVENT_FILE_LOADED, callback),

  onTaskUpdate: (callback: (payload: IpcTaskUpdatePayload) => void) =>
    createEventSubscription(IPC_CHANNELS.EVENT_TASK_UPDATE, callback),

  onWorkerLog: (callback: (payload: IpcWorkerLogPayload) => void) =>
    createEventSubscription(IPC_CHANNELS.EVENT_WORKER_LOG, callback),

  onProgress: (callback: (payload: IpcProgressPayload) => void) =>
    createEventSubscription(IPC_CHANNELS.EVENT_PROGRESS, callback),

  onSchedulerStateChange: (callback: (payload: IpcSchedulerStatePayload) => void) =>
    createEventSubscription(IPC_CHANNELS.EVENT_SCHEDULER_STATE, callback),

  onWorkerStateChange: (callback: (payload: IpcWorkerStatePayload) => void) =>
    createEventSubscription(IPC_CHANNELS.EVENT_WORKER_STATE, callback),

  onFullState: (callback: (payload: IpcFullStatePayload) => void) =>
    createEventSubscription(IPC_CHANNELS.EVENT_FULL_STATE, callback),

  onWorkerHealthWarning: (callback: (payload: IpcWorkerHealthWarningPayload) => void) =>
    createEventSubscription(IPC_CHANNELS.EVENT_WORKER_HEALTH_WARNING, callback),

  onIssueReported: (callback: (payload: IpcIssueReportedPayload) => void) =>
    createEventSubscription(IPC_CHANNELS.EVENT_ISSUE_REPORTED, callback),

  onIssueUpdate: (callback: (payload: IpcIssueUpdatePayload) => void) =>
    createEventSubscription(IPC_CHANNELS.EVENT_ISSUE_UPDATE, callback),

  onApiError: (callback: (payload: IpcApiErrorPayload) => void) =>
    createEventSubscription(IPC_CHANNELS.EVENT_API_ERROR, callback),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
