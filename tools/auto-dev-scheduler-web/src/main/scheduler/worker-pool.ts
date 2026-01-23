/**
 * Worker Pool
 *
 * Manages worker lifecycle (spawn, cleanup, events).
 * Extracted from scheduler-service.ts Phase 5.
 */

import type { SchedulerContext, WorkerWrapper, WorkerKind, CompletedWorkerLog } from './scheduler-context';
import type { ArtifactDraft, LogEntry, Task } from '../../shared/types';

// ============================================================================
// Configuration
// ============================================================================

const MAX_WORKER_LOGS = 1000;

// ============================================================================
// Callback Interface
// ============================================================================

export interface WorkerPoolCallbacks {
  /** Emit worker log to external listeners */
  onWorkerLog(workerId: number, taskId: string, entry: LogEntry): void;

  /** Emit worker state change */
  onWorkerStateChanged(
    workerId: number,
    active: boolean,
    taskId?: string,
    tokenUsage?: string,
    currentTool?: string,
    workerKind?: WorkerKind
  ): void;

  /** Handle task completion */
  onWorkerComplete(
    workerId: number,
    taskId: string,
    success: boolean,
    durationMs: number
  ): void;

  /** Handle worker error */
  onWorkerError(workerId: number, taskId: string, error: unknown): void;

  /** Handle API error detection */
  onApiErrorDetected(errorText: string, wrapper: WorkerWrapper): void;

  /** Lock a task for a worker */
  lockTask(taskId: string, workerId: number): boolean;

  /** Unlock a task */
  unlockTask(taskId: string): void;

  /** Set task status */
  setTaskStatus(task: Task, status: 'ready' | 'running' | 'failed' | 'success', duration?: number): void;

  /** Handle task failure */
  handleTaskFailure(task: Task, duration?: number): { scheduled: boolean; delayMs?: number };

  /** Find executable tasks */
  findExecutableTasks(): Task[];

  /** Trigger scheduler tick */
  triggerTick(reason: string): void;

  /** Append log to log manager */
  appendLog(taskId: string, entry: LogEntry): void;

  /** Start task log session */
  startTaskLog(taskId: string): void;

  /** End task log session */
  endTaskLog(taskId: string): void;

  /** Update checkbox in AUTO-DEV.md */
  updateTaskCheckbox(filePath: string, taskId: string, success: boolean): Promise<void>;

  /** Get delegation hint for a task (Phase 4) */
  getDelegationHintForTask(taskId: string): { target: string; mcpTool?: string } | null;

  /** Create Claude worker instance */
  createClaudeWorker(
    workerId: number,
    assignedTaskId: string,
    startupContent: string
  ): WorkerInstanceWrapper;

  // Phase 4: createCodexWorker and createGeminiWorker removed
  // Claude uses MCP tools for delegation internally

  /** Extract task content for prompt (used for delegation hints) */
  extractTaskContent(filePath: string, taskId: string): Promise<string | null>;

  /** Build startup message content */
  buildStartupContent(taskId: string, filePath: string, needsRecoveryPrompt: boolean): Promise<string>;

  /** Resolve persona for task */
  resolvePersona(task: Task): string | null;

  /** Resolve worker type from persona */
  resolveWorkerType(persona: string | null): 'claude-cli' | 'codex-cli' | 'gemini-cli';

  /** Handle issue report from worker */
  onIssueReported(raw: unknown, reporterTaskId: string, reporterWorkerId: number): void;

  /** Request session persistence */
  requestPersist(reason: string): void;
}

/**
 * Wrapper around worker instance to hide implementation details
 */
export interface WorkerInstanceWrapper {
  /** The actual worker instance (ClaudeWorker | CodexWorker | GeminiWorker) */
  instance: unknown;

  /** Start the worker */
  start(projectRoot: string): Promise<void>;

  /** Kill/dispose the worker */
  kill(): Promise<void>;

  /** Check if worker has modified code (Claude only) */
  hasModifiedCode?: boolean;

  /** Get current token usage (Claude only) */
  tokenUsage?: string;

  /** Get current tool name (Claude only) */
  currentTool?: string;

  // Phase 4: run() method removed - all workers are now Claude workers

