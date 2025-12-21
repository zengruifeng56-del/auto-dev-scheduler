/**
 * Scheduler Service - 简化版
 * - AUTO-DEV.md 只读，启动时解析一次
 * - 调度器内存管理所有任务状态和锁
 * - 删除 git 同步、文件写入、重复解析、检查点恢复、交付检查
 */

import { EventEmitter } from 'node:events';

import { ClaudeWorker, type ClaudeWorkerConfig } from './claude-worker';
import { LogManager } from './log-manager';
import { inferProjectRoot, parseAutoDevFile } from './parser';
import type {
  LogEntry,
  Progress,
  Task,
  TaskStatus,
  WorkerState
} from '../shared/types';

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
}

export interface WorkerLogPayload {
  workerId: number;
  taskId?: string;
  entry: LogEntry;
}

export interface SchedulerStatePayload {
  running: boolean;
  paused: boolean;
}

export interface WorkerStatePayload {
  workerId: number;
  active: boolean;
  taskId?: string;
  tokenUsage?: string;
  currentTool?: string;
}

export interface SchedulerState {
  running: boolean;
  paused: boolean;
  filePath: string;
  projectRoot: string;
  tasks: Task[];
  workers: WorkerState[];
  progress: Progress;
}

type EventPayload =
  | { type: 'fileLoaded'; payload: FileLoadedPayload }
  | { type: 'taskUpdate'; payload: TaskUpdatePayload }
  | { type: 'workerLog'; payload: WorkerLogPayload }
  | { type: 'progress'; payload: Progress }
  | { type: 'schedulerState'; payload: SchedulerStatePayload }
  | { type: 'workerState'; payload: WorkerStatePayload };

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

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  tickMs: 5_000,
  maxParallel: 4,
  maxWorkerLogs: 1000,
  pendingTaskIdTimeoutMs: 2 * 60_000,  // 2 minutes to detect taskId
};

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

  // Worker state
  private workers = new Map<number, WorkerWrapper>();
  private workerGeneration = 0;

  // Scheduler state
  private running = false;
  private paused = false;
  private maxParallel = 1;

  // Timers
  private tickTimer: NodeJS.Timeout | null = null;

  // Log manager
  private readonly logManager = new LogManager();

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  async loadFile(filePath: string): Promise<void> {
    await this.stop();

    this.filePath = filePath;
    this.projectRoot = inferProjectRoot(filePath);
    this.tasks.clear();
    this.taskLocks.clear();

    const parsed = await parseAutoDevFile(filePath);

    // Initialize tasks: ignore file history status, determine by dependencies
    for (const [id, task] of parsed.tasks) {
      this.tasks.set(id, {
        ...task,
        // Tasks without deps start as 'ready', tasks with deps start as 'pending'
        // (deps can only be satisfied by success in current run)
        status: task.dependencies.length > 0 ? 'pending' : 'ready'
      });
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
  }

  start(maxParallel = 1): void {
    if (this.running) return;
    if (this.tasks.size === 0) return;

    this.maxParallel = Math.min(Math.max(1, maxParallel), CONFIG.maxParallel);
    this.running = true;
    this.paused = false;

    this.emitEvent({ type: 'schedulerState', payload: { running: true, paused: false } });
    this.ensureTickTimer();
    void this.tick('start');
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.emitEvent({ type: 'schedulerState', payload: { running: true, paused: true } });
  }

  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this.emitEvent({ type: 'schedulerState', payload: { running: true, paused: false } });
    void this.tick('resume');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.paused = false;
    this.stopTickTimer();

    // Kill all workers
    const killPromises = [...this.workers.values()].map(async (w) => {
      w.closing = true;
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

    this.emitEvent({ type: 'schedulerState', payload: { running: false, paused: false } });
    this.emitProgress();
  }

  getState(): SchedulerState {
    return {
      running: this.running,
      paused: this.paused,
      filePath: this.filePath,
      projectRoot: this.projectRoot,
      tasks: this.getTaskList(),
      workers: this.getWorkerStates(),
      progress: this.getProgress()
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

    for (const [workerId, wrapper] of this.workers) {
      lines.push(`--- Worker ${workerId} (Task: ${wrapper.taskId ?? wrapper.assignedTaskId}) ---`);
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

  retryTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'failed') return;

    this.setTaskStatus(task, 'ready');
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

    // Deadlock detection: no workers running and no executable tasks
    const activeCount = [...this.workers.values()].filter(w => !w.closing).length;
    const hasExecutable = this.findExecutableTasks().length > 0;
    if (activeCount === 0 && !hasExecutable) {
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
          workerId: task.workerId
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

    const config: ClaudeWorkerConfig = {
      workerId,
      assignedTaskId,
      startupMessage: {
        type: 'user',
        message: { role: 'user', content: `/auto-dev --task ${assignedTaskId}` }
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
        this.setTaskStatus(task, success ? 'success' : 'failed', duration);
        if (!success) {
          this.cascadeFailure(taskId);
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
        this.setTaskStatus(task, 'failed');
        this.cascadeFailure(taskId);
      }
      void this.logManager.endTaskLog(taskId);
      this.unlockTask(taskId);
    }

    this.cleanupWorker(wrapper);
    void this.tick('workerError');
  }

  private cleanupWorker(wrapper: WorkerWrapper): void {
    wrapper.closing = true;
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

  emit(event: 'fileLoaded', msg: { type: 'fileLoaded'; payload: FileLoadedPayload }): boolean;
  emit(event: 'taskUpdate', msg: { type: 'taskUpdate'; payload: TaskUpdatePayload }): boolean;
  emit(event: 'workerLog', msg: { type: 'workerLog'; payload: WorkerLogPayload }): boolean;
  emit(event: 'progress', msg: { type: 'progress'; payload: Progress }): boolean;
  emit(event: 'schedulerState', msg: { type: 'schedulerState'; payload: SchedulerStatePayload }): boolean;
  emit(event: 'workerState', msg: { type: 'workerState'; payload: WorkerStatePayload }): boolean;
}
