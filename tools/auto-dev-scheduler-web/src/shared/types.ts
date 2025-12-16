// Task status enumeration
export type TaskStatus =
  | 'pending'    // Waiting for dependencies
  | 'ready'      // Dependencies satisfied, can be executed
  | 'running'    // Currently executing
  | 'success'    // Completed successfully
  | 'failed'     // Failed
  | 'canceled';  // Canceled by user

// Task definition
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  wave: number;
  dependencies: string[];
  estimatedTokens?: number;
  duration?: number;       // Execution time in seconds
  startTime?: string;      // ISO timestamp
  endTime?: string;        // ISO timestamp
  workerId?: number;       // Assigned worker ID
}

// ============================================================
// Delivery Check (交付检查)
// ============================================================

export interface ChecklistItem {
  checked: boolean;
  text: string;
  line: number; // Line number in tasks.md (1-based)
}

export interface DeliveryReport {
  status: 'pass' | 'warning';
  total: number;
  covered: number;
  uncovered: ChecklistItem[];
  generatedAt: string; // ISO timestamp
  changeId?: string;
  tasksPath?: string;
  notes?: string[];
}

// Log entry type enumeration
export type LogEntryType =
  | 'start'      // Process start
  | 'tool'       // Tool invocation
  | 'result'     // Tool result
  | 'output'     // Text output
  | 'error'      // Error message
  | 'system';    // System message

// Log entry
export interface LogEntry {
  ts: string;              // Timestamp (HH:mm:ss format)
  type: LogEntryType;
  content: string;
}

// Worker state
export interface WorkerState {
  id: number;
  active: boolean;
  taskId?: string;
  tokenUsage?: string;     // e.g., "10.2k/180k"
  currentTool?: string;    // Currently executing tool
  logs: LogEntry[];
}

// Progress info
export interface Progress {
  completed: number;
  total: number;
}

// Scheduler full state (for hydration)
export interface SchedulerFullState {
  running: boolean;
  paused: boolean;
  filePath: string;
  projectRoot: string;
  tasks: Task[];
  workers: WorkerState[];
  progress: Progress;
}

// ============================================================
// WebSocket Protocol - Server → Client Messages
// ============================================================

export interface TaskUpdateMessage {
  type: 'taskUpdate';
  payload: {
    taskId: string;
    status: TaskStatus;
    duration?: number;
    workerId?: number;
  };
}

export interface WorkerLogMessage {
  type: 'workerLog';
  payload: {
    workerId: number;
    taskId?: string;
    entry: LogEntry;
  };
}

export interface ProgressMessage {
  type: 'progress';
  payload: Progress;
}

export interface SchedulerStateMessage {
  type: 'schedulerState';
  payload: {
    running: boolean;
    paused: boolean;
  };
}

export interface WorkerStateMessage {
  type: 'workerState';
  payload: {
    workerId: number;
    taskId?: string;
    tokenUsage?: string;
    currentTool?: string;
  };
}

export interface FullStateMessage {
  type: 'fullState';
  payload: SchedulerFullState;
}

export interface HelloMessage {
  type: 'hello';
  serverTime: string;
  version: string;
}

export interface PongMessage {
  type: 'pong';
  ts: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export interface FileLoadedMessage {
  type: 'fileLoaded';
  payload: {
    filePath: string;
    projectRoot: string;
    tasks: Task[];
  };
}

export interface ExportLogsResponseMessage {
  type: 'exportLogsResponse';
  payload: {
    content: string;
  };
}

export interface DeliveryCheckMessage {
  type: 'deliveryCheck';
  payload: DeliveryReport;
}

export type ServerMessage =
  | TaskUpdateMessage
  | WorkerLogMessage
  | ProgressMessage
  | SchedulerStateMessage
  | WorkerStateMessage
  | FullStateMessage
  | HelloMessage
  | PongMessage
  | ErrorMessage
  | FileLoadedMessage
  | ExportLogsResponseMessage
  | DeliveryCheckMessage;

// ============================================================
// WebSocket Protocol - Client → Server Messages
// ============================================================

export interface LoadFileMessage {
  type: 'loadFile';
  payload: {
    filePath: string;
  };
}

export interface StartMessage {
  type: 'start';
  payload: {
    maxParallel: number;
  };
}

export interface PauseMessage {
  type: 'pause';
}

export interface ResumeMessage {
  type: 'resume';
}

export interface StopMessage {
  type: 'stop';
}

export interface SendToWorkerMessage {
  type: 'sendToWorker';
  payload: {
    workerId: number;
    content: string;
  };
}

export interface KillWorkerMessage {
  type: 'killWorker';
  payload: {
    workerId: number;
  };
}

export interface ExportLogsMessage {
  type: 'exportLogs';
}

export interface PingMessage {
  type: 'ping';
  ts: number;
}

export type ClientMessage =
  | LoadFileMessage
  | StartMessage
  | PauseMessage
  | ResumeMessage
  | StopMessage
  | SendToWorkerMessage
  | KillWorkerMessage
  | ExportLogsMessage
  | PingMessage;

// ============================================================
// Recovery / Checkpoint
// ============================================================

export type TaskLogRunStatus = 'completed' | 'interrupted';

export interface RecoveryCheckpoint {
  completedSteps: string[];
  nextStep: string;
}

export interface RecoveryContext {
  taskId: string;
  logDir: string;
  logFile: string;
  logFilePath: string;
  startTime: string;
  endTime: string | null;
  status: TaskLogRunStatus;
  checkpoint: RecoveryCheckpoint;
}