  /** Attach event listener (uses any for EventEmitter compatibility) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): void;
}

// ============================================================================
// Worker Pool Class
// ============================================================================

export class WorkerPool {
  constructor(
    private ctx: SchedulerContext,
    private callbacks: WorkerPoolCallbacks
  ) {}

  // --------------------------------------------------------------------------
  // Worker Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Start workers if slots available and executable tasks exist
   */
  startWorkersIfNeeded(): void {
    const activeCount = this.ctx.getActiveWorkerCount();
    const slotsAvailable = this.ctx.maxParallel - activeCount;
    if (slotsAvailable <= 0) return;

    const executable = this.callbacks.findExecutableTasks();
    const toStart = executable.slice(0, slotsAvailable);

    for (const task of toStart) {
      const workerId = this.ctx.reserveWorkerId();  // Synchronously reserve ID
      void this.spawnWorker(workerId, task.id);
    }
  }

  /**
   * Spawn a Claude worker for a task
   *
   * Phase 4: All tasks go through Claude. Claude uses MCP tools
   * (mcp__codex__codex, mcp__gemini__gemini) for delegation internally.
   */
  async spawnWorker(workerId: number, assignedTaskId: string): Promise<void> {
    const generation = this.ctx.nextGeneration();

    // Lock task immediately to prevent duplicate scheduling
    if (!this.callbacks.lockTask(assignedTaskId, workerId)) {
      this.ctx.releaseWorkerId(workerId);  // Release reserved ID on lock failure
      return;
    }

    let wrapper: WorkerWrapper | null = null;
    let workerInstance: WorkerInstanceWrapper | null = null;

    try {
      const task = this.ctx.tasks.get(assignedTaskId);
      const needsRecoveryPrompt = task?.isApiErrorRecovery && task?.hasModifiedCode;

      // Phase 4: Always use Claude, delegation hints are passed via buildStartupContent
      const resolvedPersona = task ? this.callbacks.resolvePersona(task) : null;
      console.log(`[WorkerPool] Task ${assignedTaskId}: persona=${resolvedPersona ?? 'null'}, workerType=claude-cli (Claude-first architecture)`);

      // Build startup content with delegation hints
      const startupContent = await this.callbacks.buildStartupContent(
        assignedTaskId,
        this.ctx.filePath,
        needsRecoveryPrompt ?? false
      );

      // Check if spawn was canceled while awaiting I/O (stop(), API retry, etc.)
      if (!this.ctx.running || this.ctx.taskLocks.get(assignedTaskId) !== workerId) {
        this.ctx.releaseWorkerId(workerId);
        const currentTask = this.ctx.tasks.get(assignedTaskId);
        if (currentTask && currentTask.status === 'running') {
          this.callbacks.setTaskStatus(currentTask, 'ready');
        }
        this.callbacks.unlockTask(assignedTaskId);
        console.warn(`[WorkerPool] Aborting spawn for task ${assignedTaskId} (worker ${workerId}): scheduler stopped or lock lost`);
        return;
      }

      workerInstance = this.callbacks.createClaudeWorker(workerId, assignedTaskId, startupContent);

      wrapper = {
        id: workerId,
        worker: workerInstance.instance,
        workerKind: 'claude',
        assignedTaskId,
        taskId: assignedTaskId,
        logs: [],
        startMs: Date.now(),
        closing: false,
        generation
      };

      this.ctx.workers.set(workerId, wrapper);
      this.ctx.releaseWorkerId(workerId);  // ID now tracked in workers Map
      this.attachClaudeWorkerEvents(wrapper, generation, workerInstance);

      this.callbacks.startTaskLog(assignedTaskId);
      this.emitWorkerState(wrapper, workerInstance);

      await workerInstance.start(this.ctx.projectRoot);

      // Clear recovery flag only after the recovery prompt was actually sent
      if (task && needsRecoveryPrompt) {
        task.isApiErrorRecovery = false;
      }
    } catch (err) {
      if (wrapper) {
        this.handleWorkerError(wrapper, err);
        try {
          await workerInstance?.kill();
        } catch { /* ignore */ }
        return;
      }

      this.ctx.releaseWorkerId(workerId);
      const task = this.ctx.tasks.get(assignedTaskId);
      if (task && task.status === 'running') {
        this.callbacks.setTaskStatus(task, 'ready');
      }
      this.callbacks.unlockTask(assignedTaskId);
      console.error(`[WorkerPool] Failed to spawn worker ${workerId} for task ${assignedTaskId}:`, err);
      if (this.ctx.running) {
        this.callbacks.triggerTick('spawnWorkerError');
      }
    }
  }

