/**
 * Scheduler Service
 * - AUTO-DEV.md 启动时解析，任务完成时更新 checkbox 状态
 * - 调度器内存管理所有任务状态和锁
 * - 文件写入队列确保并发安全
 */

import { EventEmitter } from 'node:events';

import { createHash } from 'node:crypto';

import { ClaudeWorker, type ClaudeWorkerConfig, type RawIssueReport } from './claude-worker';
import { updateTaskCheckbox } from './file-writer';
import { LogManager } from './log-manager';
import { inferProjectRoot, parseAutoDevFile } from './parser';
import {
  SchedulerSessionStore,
  type SchedulerSessionSnapshot,
  type SchedulerPauseReason
} from './scheduler-session-store';
import type {
  AutoRetryConfig,
  Issue,
  IssueStatus,
  LogEntry,
  Progress,
  Task,
  TaskStatus,
  WorkerState
} from '../shared/types';

export type { SchedulerPauseReason } from './scheduler-session-store';

// ============================================================================
// Event Payload Types
// ============================================================================

export interface FileLoadedPayload {
  filePath: string;
  projectRoot: string;
  tasks: Task[];
}

export interface TaskUpdatePayload {
  taskId: string;
  status: TaskStatus;
  duration?: number;
  workerId?: number;
  retryCount?: number;
  nextRetryAt?: number | null;
}

export interface WorkerLogPayload {
  workerId: number;
  taskId?: string;
  entry: LogEntry;
}

export interface SchedulerStatePayload {
  running: boolean;
  paused: boolean;
  pausedReason?: SchedulerPauseReason | null;
}

export interface WorkerStatePayload {
  workerId: number;
  active: boolean;
  taskId?: string;
  tokenUsage?: string;
  currentTool?: string;
}

export interface IssueReportedPayload {
  issue: Issue;
}

export interface IssueUpdatePayload {
  issueId: string;
  status: IssueStatus;
}

export interface SchedulerState {
  running: boolean;
  paused: boolean;
  pausedReason?: SchedulerPauseReason | null;
  filePath: string;
  projectRoot: string;
  tasks: Task[];
  workers: WorkerState[];
  progress: Progress;
  issues: Issue[];
}

export interface BlockerAutoPausePayload {
  issue: Issue;
  openBlockers: number;
}

type EventPayload =
  | { type: 'fileLoaded'; payload: FileLoadedPayload }
  | { type: 'taskUpdate'; payload: TaskUpdatePayload }
  | { type: 'workerLog'; payload: WorkerLogPayload }
  | { type: 'progress'; payload: Progress }
  | { type: 'schedulerState'; payload: SchedulerStatePayload }
  | { type: 'workerState'; payload: WorkerStatePayload }
  | { type: 'issueReported'; payload: IssueReportedPayload }
  | { type: 'issueUpdate'; payload: IssueUpdatePayload }
  | { type: 'blockerAutoPause'; payload: BlockerAutoPausePayload };

// ============================================================================
// Worker Wrapper
// ============================================================================

interface WorkerWrapper {
  id: number;
  worker: ClaudeWorker;
  assignedTaskId: string;
  taskId: string;  // Current task (= assignedTaskId by default)
  logs: LogEntry[];
  startMs: number;
  closing: boolean;
  generation: number;
}

interface CompletedWorkerLog {
  workerId: number;
  taskId: string;
  logs: LogEntry[];
  stopped?: boolean;  // true if stopped manually, false/undefined if completed normally
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  tickMs: 5_000,
  maxParallel: 4,
  maxWorkerLogs: 1000,
  pendingTaskIdTimeoutMs: 2 * 60_000,  // 2 minutes to detect taskId
};

const DEFAULT_AUTO_RETRY_CONFIG: AutoRetryConfig = {
  enabled: true,
  maxRetries: 2,
  baseDelayMs: 5_000,
};

const AUTO_RETRY_MAX_DELAY_MS = 5 * 60_000;  // 5 minutes cap

// ============================================================================
// Scheduler Class
// ============================================================================

export class Scheduler extends EventEmitter {
  // File state
  private filePath = '';
  private projectRoot = '';

  // Task state (in-memory management)
  private tasks = new Map<string, Task>();
  private taskLocks = new Map<string, number>();  // taskId → workerId

  // Issue state (deduplicated by signature/title+files)
  private issues = new Map<string, Issue>();  // dedupKey → Issue

  // Worker state
  private workers = new Map<number, WorkerWrapper>();
  private workerGeneration = 0;
  private completedWorkerLogs: CompletedWorkerLog[] = [];

  // Scheduler state
  private running = false;
  private paused = false;
  private maxParallel = 1;

  // Timers
  private tickTimer: NodeJS.Timeout | null = null;

  // Log manager
  private readonly logManager = new LogManager();

  // Auto-retry config
  private autoRetryConfig: AutoRetryConfig = { ...DEFAULT_AUTO_RETRY_CONFIG };

  // Blocker auto-pause
  private blockerAutoPauseEnabled = true;
  private pauseReason: SchedulerPauseReason | null = null;

