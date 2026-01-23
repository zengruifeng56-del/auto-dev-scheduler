/**
 * Scheduler Context
 *
 * Shared state container for scheduler subsystem.
 * Provides typed accessors and internal event bus for module communication.
 */

import { EventEmitter } from 'node:events';
import type {
  AutoRetryConfig,
  Issue,
  LogEntry,
  Task,
  TaskStatus
} from '../../shared/types';
import type { SchedulerPauseReason } from './session-persistence';
import type { IArtifactStore } from '../artifact-store';

// ============================================================================
// Worker Wrapper Type (moved from scheduler-service.ts)
// ============================================================================

export type WorkerKind = 'claude' | 'codex' | 'gemini';

/**
 * Internal worker wrapper for tracking worker state
 */
export interface WorkerWrapper {
  id: number;
  worker: unknown;  // ClaudeWorker | CodexWorker | GeminiWorker
  workerKind: WorkerKind;
  assignedTaskId: string;
  taskId: string;
  logs: LogEntry[];
  startMs: number;
  closing: boolean;
  generation: number;
}

/**
 * Completed worker log archive
 */
export interface CompletedWorkerLog {
  workerId: number;
  taskId: string;
  logs: LogEntry[];
  stopped?: boolean;
}

// ============================================================================
// Internal Event Types
// ============================================================================

export interface TaskStatusChangedEvent {
  taskId: string;
  prevStatus: TaskStatus;
  newStatus: TaskStatus;
  duration?: number;
}

export interface WorkerSpawnedEvent {
  workerId: number;
  taskId: string;
  workerKind: WorkerKind;
}

export interface WorkerCompletedEvent {
  workerId: number;
  taskId: string;
  success: boolean;
  durationMs: number;
}

export interface WorkerErrorEvent {
  workerId: number;
  taskId: string;
  error: Error | string;
}

export interface IssueAddedEvent {
  issue: Issue;
}

export interface ApiErrorEvent {
  errorText: string;
  taskId?: string;
  workerId?: number;
}

// ============================================================================
// Configuration
// ============================================================================

const MAX_COMPLETED_WORKER_LOGS = 100;

const DEFAULT_AUTO_RETRY_CONFIG: AutoRetryConfig = {
  enabled: true,
  maxRetries: 2,
  baseDelayMs: 5_000,
};

const DEFAULT_CONFIG = {
  tickMs: 5_000,
  maxParallel: 4,
  maxWorkerLogs: 1000,
  pendingTaskIdTimeoutMs: 2 * 60_000,
};

// ============================================================================
// SchedulerContext Class
// ============================================================================

export class SchedulerContext {
  // --------------------------------------------------------------------------
  // Core State (Maps)
  // --------------------------------------------------------------------------

  readonly tasks = new Map<string, Task>();
  readonly taskLocks = new Map<string, number>();  // taskId → workerId
  readonly workers = new Map<number, WorkerWrapper>();
  readonly pendingWorkerIds = new Set<number>();  // IDs being spawned but not yet in workers
  readonly issues = new Map<string, Issue>();

  // --------------------------------------------------------------------------
  // File State
  // --------------------------------------------------------------------------

  filePath = '';
  projectRoot = '';

  // --------------------------------------------------------------------------
  // Run State (Phase 4: Artifact integration)
  // --------------------------------------------------------------------------

  runId = '';
  artifactStore: IArtifactStore | null = null;

  // --------------------------------------------------------------------------
  // Scheduler State
  // --------------------------------------------------------------------------

  running = false;
  paused = false;
  pauseReason: SchedulerPauseReason | null = null;
  maxParallel = 1;

  // --------------------------------------------------------------------------
  // Worker State
  // --------------------------------------------------------------------------

  workerGeneration = 0;
  completedWorkerLogs: CompletedWorkerLog[] = [];

  // --------------------------------------------------------------------------
  // Auto-Retry Config
  // --------------------------------------------------------------------------

  autoRetryConfig: AutoRetryConfig = { ...DEFAULT_AUTO_RETRY_CONFIG };

  // --------------------------------------------------------------------------
  // Blocker Auto-Pause
  // --------------------------------------------------------------------------

  blockerAutoPauseEnabled = true;

  // --------------------------------------------------------------------------
  // API Error State
  // --------------------------------------------------------------------------

  apiErrorRetryCount = 0;
  lastApiErrorText: string | null = null;
  apiErrorRetryTimer: NodeJS.Timeout | null = null;

  // --------------------------------------------------------------------------
  // Internal Event Bus
  // --------------------------------------------------------------------------

  /**
   * Internal event bus for module-to-module communication.
   * NOT for external listeners - use Scheduler's EventEmitter for that.
   */
  readonly internalEvents = new EventEmitter();

  // --------------------------------------------------------------------------
  // Static Config
  // --------------------------------------------------------------------------

  readonly config = { ...DEFAULT_CONFIG };

  // --------------------------------------------------------------------------
  // Task Accessors
  // --------------------------------------------------------------------------

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  getAllTasks(): Task[] {
    return [...this.tasks.values()];
  }

  getTasksSorted(): Task[] {
    return this.getAllTasks().sort((a, b) => {
      if (a.wave !== b.wave) return a.wave - b.wave;
      return a.id.localeCompare(b.id);
    });
  }