  // Phase 4: spawnDirectWorker removed - all tasks go through Claude
  // Claude uses MCP tools for delegation to Codex/Gemini internally

  /**
   * Kill a specific worker
   */
  async killWorker(workerId: number, workerInstance?: WorkerInstanceWrapper): Promise<void> {
    const wrapper = this.ctx.workers.get(workerId);
    if (!wrapper) return;

    wrapper.closing = true;
    const taskId = wrapper.taskId;

    // Release lock and reset task to ready if this worker owns it
    if (this.ctx.taskLocks.get(taskId) === workerId) {
      const task = this.ctx.tasks.get(taskId);
      if (task && task.status === 'running') {
        this.callbacks.setTaskStatus(task, 'ready');
      }
      this.callbacks.unlockTask(taskId);
    }

    this.callbacks.endTaskLog(taskId);
    this.cleanupWorker(wrapper);

    try {
      if (workerInstance) {
        await workerInstance.kill();
      }
    } catch { /* ignore */ }

    if (this.ctx.running) {
      this.callbacks.triggerTick('killWorker');
    }
  }

  /**
   * Kill all workers for API error retry
   * Resets tasks to ready instead of failed
   */
  async killAllWorkersForRetry(getWorkerInstance: (wrapper: WorkerWrapper) => WorkerInstanceWrapper | null): Promise<void> {
    const killPromises = [...this.ctx.workers.values()].map(async (w) => {
      w.closing = true;
      const taskId = w.taskId;

      if (this.ctx.taskLocks.get(taskId) === w.id) {
        const task = this.ctx.tasks.get(taskId);
        if (task && task.status === 'running') {
          // Check if worker has modified code
          const instance = getWorkerInstance(w);
          if (instance?.hasModifiedCode) {
            task.hasModifiedCode = true;
            task.isApiErrorRecovery = true;
            console.log(`[WorkerPool] Task ${taskId} has modified code, will use recovery prompt on retry`);
          }
          this.callbacks.setTaskStatus(task, 'ready');
        }
        this.callbacks.unlockTask(taskId);
      }

      this.ctx.completedWorkerLogs.push({
        workerId: w.id,
        taskId: w.taskId,
        logs: [...w.logs],
        stopped: true
      });

      this.callbacks.endTaskLog(taskId);

      try {
        const instance = getWorkerInstance(w);
        if (instance) {
          await instance.kill();
        }
      } catch { /* ignore */ }
    });

    await Promise.all(killPromises);
    this.ctx.clearWorkers();
  }

  // --------------------------------------------------------------------------
  // Event Attachment
  // --------------------------------------------------------------------------

