/**
 * Scheduler Service
 * 主进程调度器服务 - 从 server/scheduler.ts 迁移
 */
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ClaudeWorker } from './claude-worker';
import { generateDeliveryReport, isValidChangeId, parseOpenSpecLink, parseTasksChecklist } from './delivery-check';
import { LogManager } from './log-manager';
import { inferProjectRoot, parseAutoDevFile, type ParseResult } from './parser';

import type {
  DeliveryCheckMessage,
  DeliveryReport,
  FileLoadedMessage,
  LogEntry,
  Progress,
  ProgressMessage,
  RecoveryContext,
  SchedulerFullState,
  SchedulerStateMessage,
  Task,
  TaskStatus,
  TaskUpdateMessage,
  WorkerLogMessage,
  WorkerState,
  WorkerStateMessage
} from '../shared/types';

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string') return new Error(err);
  return new Error(String(err));
}

function formatTime(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function cloneTask(task: Task): Task {
  return { ...task, dependencies: [...task.dependencies] };
}

function arrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

interface WorkerStateSnapshot {
  taskId?: string;
  tokenUsage?: string;
  currentTool?: string;
}

interface WorkerSlot {
  worker: ClaudeWorker;
  logs: LogEntry[];
  active: boolean;
  closing: boolean;
  startedAtMs: number;
  generation: number;
  lastEmitted: WorkerStateSnapshot | null;
}

export interface SchedulerConfig {
  tickMs?: number;
  pendingTaskIdTimeoutMs?: number;
  maxWorkerLogs?: number;
  staleTaskTimeoutMs?: number;
}

export class Scheduler extends EventEmitter {
  private filePath = '';
  private projectRoot = '';

  private running = false;
  private paused = false;
  private maxParallel = 1;

  private waveMap = new Map<string, number>();
  private tasks = new Map<string, Task>();
  private taskStartMs = new Map<string, number>();
  private staleDetectedMs = new Map<string, number>();
  private workers = new Map<number, WorkerSlot>();

  private tickTimer: NodeJS.Timeout | null = null;
  private tickInProgress = false;
  private tickQueued = false;

  private lastProgress: Progress = { completed: 0, total: 0 };
  private lastSchedulerState = { running: false, paused: false };
  private fileWriteQueue: Promise<void> = Promise.resolve();

  private readonly tickMs: number;
  private readonly pendingTaskIdTimeoutMs: number;
  private readonly maxWorkerLogs: number;
  private readonly staleTaskTimeoutMs: number;
  private readonly logManager: LogManager;

  constructor(config: SchedulerConfig = {}) {
    super();
    this.tickMs = config.tickMs ?? 5_000;
    this.pendingTaskIdTimeoutMs = config.pendingTaskIdTimeoutMs ?? 120_000;
    this.maxWorkerLogs = config.maxWorkerLogs ?? 1_000;
    this.staleTaskTimeoutMs = config.staleTaskTimeoutMs ?? 5 * 60_000;
    this.logManager = new LogManager();
  }

  async loadFile(filePath: string): Promise<void> {
    const trimmed = filePath.trim();
    if (!trimmed) throw new Error('loadFile: filePath cannot be empty');

    await this.stop();

    this.workers.clear();
    this.taskStartMs.clear();
    this.tasks.clear();
    this.waveMap.clear();

    const absPath = path.resolve(trimmed);
    this.filePath = absPath;
    this.projectRoot = inferProjectRoot(absPath);

    const parsed = await parseAutoDevFile(absPath);
    this.applyParseResult(parsed, false);

    this.emitFileLoaded();
    this.emitProgressIfChanged(true);
    this.emitSchedulerStateIfChanged(true);
  }

  start(maxParallel: number): void {
    if (!this.filePath) throw new Error('start: call loadFile() first');

    const n = Number.isFinite(maxParallel) ? Math.floor(maxParallel) : 1;
    this.maxParallel = Math.max(1, n);

    this.running = true;
    this.paused = false;
    this.emitSchedulerStateIfChanged(true);
    this.ensureTickTimer();

    void this.tick('start');
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.emitSchedulerStateIfChanged(true);
  }

  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this.emitSchedulerStateIfChanged(true);
    void this.tick('resume');
  }

  async stop(): Promise<void> {
    if (!this.running && !this.paused && !this.tickTimer && this.workers.size === 0) {
      return;
    }

    this.running = false;
    this.paused = false;
    this.emitSchedulerStateIfChanged(true);
    this.clearTickTimer();

    const killPromises: Promise<void>[] = [];
    const logFinalizePromises: Promise<void>[] = [];

    for (const [workerId, slot] of this.workers) {
      slot.active = false;

      const taskId = slot.worker.currentTaskId;
      if (taskId) {
        logFinalizePromises.push(
          this.logManager.appendLog(taskId, {
            ts: formatTime(),
            type: 'system',
            content: 'Scheduler stopped'
          }).catch(() => undefined)
        );
        logFinalizePromises.push(
          this.logManager.endTaskLog(taskId, 'interrupted').catch(() => undefined)
        );
      }

      try { slot.worker.removeAllListeners(); } catch { /* ignore */ }

      killPromises.push(
        slot.worker.kill().catch((err: unknown) => {
          const e = toError(err);
          this.appendWorkerLog(workerId, {
            ts: formatTime(),
            type: 'error',
            content: `Kill failed: ${e.message}`
          });
        })
      );

      this.emitWorkerState(workerId, true);
    }

    await Promise.allSettled([...killPromises, ...logFinalizePromises]);
  }

  getState(): SchedulerFullState {
    return {
      running: this.running,
      paused: this.paused,
      filePath: this.filePath,
      projectRoot: this.projectRoot,
      tasks: this.getSortedTasks(),
      workers: this.getWorkerStates(),
      progress: this.computeProgress()
    };
  }

  getExecutableTasks(): Task[] {
    return this.findExecutableTasks().map(cloneTask);
  }

  async sendToWorker(workerId: number, content: string): Promise<void> {
    const slot = this.workers.get(workerId);
    if (!slot || !slot.active) {
      throw new Error(`Worker ${workerId} not active`);
    }

    const message = { type: 'user', message: { role: 'user', content } };
    slot.worker.send(message);

    this.appendWorkerLog(workerId, {
      ts: formatTime(),
      type: 'system',
      content: `User input: ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}`
    });
  }

  async killWorker(workerId: number): Promise<void> {
    const slot = this.workers.get(workerId);
    if (!slot || !slot.active) return;

    slot.closing = true;
    slot.active = false;
    const taskId = slot.worker.currentTaskId;

    try { slot.worker.removeAllListeners(); } catch { /* ignore */ }

    this.appendWorkerLog(workerId, {
      ts: formatTime(),
      type: 'system',
      content: 'Killed by user'
    });

    try {
      await slot.worker.kill();
    } finally {
      slot.closing = false;
    }
    this.emitWorkerState(workerId, true);

    if (taskId) {
      try {
        await this.logManager.endTaskLog(taskId, 'interrupted');
      } catch (err: unknown) {
        const e = toError(err);
        console.error(`[logs] endTaskLog(${taskId}) failed: ${e.message}`);
      }
    }

    void this.tick('killWorker');
  }

  exportLogs(): string {
    const lines: string[] = [];
    for (const [workerId, slot] of this.workers) {
      const taskId = slot.worker.currentTaskId ?? 'unknown';
      lines.push(`\n=== Worker ${workerId} (${taskId}) ===\n`);
      for (const log of slot.logs) {
        lines.push(`[${log.ts}] [${log.type}] ${log.content}`);
      }
    }
    return lines.join('\n');
  }

  async getRecoveryContext(taskId: string): Promise<RecoveryContext | null> {
    const id = taskId.trim();
    if (!id) throw new Error('getRecoveryContext: taskId cannot be empty');
    return this.logManager.getRecoveryContext(id);
  }

  async clearTaskLogs(taskId: string): Promise<void> {
    const id = taskId.trim();
    if (!id) throw new Error('clearTaskLogs: taskId cannot be empty');
    await this.logManager.clearTaskLogs(id);
  }

  private ensureTickTimer(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      void this.tick('interval');
    }, this.tickMs);
    this.tickTimer.unref?.();
  }

  private clearTickTimer(): void {
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private async tick(reason: string): Promise<void> {
    if (!this.running || !this.filePath) return;

    if (this.tickInProgress) {
      this.tickQueued = true;
      return;
    }

    this.tickInProgress = true;
    try {
      const parsed = await parseAutoDevFile(this.filePath);
      this.applyParseResult(parsed, true);

      const nowMs = Date.now();
      this.reconcileWorkerAndTasks(nowMs);
      this.updateRunningDurations(nowMs);

      if (!this.paused) {
        await this.handlePendingWorkerTimeouts(nowMs);
        this.recoverStaleTasks(nowMs);
      }

      this.emitProgressIfChanged(false);
      if (this.isAllTasksSuccess()) {
        this.running = false;
        this.paused = false;
        this.emitSchedulerStateIfChanged(true);
        this.clearTickTimer();
        void this.runDeliveryCheck();
        return;
      }

      if (!this.paused && this.running) {
        await this.startWorkersIfNeeded(reason);
      }
    } catch (err: unknown) {
      const e = toError(err);
      console.error(`[scheduler] tick(${reason}) failed: ${e.message}`);
    } finally {
      this.tickInProgress = false;
      if (this.tickQueued) {
        this.tickQueued = false;
        void this.tick('queued');
      }
    }
  }

  private applyParseResult(parsed: ParseResult, emitChanged: boolean): void {
    this.waveMap = parsed.waveMap;

    const activeTaskIds = this.getActiveWorkerTaskIds();
    let structureChanged = false;

    const seen = new Set<string>();
    for (const [taskId, parsedTask] of parsed.tasks) {
      seen.add(taskId);

      const existing = this.tasks.get(taskId);
      if (!existing) {
        const fresh = cloneTask(parsedTask);
        if (activeTaskIds.has(taskId) && parsedTask.status !== 'success' && parsedTask.status !== 'failed') {
          fresh.status = 'running';
        }
        this.tasks.set(taskId, fresh);
        structureChanged = true;
        continue;
      }

      if (
        existing.title !== parsedTask.title ||
        existing.wave !== parsedTask.wave ||
        existing.estimatedTokens !== parsedTask.estimatedTokens ||
        !arrayEqual(existing.dependencies, parsedTask.dependencies)
      ) {
        structureChanged = true;
      }

      existing.title = parsedTask.title;
      existing.wave = parsedTask.wave;
      existing.dependencies = [...parsedTask.dependencies];
      existing.estimatedTokens = parsedTask.estimatedTokens;

      let nextStatus: TaskStatus;
      if (parsedTask.status === 'success' || parsedTask.status === 'failed') {
        nextStatus = parsedTask.status;
      } else if (activeTaskIds.has(taskId)) {
        nextStatus = 'running';
      } else {
        nextStatus = parsedTask.status;
      }

      if (existing.status !== nextStatus) {
        this.setTaskStatus(existing, nextStatus);
      } else if (nextStatus === 'running') {
        this.ensureTaskTiming(taskId, existing);
      }
    }

    for (const taskId of this.tasks.keys()) {
      if (seen.has(taskId) || activeTaskIds.has(taskId)) continue;
      this.tasks.delete(taskId);
      this.taskStartMs.delete(taskId);
      this.staleDetectedMs.delete(taskId);
      structureChanged = true;
    }

    if (emitChanged && structureChanged) {
      this.emitFileLoaded();
    }
  }

  private setTaskStatus(task: Task, status: TaskStatus): void {
    if (task.status === status) return;

    task.status = status;

    if (status === 'ready' || status === 'pending') {
      task.workerId = undefined;
      task.startTime = undefined;
      task.endTime = undefined;
      task.duration = undefined;
      this.taskStartMs.delete(task.id);
    }

    if (status === 'running') {
      this.ensureTaskTiming(task.id, task);
    }

    if (status === 'success') {
      if (!task.endTime) task.endTime = new Date().toISOString();
      const startMs = this.taskStartMs.get(task.id);
      if (startMs !== undefined && task.duration === undefined) {
        task.duration = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      }
    }

    this.emitTaskUpdate(task.id, task.status, { duration: task.duration, workerId: task.workerId });
  }

  private ensureTaskTiming(taskId: string, task: Task, startMs?: number): void {
    if (this.taskStartMs.has(taskId)) return;

    const ms = startMs ?? Date.now();
    this.taskStartMs.set(taskId, ms);
    if (!task.startTime) task.startTime = new Date(ms).toISOString();
    if (task.duration === undefined) task.duration = 0;
  }

  private reconcileWorkerAndTasks(nowMs: number): void {
    for (const [workerId, slot] of this.workers) {
      this.emitWorkerState(workerId, false);

      if (!slot.active) continue;

      const taskId = slot.worker.currentTaskId;
      if (!taskId) continue;

      const task = this.getOrCreateTask(taskId);

      if (task.status === 'success' || task.status === 'failed') {
        continue;
      }

      const wasRunning = task.status === 'running';
      task.status = 'running';
      task.workerId = workerId;
      this.ensureTaskTiming(taskId, task, slot.startedAtMs);

      if (!wasRunning) {
        this.emitTaskUpdate(taskId, 'running', { duration: task.duration, workerId });
      }

      if (task.endTime) task.endTime = undefined;
      void nowMs;
    }
  }

  private getOrCreateTask(taskId: string): Task {
    const existing = this.tasks.get(taskId);
    if (existing) return existing;

    const task: Task = {
      id: taskId,
      title: taskId,
      status: 'pending',
      wave: this.waveMap.get(taskId) ?? 99,
      dependencies: []
    };
    this.tasks.set(taskId, task);
    return task;
  }

  private updateRunningDurations(nowMs: number): void {
    for (const task of this.tasks.values()) {
      if (task.status !== 'running') continue;

      this.ensureTaskTiming(task.id, task);
      const startMs = this.taskStartMs.get(task.id);
      if (startMs === undefined) continue;

      const elapsedSec = Math.max(0, Math.floor((nowMs - startMs) / 1000));
      if (task.duration !== elapsedSec) {
        task.duration = elapsedSec;
        this.emitTaskUpdate(task.id, 'running', { duration: elapsedSec, workerId: task.workerId });
      }
    }
  }

  private async handlePendingWorkerTimeouts(nowMs: number): Promise<void> {
    const timedOut: number[] = [];
    for (const [workerId, slot] of this.workers) {
      if (!slot.active) continue;
      if (slot.worker.currentTaskId) continue;
      if (nowMs - slot.startedAtMs <= this.pendingTaskIdTimeoutMs) continue;
      timedOut.push(workerId);
    }

    for (const workerId of timedOut) {
      const slot = this.workers.get(workerId);
      if (!slot || !slot.active) continue;

      slot.active = false;
      try { slot.worker.removeAllListeners(); } catch { /* ignore */ }

      this.appendWorkerLog(workerId, {
        ts: formatTime(),
        type: 'error',
        content: `No TaskId detected after ${Math.round(this.pendingTaskIdTimeoutMs / 1000)}s, killed`
      });

      try {
        await slot.worker.kill();
      } catch (err: unknown) {
        const e = toError(err);
        this.appendWorkerLog(workerId, { ts: formatTime(), type: 'error', content: `Kill failed: ${e.message}` });
      }

      this.emitWorkerState(workerId, true);
      void this.tick('pendingTimeout');
    }
  }

  private recoverStaleTasks(nowMs: number): void {
    const activeTaskIds = this.getActiveWorkerTaskIds();
    const tasksToRecover: string[] = [];

    for (const task of this.tasks.values()) {
      if (task.status !== 'running' || activeTaskIds.has(task.id)) {
        this.staleDetectedMs.delete(task.id);
        continue;
      }

      let detectedMs = this.staleDetectedMs.get(task.id);
      if (detectedMs === undefined) {
        detectedMs = nowMs;
        this.staleDetectedMs.set(task.id, detectedMs);
        continue;
      }

      if (nowMs - detectedMs > this.staleTaskTimeoutMs) {
        this.staleDetectedMs.delete(task.id);
        this.setTaskStatus(task, 'ready');
        tasksToRecover.push(task.id);
      }
    }

    if (tasksToRecover.length > 0 && this.filePath) {
      this.updateAutoDevFileForRecoveredTasks(tasksToRecover);
    }
  }

  private updateAutoDevFileForRecoveredTasks(taskIds: string[]): void {
    if (!this.filePath) return;
    this.fileWriteQueue = this.fileWriteQueue
      .catch(() => undefined)
      .then(() => this.doUpdateAutoDevFile(taskIds));
  }

  private async doUpdateAutoDevFile(taskIds: string[]): Promise<void> {
    if (!this.filePath) return;
    try {
      let content = await readFile(this.filePath, 'utf8');
      let modified = false;

      for (const taskId of taskIds) {
        const escapedId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const runningPatterns = [
          new RegExp(`(###\\s+(?:Task[：:\\s]+)?${escapedId}(?![\\w-])[^\\r\\n]*\\r?\\n\\r?\\n?)- \\[~\\][^\\r\\n]*`, 'i'),
          new RegExp(`(###\\s+(?:Task[：:\\s]+)?${escapedId}(?![\\w-])[^\\r\\n]*\\r?\\n\\r?\\n?)- \\[ \\] \\*\\*🟠[^\\r\\n]*`, 'i'),
          new RegExp(`(###\\s+(?:Task[：:\\s]+)?${escapedId}(?![\\w-])[^\\r\\n]*\\r?\\n[\\s\\S]*?)\\*\\*状态\\*\\*[：:]\\s*执行中[^\\r\\n]*`, 'i')
        ];

        for (const pattern of runningPatterns) {
          if (pattern.test(content)) {
            content = content.replace(pattern, (match, prefix) => {
              modified = true;
              const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
              return `${prefix}- [ ] **未认领** (调度器自动恢复 ${timestamp})`;
            });
            break;
          }
        }
      }

      if (modified) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(this.filePath, content, 'utf8');
      }
    } catch { /* ignore */ }
  }

  private async startWorkersIfNeeded(trigger: string): Promise<void> {
    const runningCount = this.getRunningWorkerCount();
    const slots = Math.max(0, this.maxParallel - runningCount);
    if (slots <= 0) return;

    const execTasks = this.findExecutableTasks();
    const toStart = Math.min(slots, execTasks.length);
    if (toStart <= 0) return;

    for (let i = 0; i < toStart; i++) {
      const workerId = this.allocateWorkerId();
      if (workerId === null) break;
      const task = execTasks[i];
      if (!task) break;
      await this.spawnWorker(workerId, trigger, task.id);
    }
  }

  private allocateWorkerId(): number | null {
    for (let i = 1; i <= this.maxParallel; i++) {
      const slot = this.workers.get(i);
      if (!slot || (!slot.active && !slot.closing)) return i;
    }
    return null;
  }

  private async spawnWorker(workerId: number, trigger: string, taskId: string): Promise<void> {
    const existing = this.workers.get(workerId);
    const generation = (existing?.generation ?? 0) + 1;
    const logs = existing?.logs ?? [];

    // #1 Fix: Double-check task is still executable before spawning
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'ready') {
      this.appendWorkerLog(workerId, {
        ts: formatTime(),
        type: 'system',
        content: `Task ${taskId} no longer ready (status=${task?.status ?? 'not found'}), skipping spawn`
      });
      return;
    }
    // Verify dependencies are still satisfied
    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId);
      if (!dep || dep.status !== 'success') {
        this.appendWorkerLog(workerId, {
          ts: formatTime(),
          type: 'system',
          content: `Task ${taskId} dependency ${depId} not satisfied (status=${dep?.status ?? 'not found'}), skipping spawn`
        });
        return;
      }
    }

    // Use --task parameter to assign specific task (Mode D in auto-dev.md)
    const startupMessage = `/auto-dev --task ${taskId}`;

    // Disable internal watchdog - external Watchdog class handles timeouts with user config
    const worker = new ClaudeWorker({
      workerId,
      watchdog: { enabled: false },
      startupMessage,
      assignedTaskId: taskId
    });
    const slot: WorkerSlot = {
      worker,
      logs,
      active: true,
      closing: false,
      startedAtMs: Date.now(),
      generation,
      lastEmitted: null
    };
    this.workers.set(workerId, slot);

    // Scheduler assigns task up-front; set task status immediately
    // Task is guaranteed to be 'ready' at this point (validated above)
    task.workerId = workerId;
    task.status = 'running';
    this.ensureTaskTiming(taskId, task, slot.startedAtMs);
    this.emitTaskUpdate(taskId, 'running', { duration: task.duration, workerId });
    if (task.endTime) task.endTime = undefined;

    this.attachWorkerEvents(workerId, generation, taskId);
    this.emitWorkerState(workerId, true);

    this.appendWorkerLog(workerId, {
      ts: formatTime(),
      type: 'system',
      content: `Starting... (trigger=${trigger}, task=${taskId})`
    });

    try {
      await worker.start(this.projectRoot);

      // Setup logging and recovery after successful start
      void this.prepareTaskLoggingAndRecovery(workerId, generation, taskId).catch((err: unknown) => {
        const e = toError(err);
        this.appendWorkerLog(workerId, {
          ts: formatTime(),
          type: 'error',
          content: `Recovery setup failed: ${e.message}`
        });
      });
    } catch (err: unknown) {
      const e = toError(err);
      slot.active = false;
      try { worker.removeAllListeners(); } catch { /* ignore */ }
      // Rollback task status on start failure
      if (task.status === 'running' && task.workerId === workerId) {
        this.setTaskStatus(task, 'ready');
      }
      this.appendWorkerLog(workerId, { ts: formatTime(), type: 'error', content: `Start failed: ${e.message}` });
      this.emitWorkerState(workerId, true);
    }
  }

  private attachWorkerEvents(workerId: number, generation: number, assignedTaskId: string): void {
    const slot = this.workers.get(workerId);
    if (!slot) return;

    const guard = (): WorkerSlot | null => {
      const current = this.workers.get(workerId);
      if (!current || current.generation !== generation) return null;
      return current;
    };

    slot.worker.on('log', (entry) => {
      const cur = guard();
      if (!cur) return;
      this.appendWorkerLog(workerId, entry);
      this.emitWorkerState(workerId, false);
    });

    // taskDetected event is no longer used for task assignment since scheduler assigns up-front
    // Keep the listener for logging purposes only
    slot.worker.on('taskDetected', (detectedId) => {
      const cur = guard();
      if (!cur) return;
      // Log if detected ID differs from assigned (shouldn't happen normally)
      if (detectedId !== assignedTaskId) {
        this.appendWorkerLog(workerId, {
          ts: formatTime(),
          type: 'system',
          content: `Detected task ${detectedId} differs from assigned ${assignedTaskId}`
        });
      }
      this.emitWorkerState(workerId, true);
    });

    slot.worker.on('complete', (success, durationMs) => {
      const cur = guard();
      if (!cur) return;

      cur.closing = true;
      cur.active = false;
      try { cur.worker.removeAllListeners(); } catch { /* ignore */ }

      // #6 Fix: Add timeout protection for kill to prevent slot from being stuck
      const killTimeout = setTimeout(() => {
        cur.closing = false;
      }, 10_000);
      void cur.worker.kill().finally(() => {
        clearTimeout(killTimeout);
        cur.closing = false;
      });

      // Use assigned taskId instead of detecting from worker output
      const taskId = assignedTaskId;
      if (taskId) {
        const startMs = this.taskStartMs.get(taskId) ?? cur.startedAtMs;
        const endMs = Date.now();
        const elapsedSec = Math.max(0, Math.floor((endMs - startMs) / 1000));

        const task = this.getOrCreateTask(taskId);
        task.duration = elapsedSec;
        if (!task.startTime) task.startTime = new Date(startMs).toISOString();
        task.endTime = new Date(endMs).toISOString();

        // #2 Fix: Re-parse AUTO-DEV.md to get actual task status instead of relying on CLI success
        // CLI success doesn't mean task completed - Mode D may exit successfully even if task was blocked
        void this.verifyTaskStatusFromFile(taskId, success, workerId).catch((err: unknown) => {
          const e = toError(err);
          this.appendWorkerLog(workerId, {
            ts: formatTime(),
            type: 'error',
            content: `Task status verification failed: ${e.message}`
          });
          // Fallback: if verification fails, use CLI success as indicator
          if (task.status === 'running' && !success) {
            this.setTaskStatus(task, 'ready');
          }
        });

        this.appendWorkerLog(workerId, {
          ts: formatTime(),
          type: 'system',
          content: `Duration: ${formatDuration(elapsedSec)} (${success ? 'OK' : 'FAIL'}, raw=${Math.round(durationMs / 100) / 10}s)`
        });

        // #5 Fix: Removed duplicate emitTaskUpdate - setTaskStatus already emits

        void this.logManager.endTaskLog(taskId, success ? 'completed' : 'interrupted').catch((err: unknown) => {
          const e = toError(err);
          console.error(`[logs] endTaskLog(${taskId}) failed: ${e.message}`);
        });
      }

      this.emitWorkerState(workerId, true);
      void this.tick('workerComplete');
    });

    slot.worker.on('error', (error) => {
      const cur = guard();
      if (!cur) return;
      this.appendWorkerLog(workerId, { ts: formatTime(), type: 'error', content: error.message });
      void this.tick('workerError');
    });
  }

  private getRunningWorkerCount(): number {
    let count = 0;
    for (const slot of this.workers.values()) {
      if (slot.active || slot.closing) count++;
    }
    return count;
  }

  private getPendingWorkerCount(): number {
    let count = 0;
    for (const slot of this.workers.values()) {
      if (!slot.active) continue;
      if (!slot.worker.currentTaskId) count++;
    }
    return count;
  }

  private getActiveWorkerTaskIds(): Set<string> {
    const ids = new Set<string>();
    for (const slot of this.workers.values()) {
      if (!slot.active) continue;
      const taskId = slot.worker.currentTaskId;
      if (taskId) ids.add(taskId);
    }
    return ids;
  }

  private findExecutableTasks(): Task[] {
    const result: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== 'ready') continue;

      let depsOk = true;
      for (const depId of task.dependencies) {
        const dep = this.tasks.get(depId);
        if (!dep || dep.status !== 'success') {
          depsOk = false;
          break;
        }
      }

      if (depsOk) result.push(task);
    }

    result.sort((a, b) => (a.wave - b.wave) || a.id.localeCompare(b.id));
    return result;
  }

  /**
   * #2 Fix: Verify task status by re-parsing AUTO-DEV.md file
   * This ensures we use the actual file status instead of relying on CLI success
   */
  private async verifyTaskStatusFromFile(taskId: string, cliSuccess: boolean, workerId: number): Promise<void> {
    const { tasks: fileTasks } = await parseAutoDevFile(this.filePath);
    const fileTask = fileTasks.get(taskId);
    const memTask = this.tasks.get(taskId);

    if (!memTask) return;

    if (!fileTask) {
      // Task not found in file - use CLI result as fallback
      if (memTask.status === 'running' && !cliSuccess) {
        this.setTaskStatus(memTask, 'ready');
      }
      return;
    }

    // Update task status based on file content
    const fileStatus = fileTask.status;
    const memStatus = memTask.status;

    this.appendWorkerLog(workerId, {
      ts: formatTime(),
      type: 'system',
      content: `Task ${taskId} file status: ${fileStatus}, memory status: ${memStatus}`
    });

    if (fileStatus === 'success') {
      // Task completed in file - mark as success
      if (memStatus !== 'success') {
        this.setTaskStatus(memTask, 'success');
      }
    } else if (fileStatus === 'failed') {
      // Task failed in file
      if (memStatus !== 'failed') {
        this.setTaskStatus(memTask, 'failed');
      }
    } else if (fileStatus === 'running') {
      // Task still running in file - keep running status
      // This might happen if Claude is still working
    } else if (fileStatus === 'ready' || fileStatus === 'pending') {
      // Task was not executed or blocked - rollback to ready
      if (memStatus === 'running') {
        this.setTaskStatus(memTask, 'ready');
      }
    }
  }

  private computeProgress(): Progress {
    let completed = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'success') completed++;
    }
    return { completed, total: this.tasks.size };
  }

  private isAllTasksSuccess(): boolean {
    const { completed, total } = this.computeProgress();
    return total > 0 && completed === total;
  }

  private emitDeliveryCheck(report: DeliveryReport): void {
    const msg: DeliveryCheckMessage = { type: 'deliveryCheck', payload: report };
    this.emit('deliveryCheck', msg);
  }

  private async runDeliveryCheck(): Promise<void> {
    // Snapshot state at the start to avoid race conditions
    const snapshotFilePath = this.filePath;
    const snapshotProjectRoot = this.projectRoot;
    const snapshotTasks = this.getSortedTasks();

    if (!snapshotFilePath) return;

    let content: string;
    try {
      content = await readFile(snapshotFilePath, 'utf8');
    } catch (err: unknown) {
      const e = toError(err);
      this.emitDeliveryCheck({
        status: 'warning',
        total: 0,
        covered: 0,
        uncovered: [],
        generatedAt: new Date().toISOString(),
        notes: [`读取 AUTO-DEV.md 失败: ${e.message}`]
      });
      return;
    }

    const normalized = content.replace(/^\uFEFF/, '');
    const changeId = parseOpenSpecLink(normalized);

    if (!changeId) {
      this.emitDeliveryCheck({
        status: 'warning',
        total: 0,
        covered: 0,
        uncovered: [],
        generatedAt: new Date().toISOString(),
        notes: ['未在 AUTO-DEV.md 中找到 OpenSpec 链接（格式：> 源自 OpenSpec: [change-id](...)）']
      });
      return;
    }

    // Security check: validate changeId to prevent path traversal
    if (!isValidChangeId(changeId)) {
      this.emitDeliveryCheck({
        status: 'warning',
        total: 0,
        covered: 0,
        uncovered: [],
        generatedAt: new Date().toISOString(),
        notes: [`无效的 change-id 格式: ${changeId}`]
      });
      return;
    }

    const tasksPath = path.resolve(snapshotProjectRoot, 'openspec', 'changes', changeId, 'tasks.md');

    // Security check: ensure tasksPath is within expected directory
    const expectedDir = path.resolve(snapshotProjectRoot, 'openspec', 'changes');
    if (!tasksPath.startsWith(expectedDir)) {
      this.emitDeliveryCheck({
        status: 'warning',
        total: 0,
        covered: 0,
        uncovered: [],
        generatedAt: new Date().toISOString(),
        notes: ['tasks.md 路径安全检查失败']
      });
      return;
    }

    try {
      const checklist = await parseTasksChecklist(tasksPath);
      const report = generateDeliveryReport(snapshotTasks, normalized, checklist);

      this.emitDeliveryCheck({
        ...report,
        changeId,
        tasksPath
      });
    } catch (err: unknown) {
      const e = toError(err);
      this.emitDeliveryCheck({
        status: 'warning',
        total: 0,
        covered: 0,
        uncovered: [],
        generatedAt: new Date().toISOString(),
        changeId,
        tasksPath,
        notes: [`读取 tasks.md 失败: ${e.message}`]
      });
    }
  }

  private getSortedTasks(): Task[] {
    const tasks = Array.from(this.tasks.values()).map(cloneTask);
    tasks.sort((a, b) => (a.wave - b.wave) || a.id.localeCompare(b.id));
    return tasks;
  }

  private getWorkerStates(): WorkerState[] {
    const states: WorkerState[] = [];
    for (const [id, slot] of this.workers) {
      const taskId = slot.active ? (slot.worker.currentTaskId ?? undefined) : undefined;
      const tokenUsage = slot.active ? (slot.worker.currentTokenUsage ?? undefined) : undefined;
      const currentTool = slot.active ? (slot.worker.currentToolName ?? undefined) : undefined;

      states.push({
        id,
        active: slot.active,
        taskId,
        tokenUsage,
        currentTool,
        logs: [...slot.logs]
      });
    }
    states.sort((a, b) => a.id - b.id);
    return states;
  }

  private emitFileLoaded(): void {
    const msg: FileLoadedMessage = {
      type: 'fileLoaded',
      payload: {
        filePath: this.filePath,
        projectRoot: this.projectRoot,
        tasks: this.getSortedTasks()
      }
    };
    this.emit('fileLoaded', msg);
  }

  private emitTaskUpdate(taskId: string, status: TaskStatus, extra: { duration?: number; workerId?: number } = {}): void {
    const payload: TaskUpdateMessage['payload'] = { taskId, status };
    if (extra.duration !== undefined) payload.duration = extra.duration;
    if (extra.workerId !== undefined) payload.workerId = extra.workerId;
    this.emit('taskUpdate', { type: 'taskUpdate', payload });
  }

  private appendWorkerLog(workerId: number, entry: LogEntry): void {
    const slot = this.workers.get(workerId);
    if (!slot) return;

    slot.logs.push(entry);
    while (slot.logs.length > this.maxWorkerLogs) slot.logs.shift();

    const taskId = slot.worker.currentTaskId ?? undefined;
    const msg: WorkerLogMessage = {
      type: 'workerLog',
      payload: { workerId, taskId, entry }
    };
    this.emit('workerLog', msg);

    if (taskId) {
      void this.logManager.appendLog(taskId, entry).catch((err: unknown) => {
        const e = toError(err);
        console.error(`[logs] appendLog(${taskId}) failed: ${e.message}`);
      });
    }
  }

  private emitWorkerState(workerId: number, force: boolean): void {
    const slot = this.workers.get(workerId);
    if (!slot) return;

    const snapshot: WorkerStateSnapshot = {
      taskId: slot.active ? (slot.worker.currentTaskId ?? undefined) : undefined,
      tokenUsage: slot.active ? (slot.worker.currentTokenUsage ?? undefined) : undefined,
      currentTool: slot.active ? (slot.worker.currentToolName ?? undefined) : undefined
    };

    if (!force && slot.lastEmitted) {
      if (
        slot.lastEmitted.taskId === snapshot.taskId &&
        slot.lastEmitted.tokenUsage === snapshot.tokenUsage &&
        slot.lastEmitted.currentTool === snapshot.currentTool
      ) {
        return;
      }
    }

    slot.lastEmitted = snapshot;

    const msg: WorkerStateMessage = {
      type: 'workerState',
      payload: {
        workerId,
        taskId: snapshot.taskId,
        tokenUsage: snapshot.tokenUsage,
        currentTool: snapshot.currentTool
      }
    };
    this.emit('workerState', msg);
  }

  private emitProgressIfChanged(force: boolean): void {
    const next = this.computeProgress();
    if (!force && next.completed === this.lastProgress.completed && next.total === this.lastProgress.total) {
      return;
    }
    this.lastProgress = next;
    const msg: ProgressMessage = { type: 'progress', payload: next };
    this.emit('progress', msg);
  }

  private emitSchedulerStateIfChanged(force: boolean): void {
    const next = { running: this.running, paused: this.paused };
    if (!force && next.running === this.lastSchedulerState.running && next.paused === this.lastSchedulerState.paused) {
      return;
    }
    this.lastSchedulerState = next;
    const msg: SchedulerStateMessage = { type: 'schedulerState', payload: next };
    this.emit('schedulerState', msg);
  }

  private buildRecoveryPrompt(ctx: RecoveryContext): string {
    const steps = ctx.checkpoint.completedSteps.length > 0
      ? ctx.checkpoint.completedSteps.slice(-20).map((s) => `- ${s}`).join('\n')
      : '- (none)';

    const next = ctx.checkpoint.nextStep?.trim() || '(unknown)';

    return [
      '【Recovery Mode】',
      `Detected that task ${ctx.taskId} was interrupted last time (status=${ctx.status}).`,
      `Previous start time: ${ctx.startTime}`,
      `Previous log file: ${ctx.logFilePath}`,
      '',
      'Completed steps (from previous log):',
      steps,
      '',
      `Suggested resume point: ${next}`,
      '',
      'Requirements:',
      '1) First read the previous log to avoid repeating completed work;',
      '2) Continue from the "suggested resume point";',
      '3) If the checkpoint info seems inaccurate, correct it and proceed to complete the task.'
    ].join('\n');
  }

  private async prepareTaskLoggingAndRecovery(workerId: number, generation: number, taskId: string): Promise<void> {
    const checkSlotValid = (): boolean => {
      const s = this.workers.get(workerId);
      return !!s && s.generation === generation && s.active;
    };

    if (!checkSlotValid()) return;

    let recovery: RecoveryContext | null = null;
    try {
      recovery = await this.logManager.getRecoveryContext(taskId);
    } catch (err: unknown) {
      const e = toError(err);
      console.error(`[logs] getRecoveryContext(${taskId}) failed: ${e.message}`);
    }

    if (!checkSlotValid()) return;

    await this.logManager.startTaskLog(taskId);

    if (!checkSlotValid()) return;

    if (recovery) {
      const slot = this.workers.get(workerId);
      if (!slot) return;

      const prompt = this.buildRecoveryPrompt(recovery);
      slot.worker.send({ type: 'user', message: { role: 'user', content: prompt } });
      this.appendWorkerLog(workerId, {
        ts: formatTime(),
        type: 'system',
        content: `Recovery prompt injected (prevLog=${recovery.logFile})`
      });
    }
  }
}