  // Session persistence
  private readonly sessionStore = new SchedulerSessionStore();
  private persistTimer: NodeJS.Timeout | null = null;
  private persistNonce = 0;

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  async loadFile(filePath: string, options: { ignoreSession?: boolean } = {}): Promise<void> {
    await this.stop();

    this.persistNonce++;
    this.clearPersistTimer();

    this.filePath = filePath;
    this.projectRoot = inferProjectRoot(filePath);
    this.tasks.clear();
    this.taskLocks.clear();
    this.issues.clear();
    this.completedWorkerLogs = [];

    const parsed = await parseAutoDevFile(filePath);

    // Initialize tasks: respect terminal states (success/failed) from file, recalculate others
    for (const [id, task] of parsed.tasks) {
      const status = task.status === 'success' || task.status === 'failed'
        ? task.status
        : 'pending';
      this.tasks.set(id, { ...task, status });
    }

    // Update tasks whose dependencies are already satisfied to 'ready'
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' && this.canExecute(task, this.tasks)) {
        task.status = 'ready';
      }
    }

    // Hydrate from session store (issues, task runtime state)
    if (!options.ignoreSession) {
      await this.hydrateFromSessionStore();
    }

    this.emitEvent({
      type: 'fileLoaded',
      payload: {
        filePath: this.filePath,
        projectRoot: this.projectRoot,
        tasks: this.getTaskList()
      }
    });

    this.emitProgress();
    this.requestPersist('loadFile');
  }

  start(maxParallel = 1): void {
    if (this.running) return;
    if (this.tasks.size === 0) return;

    this.maxParallel = Math.min(Math.max(1, maxParallel), CONFIG.maxParallel);
    this.running = true;
    this.paused = false;
    this.pauseReason = null;

    this.emitEvent({ type: 'schedulerState', payload: { running: true, paused: false, pausedReason: null } });
    this.requestPersist('start');
    this.ensureTickTimer();
    void this.tick('start');
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.pauseReason = 'user';
    this.emitEvent({ type: 'schedulerState', payload: { running: true, paused: true, pausedReason: 'user' } });
    this.requestPersist('pause');
  }

  resume(): void {
    if (!this.running || !this.paused) return;

    // Check for open blockers before resuming
    if (this.blockerAutoPauseEnabled && this.getOpenBlockers().length > 0) {
      this.pauseReason = 'blocker';
      this.emitEvent({ type: 'schedulerState', payload: { running: true, paused: true, pausedReason: 'blocker' } });
      return;
    }

    this.paused = false;
    this.pauseReason = null;
    this.emitEvent({ type: 'schedulerState', payload: { running: true, paused: false, pausedReason: null } });
    this.requestPersist('resume');
    void this.tick('resume');
  }

  async stop(): Promise<void> {
    this.clearPersistTimer();
    this.running = false;
    this.paused = false;
    this.pauseReason = null;
    this.stopTickTimer();

    // Archive logs and kill all workers
    const killPromises = [...this.workers.values()].map(async (w) => {
      w.closing = true;
      // Archive logs before killing (mark as stopped)
      this.completedWorkerLogs.push({
        workerId: w.id,
        taskId: w.taskId,
        logs: [...w.logs],
        stopped: true
      });
      try {
        await w.worker.kill();
      } catch { /* ignore */ }
    });
    await Promise.all(killPromises);

    // Release all locks and reset running tasks to ready
    for (const [taskId] of this.taskLocks) {
      const task = this.tasks.get(taskId);
      if (task && task.status === 'running') {
        this.setTaskStatus(task, 'ready');
      }
    }
    this.taskLocks.clear();
    this.workers.clear();

    this.emitEvent({ type: 'schedulerState', payload: { running: false, paused: false, pausedReason: null } });
    this.emitProgress();
    await this.persistNow('stop');
  }

  getState(): SchedulerState {
    return {
      running: this.running,
      paused: this.paused,
      pausedReason: this.pauseReason,
      filePath: this.filePath,
      projectRoot: this.projectRoot,
      tasks: this.getTaskList(),
      workers: this.getWorkerStates(),
      progress: this.getProgress(),
      issues: this.getIssueList()
    };
  }

  async sendToWorker(workerId: number, content: string): Promise<void> {
    const wrapper = this.workers.get(workerId);
    if (!wrapper) throw new Error(`Worker ${workerId} not found`);

    wrapper.worker.send({
      type: 'user',
      message: { role: 'user', content }
    });
  }

  async killWorker(workerId: number): Promise<void> {
    const wrapper = this.workers.get(workerId);
    if (!wrapper) return;

    wrapper.closing = true;
    const taskId = wrapper.taskId;

    // Release lock and reset task to ready if this worker owns it
    if (this.taskLocks.get(taskId) === workerId) {
      const task = this.tasks.get(taskId);
      if (task && task.status === 'running') {
        this.setTaskStatus(task, 'ready');
      }
      this.unlockTask(taskId);
    }

    void this.logManager.endTaskLog(taskId);
    this.cleanupWorker(wrapper);

    try {
      await wrapper.worker.kill();
    } catch { /* ignore */ }

    if (this.running) {
      void this.tick('killWorker');
    }
  }

  exportLogs(): string {
    const lines: string[] = [];
    lines.push(`=== Auto-Dev Scheduler Logs ===`);
    lines.push(`File: ${this.filePath}`);
    lines.push(`Project: ${this.projectRoot}`);
    lines.push(`Exported: ${new Date().toISOString()}`);
    lines.push('');

    for (const completed of this.completedWorkerLogs) {
      const status = completed.stopped ? 'stopped' : 'completed';
      lines.push(`--- Worker ${completed.workerId} (Task: ${completed.taskId}) [${status}] ---`);
      for (const entry of completed.logs) {
        lines.push(`[${entry.ts}] [${entry.type}] ${entry.content}`);
      }
      lines.push('');
    }

    for (const [workerId, wrapper] of this.workers) {
      lines.push(`--- Worker ${workerId} (Task: ${wrapper.taskId}) [active] ---`);
      for (const entry of wrapper.logs) {
        lines.push(`[${entry.ts}] [${entry.type}] ${entry.content}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  async clearTaskLogs(taskId: string): Promise<void> {
    await this.logManager.clearTaskLogs(taskId);
  }

  getAutoRetryConfig(): AutoRetryConfig {
    return { ...this.autoRetryConfig };
  }

  updateAutoRetryConfig(partial: Partial<AutoRetryConfig>): void {
    if (partial.enabled !== undefined) {
      this.autoRetryConfig.enabled = Boolean(partial.enabled);
    }
    if (partial.maxRetries !== undefined && Number.isFinite(partial.maxRetries)) {
      this.autoRetryConfig.maxRetries = Math.max(0, Math.min(10, Math.floor(partial.maxRetries)));
    }
    if (partial.baseDelayMs !== undefined && Number.isFinite(partial.baseDelayMs)) {
      // Match UI: 1-300 seconds (1000-300000ms)
      this.autoRetryConfig.baseDelayMs = Math.max(1000, Math.min(300_000, Math.floor(partial.baseDelayMs)));
    }
  }

  retryTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'failed') return;

    // Reset auto-retry state on manual retry
    task.retryCount = 0;
    task.nextRetryAt = undefined;

    const nextStatus = this.canExecute(task, this.tasks) ? 'ready' : 'pending';
    this.setTaskStatus(task, nextStatus);
    this.cascadeReset(taskId);

    if (this.running) {
      void this.tick('retryTask');
    }
  }

  // --------------------------------------------------------------------------
  // Tick Loop
  // --------------------------------------------------------------------------

  private async tick(_reason: string): Promise<void> {
    if (!this.running) return;

    // Promote tasks whose retry delay has elapsed
    this.promoteDueRetries();

    // Update pending tasks that now have deps satisfied
    this.updatePendingTasks();

    // Check if all done
    if (this.isAllTasksSuccess()) {
      this.running = false;
      this.stopTickTimer();
      this.emitEvent({ type: 'schedulerState', payload: { running: false, paused: false } });
      this.emitProgress();
      return;
    }

    // Deadlock detection: no workers running, no executable tasks, and no pending retries
    const activeCount = [...this.workers.values()].filter(w => !w.closing).length;
    const hasExecutable = this.findExecutableTasks().length > 0;
    const hasPendingRetries = this.hasPendingRetries();
    if (activeCount === 0 && !hasExecutable && !hasPendingRetries) {
      this.running = false;
      this.stopTickTimer();
      this.emitEvent({ type: 'schedulerState', payload: { running: false, paused: false } });
      this.emitProgress();
      return;
    }

    if (!this.paused) {
      // Handle workers that haven't detected taskId
      this.handlePendingWorkerTimeouts();

      // Start new workers if needed
      this.startWorkersIfNeeded();
    }

    this.emitProgress();
  }

  private ensureTickTimer(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      void this.tick('timer');
    }, CONFIG.tickMs);
    this.tickTimer.unref?.();
  }

  private stopTickTimer(): void {
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  // --------------------------------------------------------------------------
  // Task Management
  // --------------------------------------------------------------------------

  private canExecute(task: Task, allTasks: Map<string, Task>): boolean {
    if (!task.dependencies || task.dependencies.length === 0) return true;
    return task.dependencies.every(depId => {
      const dep = allTasks.get(depId);
      return dep && dep.status === 'success';
    });
  }

  private updatePendingTasks(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' && this.canExecute(task, this.tasks)) {
        this.setTaskStatus(task, 'ready');
      }
    }
  }

  // --------------------------------------------------------------------------
  // Auto-Retry Logic
  // --------------------------------------------------------------------------

  private computeRetryDelayMs(retryCount: number): number {
    const base = this.autoRetryConfig.baseDelayMs;
    const attempt = Math.max(1, retryCount);
    // Exponential backoff: base * 2^(attempt-1)
    const backoff = base * Math.pow(2, attempt - 1);
    // Random jitter: 0 ~ base
    const jitter = Math.floor(Math.random() * base);
    const delayMs = backoff + jitter;
    // Cap at max delay
    return Math.min(AUTO_RETRY_MAX_DELAY_MS, delayMs);
  }

  private handleTaskFailure(task: Task, duration?: number): { scheduled: boolean; delayMs?: number } {
    const currentRetryCount = task.retryCount ?? 0;
    const canRetry =
      this.autoRetryConfig.enabled &&
      this.autoRetryConfig.maxRetries > 0 &&
      currentRetryCount < this.autoRetryConfig.maxRetries;

    if (canRetry) {
      const nextRetryCount = currentRetryCount + 1;
      task.retryCount = nextRetryCount;
      const delayMs = this.computeRetryDelayMs(nextRetryCount);
      task.nextRetryAt = Date.now() + delayMs;
      this.setTaskStatus(task, 'failed', duration);
      // Do not cascade failure - retry is scheduled
      return { scheduled: true, delayMs };
    }

    // Retry exhausted - cascade failure
    task.nextRetryAt = undefined;
    this.setTaskStatus(task, 'failed', duration);
    this.cascadeFailure(task.id);
    return { scheduled: false };
  }

  private promoteDueRetries(): void {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (task.status !== 'failed') continue;
      if (task.nextRetryAt === undefined) continue;
      if (task.nextRetryAt > now) continue;
      // Check not locked by another worker
      if (this.taskLocks.has(task.id)) continue;

      // Due for retry - promote to ready or pending
      task.nextRetryAt = undefined;
      const nextStatus = this.canExecute(task, this.tasks) ? 'ready' : 'pending';
      this.setTaskStatus(task, nextStatus);
    }
  }

  private hasPendingRetries(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === 'failed' && task.nextRetryAt !== undefined) {
        return true;
      }
    }
    return false;
  }

  private cascadeFailure(failedTaskId: string): void {
    const queue: string[] = [failedTaskId];
    const visited = new Set(queue);

    while (queue.length > 0) {
      const currentId = queue.shift()!;

      for (const task of this.tasks.values()) {
        if (!task.dependencies?.includes(currentId)) continue;
        if (visited.has(task.id)) continue;

        visited.add(task.id);
        if (task.status !== 'success' && task.status !== 'failed') {
          this.setTaskStatus(task, 'failed');
        }
        queue.push(task.id);
      }
    }
  }

  private cascadeReset(retriedTaskId: string): void {
    const queue: string[] = [retriedTaskId];
    const visited = new Set(queue);

    while (queue.length > 0) {
      const currentId = queue.shift()!;

      for (const task of this.tasks.values()) {
        if (!task.dependencies?.includes(currentId)) continue;
        if (visited.has(task.id)) continue;

        visited.add(task.id);
        if (task.status === 'failed') {
          const nextStatus = this.canExecute(task, this.tasks) ? 'ready' : 'pending';
          this.setTaskStatus(task, nextStatus);
        }
        queue.push(task.id);
      }
    }
  }

  private setTaskStatus(task: Task, status: TaskStatus, duration?: number): void {
    const prev = task.status;
    task.status = status;
    if (duration !== undefined) task.duration = duration;

    if (prev !== status) {
      this.emitEvent({
        type: 'taskUpdate',
        payload: {
          taskId: task.id,
          status,
          duration: task.duration,
          workerId: task.workerId,
          retryCount: task.retryCount ?? 0,
          nextRetryAt: task.nextRetryAt ?? null
        }
      });
    }
  }

  private lockTask(taskId: string, workerId: number): boolean {
    if (this.taskLocks.has(taskId)) return false;
    this.taskLocks.set(taskId, workerId);

    const task = this.tasks.get(taskId);
    if (task) {
      task.workerId = workerId;
      this.setTaskStatus(task, 'running');
    }
    return true;
  }

  private unlockTask(taskId: string): void {
    this.taskLocks.delete(taskId);
    const task = this.tasks.get(taskId);
    if (task) {
      task.workerId = undefined;
    }
  }

  private findExecutableTasks(): Task[] {
    const lockedTaskIds = new Set(this.taskLocks.keys());
    const assignedTaskIds = new Set(
      [...this.workers.values()]
        .filter(w => !w.closing)
        .map(w => w.assignedTaskId)
    );

    // Find incomplete tasks (not success/failed)
    const incompleteTasks = [...this.tasks.values()].filter(
      t => t.status !== 'success' && t.status !== 'failed'
    );
    if (incompleteTasks.length === 0) return [];

    // Determine the active wave (minimum wave among incomplete tasks)
    const activeWave = Math.min(...incompleteTasks.map(t => t.wave));

    // Only return tasks from the active wave
    return incompleteTasks
      .filter(t =>
        t.wave === activeWave &&
        t.status === 'ready' &&
        !lockedTaskIds.has(t.id) &&
        !assignedTaskIds.has(t.id) &&
        this.canExecute(t, this.tasks)
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private isAllTasksSuccess(): boolean {
    if (this.tasks.size === 0) return false;
    return [...this.tasks.values()].every(t => t.status === 'success');
  }

  // --------------------------------------------------------------------------
  // Worker Management
  // --------------------------------------------------------------------------

  private startWorkersIfNeeded(): void {
    const activeCount = [...this.workers.values()].filter(w => !w.closing).length;
    const slotsAvailable = this.maxParallel - activeCount;
    if (slotsAvailable <= 0) return;

    const executable = this.findExecutableTasks();
    const toStart = executable.slice(0, slotsAvailable);

    for (const task of toStart) {
      const workerId = this.nextWorkerId();
      void this.spawnWorker(workerId, task.id);
    }
  }

  private nextWorkerId(): number {
    const usedIds = new Set(this.workers.keys());
    for (let i = 1; i <= CONFIG.maxParallel; i++) {
      if (!usedIds.has(i)) return i;
    }
    return CONFIG.maxParallel + 1;
  }

  private async spawnWorker(workerId: number, assignedTaskId: string): Promise<void> {
    const generation = ++this.workerGeneration;

    // Lock task immediately to prevent duplicate scheduling
    if (!this.lockTask(assignedTaskId, workerId)) return;

    // Build startup message, inject issues for integration tasks
    let startupContent = `/auto-dev --task ${assignedTaskId} --file "${this.filePath}"`;

    if (this.isIntegrationTask(assignedTaskId)) {
      const openIssues = this.getOpenIssues();
      if (openIssues.length > 0) {
        const issuesSummary = this.formatIssuesForInjection(openIssues);
        startupContent = `${startupContent}\n\n${issuesSummary}`;
      }
    }

    const config: ClaudeWorkerConfig = {
      workerId,
      assignedTaskId,
      startupMessage: {
        type: 'user',
        message: { role: 'user', content: startupContent }
      },
      autoKillOnComplete: true
    };

    const worker = new ClaudeWorker(config);

    const wrapper: WorkerWrapper = {
      id: workerId,
      worker,
      assignedTaskId,
      taskId: assignedTaskId,  // Set to assignedTaskId immediately
      logs: [],
      startMs: Date.now(),
      closing: false,
      generation
    };

    this.workers.set(workerId, wrapper);
    this.attachWorkerEvents(wrapper, generation);

    // Start task logging
    void this.logManager.startTaskLog(assignedTaskId);

    // Emit initial worker state
    this.emitWorkerState(wrapper);

    try {
      await worker.start(this.projectRoot);
    } catch (err) {
      this.handleWorkerError(wrapper, err);
    }
  }

  private attachWorkerEvents(wrapper: WorkerWrapper, generation: number): void {
    const { worker, id: workerId } = wrapper;

    const isStale = (): boolean => this.workers.get(workerId)?.generation !== generation;

    worker.on('log', (entry) => {
      if (isStale()) return;

      wrapper.logs.push(entry);
      if (wrapper.logs.length > CONFIG.maxWorkerLogs) {
        wrapper.logs = wrapper.logs.slice(-CONFIG.maxWorkerLogs);
      }

      const taskId = wrapper.taskId;
      this.emitEvent({
        type: 'workerLog',
        payload: { workerId, taskId, entry }
      });

      // Persist log
      void this.logManager.appendLog(taskId, entry);

      // Emit worker state updates
      this.emitWorkerState(wrapper);
    });

    worker.on('taskDetected', (detectedTaskId) => {
      if (isStale()) return;

      // Since taskId is now set to assignedTaskId at spawn, only handle mismatch
      if (detectedTaskId !== wrapper.assignedTaskId) {
        const entry: LogEntry = {
          ts: new Date().toISOString().slice(11, 19),
          type: 'error',
          content: `Task mismatch: assigned=${wrapper.assignedTaskId}, detected=${detectedTaskId}`
        };
        wrapper.logs.push(entry);
        this.emitEvent({
          type: 'workerLog',
          payload: { workerId, taskId: wrapper.assignedTaskId, entry }
        });
        void this.logManager.appendLog(wrapper.assignedTaskId, entry);
        void this.killWorker(workerId);
      }
    });

    worker.on('complete', (success, durationMs) => {
      if (isStale()) return;

      const taskId = wrapper.taskId;

      // If lock already released (stop/kill), ignore late completion
      if (this.taskLocks.get(taskId) !== workerId) {
        void this.logManager.endTaskLog(taskId);
        this.cleanupWorker(wrapper);
        void this.tick('workerComplete');
        return;
      }

      const task = this.tasks.get(taskId);
      if (task) {
        const duration = Math.round(durationMs / 1000);
        if (success) {
          // Clear retry state on success
          task.retryCount = 0;
          task.nextRetryAt = undefined;
          this.setTaskStatus(task, 'success', duration);
          // Update checkbox in AUTO-DEV.md (queued for thread safety)
          void updateTaskCheckbox(this.filePath, taskId, true).catch(err => {
            console.error(`[Scheduler] Failed to update checkbox for ${taskId}:`, err);
          });
        } else {
          const result = this.handleTaskFailure(task, duration);
          if (result.scheduled) {
            const entry: LogEntry = {
              ts: new Date().toISOString().slice(11, 19),
              type: 'system',
              content: `Auto-retry scheduled (${task.retryCount}/${this.autoRetryConfig.maxRetries}) in ${Math.round(result.delayMs! / 1000)}s`
            };
            wrapper.logs.push(entry);
            this.emitEvent({
              type: 'workerLog',
              payload: { workerId, taskId, entry }
            });
            void this.logManager.appendLog(taskId, entry);
          }
        }
      }

      // End task logging
      void this.logManager.endTaskLog(taskId);

      // Release lock
      this.unlockTask(taskId);

      // Cleanup worker
      this.cleanupWorker(wrapper);

      // Trigger next tick
      void this.tick('workerComplete');
    });

    worker.on('error', (err) => {
      if (isStale()) return;
      this.handleWorkerError(wrapper, err);
    });

    worker.on('issueReported', (raw, taskId, wId) => {
      if (isStale()) return;
      const reporterTaskId = taskId || wrapper.assignedTaskId;
      const reporterWorkerId = wId ?? workerId;
      this.addIssue(raw, reporterTaskId, reporterWorkerId);
    });
  }

  private handleWorkerError(wrapper: WorkerWrapper, err: unknown): void {
    const taskId = wrapper.taskId;
    const errorMsg = err instanceof Error ? err.message : String(err);

    const entry: LogEntry = {
      ts: new Date().toISOString().slice(11, 19),
      type: 'error',
      content: `Worker error: ${errorMsg}`
    };
    wrapper.logs.push(entry);
    this.emitEvent({
      type: 'workerLog',
      payload: { workerId: wrapper.id, taskId, entry }
    });
    void this.logManager.appendLog(taskId, entry);

    // Mark task as failed only if this worker still owns the lock
    if (this.taskLocks.get(taskId) === wrapper.id) {
      const task = this.tasks.get(taskId);
      if (task && task.status === 'running') {
        const duration = Math.round((Date.now() - wrapper.startMs) / 1000);
        this.handleTaskFailure(task, duration);
      }
      void this.logManager.endTaskLog(taskId);
      this.unlockTask(taskId);
    }

    this.cleanupWorker(wrapper);
    void this.tick('workerError');
  }

  private cleanupWorker(wrapper: WorkerWrapper): void {
    wrapper.closing = true;
    this.completedWorkerLogs.push({
      workerId: wrapper.id,
      taskId: wrapper.taskId,
      logs: [...wrapper.logs]
    });
    this.workers.delete(wrapper.id);

    this.emitEvent({
      type: 'workerState',
      payload: {
        workerId: wrapper.id,
        active: false,
        taskId: wrapper.taskId
      }
    });
  }

  private handlePendingWorkerTimeouts(): void {
    // No longer needed: taskId is set to assignedTaskId at spawn
    // Timeout is now handled by Watchdog (activity timeout)
  }

  // --------------------------------------------------------------------------
  // State Helpers
  // --------------------------------------------------------------------------

  private getTaskList(): Task[] {
    return [...this.tasks.values()].sort((a, b) => {
      if (a.wave !== b.wave) return a.wave - b.wave;
      return a.id.localeCompare(b.id);
    });
  }

  private getWorkerStates(): WorkerState[] {
    return [...this.workers.values()].map(w => ({
      id: w.id,
      active: !w.closing,
      taskId: w.taskId,
      logs: w.logs,
      tokenUsage: w.worker.currentTokenUsage ?? undefined,
      currentTool: w.worker.currentToolName ?? undefined
    }));
  }

  private getProgress(): Progress {
    const total = this.tasks.size;
    const completed = [...this.tasks.values()].filter(t => t.status === 'success').length;
    return { completed, total };
  }

  // --------------------------------------------------------------------------
  // Issue Management
  // --------------------------------------------------------------------------

  private getIssueList(): Issue[] {
    return [...this.issues.values()].sort((a, b) => {
      // Sort by severity (blocker > error > warning), then by createdAt
      const severityOrder = { blocker: 0, error: 1, warning: 2 };
      const aSev = severityOrder[a.severity] ?? 3;
      const bSev = severityOrder[b.severity] ?? 3;
      if (aSev !== bSev) return aSev - bSev;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  private computeDedupKey(raw: RawIssueReport): string {
    // Use signature if available, otherwise hash title + files (NOT severity)
    if (raw.signature) {
      return createHash('sha1')
        .update(JSON.stringify(['sig', raw.signature.trim()]))
        .digest('hex')
        .slice(0, 12);
    }

    // Normalize files: trim, dedup, sort
    const normalizedFiles = Array.from(
      new Set(raw.files.map(f => f.trim()).filter(f => f.length > 0))
    ).sort();

    return createHash('sha1')
      .update(JSON.stringify(['titleFiles', raw.title.trim(), normalizedFiles]))
      .digest('hex')
      .slice(0, 12);
  }

  private addIssue(raw: RawIssueReport, reporterTaskId: string, reporterWorkerId: number): Issue {
    const dedupKey = this.computeDedupKey(raw);
    const existing = this.issues.get(dedupKey);

    if (existing) {
      // Merge as occurrence: increment count, keep highest severity
      existing.occurrences++;
      const severityOrder = { warning: 0, error: 1, blocker: 2 };
      if (severityOrder[raw.severity] > severityOrder[existing.severity]) {
        existing.severity = raw.severity;
      }

      // Re-open if previously fixed (but keep 'ignored' as ignored)
      if (existing.status === 'fixed') {
        existing.status = 'open';
      }

      // Merge missing optional fields
      if (!existing.ownerTaskId && raw.ownerTaskId) {
        existing.ownerTaskId = raw.ownerTaskId || undefined;
      }
      if (!existing.signature && raw.signature) {
        existing.signature = raw.signature;
      }
      if (!existing.details && raw.details) {
        existing.details = raw.details;
      }

      // Union file lists
      const fileSet = new Set(existing.files.map(f => f.trim()).filter(f => f.length > 0));
      for (const f of raw.files) {
        const trimmed = f.trim();
        if (trimmed) fileSet.add(trimmed);
      }
      existing.files = [...fileSet];

      // Emit upsert so frontend can refresh occurrences/severity
      this.emitEvent({ type: 'issueReported', payload: { issue: existing } });
      return existing;
    }

    // Create new issue with normalized data
    const normalizedFiles = Array.from(
      new Set(raw.files.map(f => f.trim()).filter(f => f.length > 0))
    );

    const issue: Issue = {
      id: dedupKey,
      createdAt: new Date().toISOString(),
      reporterTaskId,
      reporterWorkerId,
      ownerTaskId: raw.ownerTaskId || undefined,
      severity: raw.severity,
      title: raw.title.trim(),
      details: raw.details?.trim() || undefined,
      files: normalizedFiles,
      signature: raw.signature?.trim() || undefined,
      status: 'open',
      occurrences: 1
    };

    this.issues.set(dedupKey, issue);
    this.emitEvent({ type: 'issueReported', payload: { issue } });
    this.requestPersist('issueReported');
    this.handleBlockerAutoPause();
    return issue;
  }

  updateIssueStatus(issueId: string, status: IssueStatus): boolean {
    const issue = this.issues.get(issueId);
    if (!issue) return false;

    issue.status = status;
    this.emitEvent({ type: 'issueUpdate', payload: { issueId, status } });
    this.requestPersist('issueUpdate');
    return true;
  }

  getOpenIssues(): Issue[] {
    return [...this.issues.values()].filter(i => i.status === 'open');
  }

  getOpenBlockers(): Issue[] {
    return this.getOpenIssues().filter(i => i.severity === 'blocker');
  }

  private isIntegrationTask(taskId: string): boolean {
    const id = taskId.toUpperCase();
    // Match: INT-*, INTEGRATION*, FIX-WAVE*, or exact "INTEGRATION"
    return (
      id.startsWith('INT-') ||
      id.startsWith('INTEGRATION') ||
      id.startsWith('FIX-WAVE') ||
      id === 'INTEGRATION'
    );
  }

  private formatIssuesForInjection(issues: Issue[]): string {
    const lines: string[] = [
      '---',
      '## 📋 Collected Issues Report (Auto-injected)',
      '',
      `Total: ${issues.length} open issue(s) to address.`,
      ''
    ];

    // Group by severity
    const blockers = issues.filter(i => i.severity === 'blocker');
    const errors = issues.filter(i => i.severity === 'error');
    const warnings = issues.filter(i => i.severity === 'warning');

    if (blockers.length > 0) {
      lines.push('### 🚨 Blockers (Must Fix)');
      for (const issue of blockers) {
        lines.push(this.formatSingleIssue(issue));
      }
      lines.push('');
    }

    if (errors.length > 0) {
      lines.push('### ❌ Errors');
      for (const issue of errors) {
        lines.push(this.formatSingleIssue(issue));
      }
      lines.push('');
    }

    if (warnings.length > 0) {
      lines.push('### ⚠️ Warnings');
      for (const issue of warnings) {
        lines.push(this.formatSingleIssue(issue));
      }
      lines.push('');
    }

    lines.push('---');
    return lines.join('\n');
  }

  private formatSingleIssue(issue: Issue): string {
    const files = issue.files.length > 0 ? ` (${issue.files.join(', ')})` : '';
    const owner = issue.ownerTaskId ? ` [Owner: ${issue.ownerTaskId}]` : '';
    const details = issue.details ? `\n  Details: ${issue.details}` : '';
    return `- **${issue.title}**${files}${owner}${details}`;
  }

  // --------------------------------------------------------------------------
  // Session Persistence
  // --------------------------------------------------------------------------

  private clearPersistTimer(): void {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
  }

  private requestPersist(reason: string): void {
    if (!this.filePath) return;
    if (this.persistTimer) return;

    const nonce = this.persistNonce;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (nonce !== this.persistNonce) return;
      void this.persistNow(`debounce:${reason}`);
    }, 750);
    this.persistTimer.unref?.();
  }

  private async persistNow(reason: string): Promise<void> {
    if (!this.filePath) return;

    const snapshot = this.buildSessionSnapshot();
    try {
      await this.sessionStore.writeSnapshot(this.filePath, snapshot);
    } catch (err) {
      console.error(`[Scheduler] Failed to persist session (${reason}):`, err);
    }
  }

  private buildSessionSnapshot(): SchedulerSessionSnapshot {
    const taskStates: SchedulerSessionSnapshot['taskStates'] = {};
    for (const task of this.tasks.values()) {
      taskStates[task.id] = {
        status: task.status,
        duration: task.duration,
        startTime: task.startTime,
        endTime: task.endTime,
        retryCount: task.retryCount,
        nextRetryAt: task.nextRetryAt
      };
    }

    return {
      version: 1,
      savedAt: new Date().toISOString(),
      filePath: this.filePath,
      projectRoot: this.projectRoot,
      paused: this.paused,
      pausedReason: this.pauseReason,
      autoRetryConfig: { ...this.autoRetryConfig },
      blockerAutoPauseEnabled: this.blockerAutoPauseEnabled,
      taskStates,
      issues: [...this.issues.values()]
    };
  }

  private async hydrateFromSessionStore(): Promise<void> {
    if (!this.filePath) return;

    let snapshot: SchedulerSessionSnapshot | null = null;
    try {
      snapshot = await this.sessionStore.readSnapshot(this.filePath);
    } catch (err) {
      console.warn('[Scheduler] Failed to read session snapshot:', err);
      return;
    }
    if (!snapshot) return;

    // Verify file path matches (case-insensitive on Windows)
    const sameFile = process.platform === 'win32'
      ? snapshot.filePath.toLowerCase() === this.filePath.toLowerCase()
      : snapshot.filePath === this.filePath;
    if (!sameFile) return;

    // Restore issues
    this.issues.clear();
    for (const issue of snapshot.issues ?? []) {
      if (!issue || typeof issue.id !== 'string') continue;
      this.issues.set(issue.id, issue);
    }

    // Restore task runtime state
    const now = Date.now();
    for (const [taskId, st] of Object.entries(snapshot.taskStates ?? {})) {
      const task = this.tasks.get(taskId);
      if (!task) continue;

      task.duration = st.duration;
      task.startTime = st.startTime;
      task.endTime = st.endTime;
      task.retryCount = st.retryCount;
      task.nextRetryAt = st.nextRetryAt;

      // Promote due retries
      if (task.status === 'failed' && task.nextRetryAt !== undefined && task.nextRetryAt <= now) {
        task.status = this.canExecute(task, this.tasks) ? 'ready' : 'pending';
        task.nextRetryAt = undefined;
      }
    }

    console.log(`[Scheduler] Restored ${this.issues.size} issues from session`);
  }

  // --------------------------------------------------------------------------
  // Blocker Auto-Pause
  // --------------------------------------------------------------------------

  getBlockerAutoPauseEnabled(): boolean {
    return this.blockerAutoPauseEnabled;
  }

  setBlockerAutoPauseEnabled(enabled: boolean): void {
    this.blockerAutoPauseEnabled = enabled;
    this.requestPersist('blockerConfig');

    if (enabled && this.running && !this.paused && this.getOpenBlockers().length > 0) {
      this.handleBlockerAutoPause();
    }
  }

  private handleBlockerAutoPause(): void {
    if (!this.running || !this.blockerAutoPauseEnabled || this.paused) return;

    const blockers = this.getOpenBlockers();
    if (blockers.length === 0) return;

    this.paused = true;
    this.pauseReason = 'blocker';

    this.emitEvent({
      type: 'schedulerState',
      payload: { running: true, paused: true, pausedReason: 'blocker' }
    });

    this.emitEvent({
      type: 'blockerAutoPause',
      payload: { issue: blockers[0]!, openBlockers: blockers.length }
    });

    this.requestPersist('blockerAutoPause');
  }

  // --------------------------------------------------------------------------
  // Event Emission
  // --------------------------------------------------------------------------

  private emitEvent(event: EventPayload): void {
    (this.emit as (event: string, msg: EventPayload) => boolean)(event.type, event);
  }

  private emitProgress(): void {
    this.emitEvent({ type: 'progress', payload: this.getProgress() });
  }

  private emitWorkerState(wrapper: WorkerWrapper): void {
    this.emitEvent({
      type: 'workerState',
      payload: {
        workerId: wrapper.id,
        active: !wrapper.closing,
        taskId: wrapper.taskId,
        tokenUsage: wrapper.worker.currentTokenUsage ?? undefined,
        currentTool: wrapper.worker.currentToolName ?? undefined
      }
    });
  }
}

// ============================================================================
// EventEmitter Type Augmentation
// ============================================================================

export interface Scheduler {
  on(event: 'fileLoaded', listener: (msg: { type: 'fileLoaded'; payload: FileLoadedPayload }) => void): this;
  on(event: 'taskUpdate', listener: (msg: { type: 'taskUpdate'; payload: TaskUpdatePayload }) => void): this;
  on(event: 'workerLog', listener: (msg: { type: 'workerLog'; payload: WorkerLogPayload }) => void): this;
  on(event: 'progress', listener: (msg: { type: 'progress'; payload: Progress }) => void): this;
  on(event: 'schedulerState', listener: (msg: { type: 'schedulerState'; payload: SchedulerStatePayload }) => void): this;
  on(event: 'workerState', listener: (msg: { type: 'workerState'; payload: WorkerStatePayload }) => void): this;
  on(event: 'issueReported', listener: (msg: { type: 'issueReported'; payload: IssueReportedPayload }) => void): this;
  on(event: 'issueUpdate', listener: (msg: { type: 'issueUpdate'; payload: IssueUpdatePayload }) => void): this;

  emit(event: 'fileLoaded', msg: { type: 'fileLoaded'; payload: FileLoadedPayload }): boolean;
  emit(event: 'taskUpdate', msg: { type: 'taskUpdate'; payload: TaskUpdatePayload }): boolean;
  emit(event: 'workerLog', msg: { type: 'workerLog'; payload: WorkerLogPayload }): boolean;
  emit(event: 'progress', msg: { type: 'progress'; payload: Progress }): boolean;
  emit(event: 'schedulerState', msg: { type: 'schedulerState'; payload: SchedulerStatePayload }): boolean;
  emit(event: 'workerState', msg: { type: 'workerState'; payload: WorkerStatePayload }): boolean;
  emit(event: 'issueReported', msg: { type: 'issueReported'; payload: IssueReportedPayload }): boolean;
  emit(event: 'issueUpdate', msg: { type: 'issueUpdate'; payload: IssueUpdatePayload }): boolean;
}