  /**
   * Attach event handlers for Claude workers
   */
  private attachClaudeWorkerEvents(
    wrapper: WorkerWrapper,
    generation: number,
    workerInstance: WorkerInstanceWrapper
  ): void {
    const workerId = wrapper.id;

    const isStale = (): boolean => {
      const current = this.ctx.workers.get(workerId);
      return !current || current.generation !== generation || current.closing;
    };

    workerInstance.on('log', (entry: LogEntry) => {
      if (isStale()) return;

      wrapper.logs.push(entry);
      if (wrapper.logs.length > MAX_WORKER_LOGS) {
        wrapper.logs = wrapper.logs.slice(-MAX_WORKER_LOGS);
      }

      this.callbacks.onWorkerLog(workerId, wrapper.taskId, entry);
      this.callbacks.appendLog(wrapper.taskId, entry);
      this.emitWorkerState(wrapper, workerInstance);
    });

    workerInstance.on('taskDetected', (detectedTaskId: string) => {
      if (isStale()) return;

      if (detectedTaskId !== wrapper.assignedTaskId) {
        const entry: LogEntry = {
          ts: new Date().toISOString().slice(11, 19),
          type: 'error',
          content: `Task mismatch: assigned=${wrapper.assignedTaskId}, detected=${detectedTaskId}`
        };
        wrapper.logs.push(entry);
        this.callbacks.onWorkerLog(workerId, wrapper.assignedTaskId, entry);
        this.callbacks.appendLog(wrapper.assignedTaskId, entry);
        void this.killWorker(workerId, workerInstance);
      }
    });

    workerInstance.on('complete', (success: boolean, durationMs: number) => {
      if (isStale()) return;

      const taskId = wrapper.taskId;

      if (this.ctx.taskLocks.get(taskId) !== workerId) {
        this.callbacks.endTaskLog(taskId);
        this.cleanupWorker(wrapper);
        this.callbacks.triggerTick('workerComplete');
        return;
      }

      // P2: Check for delegation tool call if expected
      const delegationHint = this.callbacks.getDelegationHintForTask(taskId);
      if (delegationHint && delegationHint.target !== 'direct' && delegationHint.mcpTool) {
        // Format tool name same way as claude-worker: mcp__codex__codex -> codex:codex
        const formattedTool = delegationHint.mcpTool.replace(/^mcp__/, '').replace(/__/g, ':');
        // Only check 'tool' type log entries for accurate detection
        const toolCallDetected = wrapper.logs.some(
          log => log.type === 'tool' && log.content.startsWith(formattedTool)
        );
        if (!toolCallDetected) {
          console.warn(`[WorkerPool] Task ${taskId}: Expected delegation to ${formattedTool} but no tool call detected in logs`);
          const entry: LogEntry = {
            ts: new Date().toISOString().slice(11, 19),
            type: 'system',
            content: `⚠️ Delegation skipped: expected ${formattedTool} call but none detected`
          };
          wrapper.logs.push(entry);
          this.callbacks.onWorkerLog(workerId, taskId, entry);
          this.callbacks.appendLog(taskId, entry);
        }
      }

      const task = this.ctx.tasks.get(taskId);
      if (task) {
        const duration = Math.round(durationMs / 1000);
        if (success) {
          task.retryCount = 0;
          task.nextRetryAt = undefined;
          this.callbacks.setTaskStatus(task, 'success', duration);
          void this.callbacks.updateTaskCheckbox(this.ctx.filePath, taskId, true).catch(err => {
            console.error(`[WorkerPool] Failed to update checkbox for ${taskId}:`, err);
          });
        } else {
          const result = this.callbacks.handleTaskFailure(task, duration);
          if (result.scheduled) {
            const entry: LogEntry = {
              ts: new Date().toISOString().slice(11, 19),
              type: 'system',
              content: `Auto-retry scheduled (${task.retryCount}/${this.ctx.autoRetryConfig.maxRetries}) in ${Math.round(result.delayMs! / 1000)}s`
            };
            wrapper.logs.push(entry);
            this.callbacks.onWorkerLog(workerId, taskId, entry);
            this.callbacks.appendLog(taskId, entry);
          }
        }
      }

      this.callbacks.endTaskLog(taskId);
      this.callbacks.unlockTask(taskId);
      this.cleanupWorker(wrapper);
      this.callbacks.triggerTick('workerComplete');
    });

    workerInstance.on('error', (err: unknown) => {
      if (isStale()) return;
      this.handleWorkerError(wrapper, err);
    });

    workerInstance.on('issueReported', (raw: unknown, taskId: string, wId: number) => {
      if (isStale()) return;
      try {
        this.callbacks.onIssueReported(raw, taskId, wId);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const entry: LogEntry = {
          ts: new Date().toISOString().slice(11, 19),
          type: 'error',
          content: `Failed to handle issue report: ${errorMsg}`
        };
        wrapper.logs.push(entry);
        this.callbacks.onWorkerLog(workerId, wrapper.taskId, entry);
        this.callbacks.appendLog(wrapper.taskId, entry);
      }
    });

    workerInstance.on('apiError', (errorText: string) => {
      if (isStale()) return;
      this.callbacks.onApiErrorDetected(errorText, wrapper);
    });

    workerInstance.on('codeModified', (toolName: string, taskIdFromWorker: string) => {
      if (isStale()) return;
      const effectiveTaskId = taskIdFromWorker || wrapper.assignedTaskId;
      if (effectiveTaskId) {
        const task = this.ctx.tasks.get(effectiveTaskId);
        if (task && !task.hasModifiedCode) {
          task.hasModifiedCode = true;
        }
      }
    });
  }