export interface Scheduler {
  on(event: 'fileLoaded', listener: (msg: FileLoadedMessage) => void): this;
  on(event: 'taskUpdate', listener: (msg: TaskUpdateMessage) => void): this;
  on(event: 'workerLog', listener: (msg: WorkerLogMessage) => void): this;
  on(event: 'progress', listener: (msg: ProgressMessage) => void): this;
  on(event: 'schedulerState', listener: (msg: SchedulerStateMessage) => void): this;
  on(event: 'workerState', listener: (msg: WorkerStateMessage) => void): this;
  on(event: 'deliveryCheck', listener: (msg: DeliveryCheckMessage) => void): this;

  once(event: 'fileLoaded', listener: (msg: FileLoadedMessage) => void): this;
  once(event: 'taskUpdate', listener: (msg: TaskUpdateMessage) => void): this;
  once(event: 'workerLog', listener: (msg: WorkerLogMessage) => void): this;
  once(event: 'progress', listener: (msg: ProgressMessage) => void): this;
  once(event: 'schedulerState', listener: (msg: SchedulerStateMessage) => void): this;
  once(event: 'workerState', listener: (msg: WorkerStateMessage) => void): this;
  once(event: 'deliveryCheck', listener: (msg: DeliveryCheckMessage) => void): this;

  emit(event: 'fileLoaded', msg: FileLoadedMessage): boolean;
  emit(event: 'taskUpdate', msg: TaskUpdateMessage): boolean;
  emit(event: 'workerLog', msg: WorkerLogMessage): boolean;
  emit(event: 'progress', msg: ProgressMessage): boolean;
  emit(event: 'schedulerState', msg: SchedulerStateMessage): boolean;
  emit(event: 'workerState', msg: WorkerStateMessage): boolean;
  emit(event: 'deliveryCheck', msg: DeliveryCheckMessage): boolean;
}