  isTaskLocked(taskId: string): boolean {
    return this.taskLocks.has(taskId);
  }

  getTaskLockOwner(taskId: string): number | undefined {
    return this.taskLocks.get(taskId);
  }

  // --------------------------------------------------------------------------
  // Worker Accessors
  // --------------------------------------------------------------------------

  getWorker(workerId: number): WorkerWrapper | undefined {
    return this.workers.get(workerId);
  }

  getAllWorkers(): WorkerWrapper[] {
    return [...this.workers.values()];
  }

  getActiveWorkers(): WorkerWrapper[] {
    return this.getAllWorkers().filter(w => !w.closing);
  }

  getActiveWorkerCount(): number {
    return this.getActiveWorkers().length + this.pendingWorkerIds.size;
  }

  nextWorkerId(): number {
    const usedIds = new Set<number>([...this.workers.keys(), ...this.pendingWorkerIds]);
    for (let i = 1; i <= this.config.maxParallel; i++) {
      if (!usedIds.has(i)) return i;
    }
    return this.config.maxParallel + 1;
  }

  /**
   * Reserve a worker ID synchronously to prevent race conditions.
   * Must call releaseWorkerId() after worker is registered or spawn fails.
   */
  reserveWorkerId(): number {
    const workerId = this.nextWorkerId();
    this.pendingWorkerIds.add(workerId);
    return workerId;
  }

  /**
   * Release a reserved worker ID (called after workers.set or on spawn failure)
   */
  releaseWorkerId(workerId: number): void {
    this.pendingWorkerIds.delete(workerId);
  }

  /**
   * Clear all workers and pending IDs (used on stop)
   */
  clearWorkers(): void {
    this.workers.clear();
    this.pendingWorkerIds.clear();
  }

  nextGeneration(): number {
    return ++this.workerGeneration;
  }

  // --------------------------------------------------------------------------
  // Issue Accessors
  // --------------------------------------------------------------------------

  getIssue(issueId: string): Issue | undefined {
    return this.issues.get(issueId);
  }

  getAllIssues(): Issue[] {
    return [...this.issues.values()];
  }

  // --------------------------------------------------------------------------
  // State Reset
  // --------------------------------------------------------------------------

  /**
   * Reset state for loading a new file.
   * Does NOT clear workers (caller should stop scheduler first).
   */
  resetForNewFile(): void {
    this.tasks.clear();
    this.taskLocks.clear();
    this.issues.clear();
    this.clearWorkers();
    this.completedWorkerLogs = [];
    this.filePath = '';
    this.projectRoot = '';
    this.runId = '';
    this.artifactStore = null;
    this.running = false;
    this.paused = false;
    this.pauseReason = null;
    this.apiErrorRetryCount = 0;
    this.lastApiErrorText = null;
    this.clearApiErrorRetryTimer();
  }

  /**
   * Clear API error retry timer
   */
  clearApiErrorRetryTimer(): void {
    if (this.apiErrorRetryTimer) {
      clearTimeout(this.apiErrorRetryTimer);
      this.apiErrorRetryTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // Internal Event Helpers
  // --------------------------------------------------------------------------

  emitTaskStatusChanged(event: TaskStatusChangedEvent): void {
    this.internalEvents.emit('task:statusChanged', event);
  }

  emitWorkerSpawned(event: WorkerSpawnedEvent): void {
    this.internalEvents.emit('worker:spawned', event);
  }

  emitWorkerCompleted(event: WorkerCompletedEvent): void {
    this.internalEvents.emit('worker:completed', event);
  }

  emitWorkerError(event: WorkerErrorEvent): void {
    this.internalEvents.emit('worker:error', event);
  }

  emitIssueAdded(event: IssueAddedEvent): void {
    this.internalEvents.emit('issue:added', event);
  }

  emitApiError(event: ApiErrorEvent): void {
    this.internalEvents.emit('apiError', event);
  }
}

// ============================================================================
// Event Augmentation for Type Safety
// ============================================================================

export interface SchedulerContext {
  // Internal event listeners (for module communication)
  onTaskStatusChanged(listener: (event: TaskStatusChangedEvent) => void): void;
  onWorkerSpawned(listener: (event: WorkerSpawnedEvent) => void): void;
  onWorkerCompleted(listener: (event: WorkerCompletedEvent) => void): void;
  onWorkerError(listener: (event: WorkerErrorEvent) => void): void;
  onIssueAdded(listener: (event: IssueAddedEvent) => void): void;
  onApiError(listener: (event: ApiErrorEvent) => void): void;
}

// Implement listener registration
SchedulerContext.prototype.onTaskStatusChanged = function(listener) {
  this.internalEvents.on('task:statusChanged', listener);
};

SchedulerContext.prototype.onWorkerSpawned = function(listener) {
  this.internalEvents.on('worker:spawned', listener);
};

SchedulerContext.prototype.onWorkerCompleted = function(listener) {
  this.internalEvents.on('worker:completed', listener);
};

SchedulerContext.prototype.onWorkerError = function(listener) {
  this.internalEvents.on('worker:error', listener);
};

SchedulerContext.prototype.onIssueAdded = function(listener) {
  this.internalEvents.on('issue:added', listener);
};

SchedulerContext.prototype.onApiError = function(listener) {
  this.internalEvents.on('apiError', listener);
};