  // Phase 4: attachDirectWorkerEvents removed - no longer needed

  // --------------------------------------------------------------------------
  // Error Handling
  // --------------------------------------------------------------------------

  /**
   * Handle worker error
   */
  private handleWorkerError(wrapper: WorkerWrapper, err: unknown): void {
    const taskId = wrapper.taskId;
    const errorMsg = err instanceof Error ? err.message : String(err);

    const entry: LogEntry = {
      ts: new Date().toISOString().slice(11, 19),
      type: 'error',
      content: `Worker error: ${errorMsg}`
    };
    wrapper.logs.push(entry);
    this.callbacks.onWorkerLog(wrapper.id, taskId, entry);
    this.callbacks.appendLog(taskId, entry);

    if (this.ctx.taskLocks.get(taskId) === wrapper.id) {
      const task = this.ctx.tasks.get(taskId);
      if (task && task.status === 'running') {
        const duration = Math.round((Date.now() - wrapper.startMs) / 1000);
        this.callbacks.handleTaskFailure(task, duration);
      }
      this.callbacks.endTaskLog(taskId);
      this.callbacks.unlockTask(taskId);
    }

    this.cleanupWorker(wrapper);
    this.callbacks.triggerTick('workerError');
  }

  /**
   * Cleanup worker and archive logs
   */
  private cleanupWorker(wrapper: WorkerWrapper): void {
    wrapper.closing = true;
    this.ctx.completedWorkerLogs.push({
      workerId: wrapper.id,
      taskId: wrapper.taskId,
      logs: [...wrapper.logs]
    });
    // Limit completed logs to prevent memory leak
    if (this.ctx.completedWorkerLogs.length > 100) {
      this.ctx.completedWorkerLogs.shift();
    }
    this.ctx.workers.delete(wrapper.id);

    this.callbacks.onWorkerStateChanged(
      wrapper.id,
      false,
      wrapper.taskId
    );
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Emit log entry for a worker
   */
  private emitLog(wrapper: WorkerWrapper, type: LogEntry['type'], content: string): void {
    const entry: LogEntry = {
      ts: new Date().toISOString().slice(11, 19),
      type,
      content
    };
    wrapper.logs.push(entry);
    this.callbacks.onWorkerLog(wrapper.id, wrapper.taskId, entry);
    this.callbacks.appendLog(wrapper.taskId, entry);
  }

  /**
   * Emit worker state update
   */
  private emitWorkerState(wrapper: WorkerWrapper, workerInstance?: WorkerInstanceWrapper): void {
    this.callbacks.onWorkerStateChanged(
      wrapper.id,
      !wrapper.closing,
      wrapper.taskId,
      workerInstance?.tokenUsage,
      workerInstance?.currentTool,
      wrapper.workerKind
    );
  }

  /**
   * Save task output as artifact
   */
  private async saveTaskArtifact(
    taskId: string,
    outputBuffer: string[],
    success: boolean
  ): Promise<void> {
    // Only save on success with non-empty output
    if (!success || outputBuffer.length === 0) return;

    const store = this.ctx.artifactStore;
    if (!store) return;

    const runId = this.ctx.runId;
    if (!runId) return;

    const content = outputBuffer.join('\n');

    // Skip if content is trivially small (< 10 chars)
    if (content.trim().length < 10) return;

    try {
      const draft: ArtifactDraft = {
        name: `${taskId}-output.diff`,
        kind: 'diff',
        content
      };

      await store.put(runId, taskId, draft);
      console.log(`[WorkerPool] Saved artifact for task ${taskId}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[WorkerPool] Failed to save artifact for ${taskId}: ${errorMsg}`);
    }
  }
}
