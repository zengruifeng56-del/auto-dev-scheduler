/**
 * Electron API Type Definitions - 简化版
 * 定义渲染进程可用的 electronAPI 接口
 */
import type {
  Task,
  TaskStatus,
  LogEntry,
  Progress,
  SchedulerFullState,
} from './types';

// =============================================================================
// IPC Payloads (Main → Renderer)
// =============================================================================

export interface IpcFileLoadedPayload {
  filePath: string;
  projectRoot: string;
  tasks: Task[];
}

export interface IpcTaskUpdatePayload {
  taskId: string;
  status: TaskStatus;
  duration?: number;
  workerId?: number;
}

export interface IpcWorkerLogPayload {
  workerId: number;
  taskId?: string;
  entry: LogEntry;
}

export interface IpcProgressPayload extends Progress {}

export interface IpcSchedulerStatePayload {
  running: boolean;
  paused: boolean;
}

export interface IpcWorkerStatePayload {
  workerId: number;
  active: boolean;
  taskId?: string;
  tokenUsage?: string;
  currentTool?: string;
}

export interface IpcFullStatePayload extends SchedulerFullState {}

export interface IpcWorkerHealthWarningPayload {
  workerId: string;
  taskId: string | null;
  lastActivity: number;
  reason: string;
}

export interface WatchdogConfigPayload {
  checkIntervalMs: number;
  activityTimeoutMs: number;
  slowToolTimeouts: {
    codex: number;
    gemini: number;
    npmInstall: number;
    npmBuild: number;
    default: number;
  };
}

// =============================================================================
// Electron API Interface
// =============================================================================

export interface ElectronAPI {
  // Dialog
  openFileDialog: () => Promise<string | null>;

  // Scheduler Commands
  loadFile: (filePath: string) => Promise<void>;
  start: (maxParallel: number) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  getState: () => Promise<SchedulerFullState | null>;

  // Worker Commands
  sendToWorker: (workerId: number, content: string) => Promise<void>;
  killWorker: (workerId: number) => Promise<void>;

  // Logs
  exportLogs: () => Promise<string>;
  clearTaskLogs: (taskId: string) => Promise<void>;

  // Watchdog Config
  getWatchdogConfig: () => Promise<WatchdogConfigPayload>;
  setWatchdogConfig: (config: Partial<WatchdogConfigPayload>) => Promise<void>;

  // Event Subscriptions (returns unsubscribe function)
  onFileLoaded: (callback: (payload: IpcFileLoadedPayload) => void) => () => void;
  onTaskUpdate: (callback: (payload: IpcTaskUpdatePayload) => void) => () => void;
  onWorkerLog: (callback: (payload: IpcWorkerLogPayload) => void) => () => void;
  onProgress: (callback: (payload: IpcProgressPayload) => void) => () => void;
  onSchedulerStateChange: (callback: (payload: IpcSchedulerStatePayload) => void) => () => void;
  onWorkerStateChange: (callback: (payload: IpcWorkerStatePayload) => void) => () => void;
  onFullState: (callback: (payload: IpcFullStatePayload) => void) => () => void;
  onWorkerHealthWarning: (callback: (payload: IpcWorkerHealthWarningPayload) => void) => () => void;
}

// =============================================================================
// Global Window Extension
// =============================================================================

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
