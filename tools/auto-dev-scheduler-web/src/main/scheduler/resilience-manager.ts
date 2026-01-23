/**
 * Resilience Manager
 *
 * Handles task auto-retry and API error recovery.
 * Extracted from scheduler-service.ts Phase 4.
 */

import type { SchedulerContext, WorkerWrapper } from './scheduler-context';
import type { Task, TaskStatus } from '../../shared/types';

// ============================================================================
// Configuration
// ============================================================================

const AUTO_RETRY_MAX_DELAY_MS = 5 * 60_000;  // 5 minutes cap

export const API_ERROR_CONFIG = {
  maxRetries: 5,                    // Maximum global retry attempts
  maxTaskRetries: 3,                // Maximum per-task API error retries
  baseDelayMs: 10_000,              // 10 seconds base delay
  maxDelayMs: 5 * 60_000,           // 5 minutes cap
  jitterRatio: 0.2,                 // 20% random jitter
};

// ============================================================================
// Callback Interface
// ============================================================================

export interface ResilienceCallbacks {
  /** Called when task status changes */
  setTaskStatus(task: Task, status: TaskStatus, duration?: number): void;

  /** Called when scheduler needs to pause for API error */
  onApiErrorPause(payload: ApiErrorPausePayload): void;

  /** Called when scheduler state changes (pause/resume) */
  onSchedulerStateChanged(running: boolean, paused: boolean, reason?: string | null): void;

  /** Kill all workers for retry (reset tasks to ready) */
  killAllWorkersForRetry(): Promise<void>;

  /** Request session persistence */
  requestPersist(reason: string): void;

  /** Trigger scheduler tick */
  triggerTick(reason: string): void;

  /** Check if task can execute (dependencies satisfied) */
  canExecute(task: Task): boolean;
}

export interface ApiErrorPausePayload {
  errorText: string;
  retryCount: number;
  maxRetries: number;
  nextRetryInMs: number | null;
  taskId?: string;
  taskRetryCount?: number;
  taskMaxRetries?: number;
  pauseReason?: string;
}

// ============================================================================
// Resilience Manager Class
// ============================================================================

export class ResilienceManager {
  constructor(
    private ctx: SchedulerContext,
    private callbacks: ResilienceCallbacks
  ) {}

  // --------------------------------------------------------------------------
  // Task Auto-Retry
  // --------------------------------------------------------------------------

  /**
   * Compute retry delay with exponential backoff + jitter
   */
  computeRetryDelayMs(retryCount: number): number {
    const base = this.ctx.autoRetryConfig.baseDelayMs;
    const attempt = Math.max(1, retryCount);
    // Exponential backoff: base * 2^(attempt-1)
    const backoff = base * Math.pow(2, attempt - 1);
    // Random jitter: 0 ~ base
    const jitter = Math.floor(Math.random() * base);
    const delayMs = backoff + jitter;
    // Cap at max delay
    return Math.min(AUTO_RETRY_MAX_DELAY_MS, delayMs);
  }

  /**
   * Handle task failure with auto-retry scheduling
   * @returns Whether retry was scheduled, and delay if so
   */
  handleTaskFailure(task: Task, duration?: number): { scheduled: boolean; delayMs?: number } {
    const currentRetryCount = task.retryCount ?? 0;
    const canRetry =
      this.ctx.autoRetryConfig.enabled &&
      this.ctx.autoRetryConfig.maxRetries > 0 &&
      currentRetryCount < this.ctx.autoRetryConfig.maxRetries;

    if (canRetry) {
      const nextRetryCount = currentRetryCount + 1;
      task.retryCount = nextRetryCount;
      const delayMs = this.computeRetryDelayMs(nextRetryCount);
      task.nextRetryAt = Date.now() + delayMs;
      this.callbacks.setTaskStatus(task, 'failed', duration);
      // Do not cascade failure - retry is scheduled
      return { scheduled: true, delayMs };
    }

    // Retry exhausted - cascade failure
    task.nextRetryAt = undefined;
    this.callbacks.setTaskStatus(task, 'failed', duration);
    this.cascadeFailure(task.id);
    return { scheduled: false };
  }

  /**
   * Promote tasks whose retry delay has elapsed
   */
  promoteDueRetries(): void {
    const now = Date.now();
    for (const task of this.ctx.tasks.values()) {
      if (task.status !== 'failed') continue;
      if (task.nextRetryAt === undefined) continue;
      if (task.nextRetryAt > now) continue;
      // Check not locked by another worker
      if (this.ctx.taskLocks.has(task.id)) continue;

      // Due for retry - promote to ready or pending
      task.nextRetryAt = undefined;
      const nextStatus = this.callbacks.canExecute(task) ? 'ready' : 'pending';
      this.callbacks.setTaskStatus(task, nextStatus);
    }
  }

  /**
   * Check if any task has pending scheduled retry
   */
  hasPendingRetries(): boolean {
    for (const task of this.ctx.tasks.values()) {
      if (task.status === 'failed' && task.nextRetryAt !== undefined) {
        return true;
      }
    }
    return false;
  }

  /**
   * Cascade failure to dependent tasks (BFS)
   */
  cascadeFailure(failedTaskId: string): void {
    const queue: string[] = [failedTaskId];
    const visited = new Set(queue);

    while (queue.length > 0) {
      const currentId = queue.shift()!;

      for (const task of this.ctx.tasks.values()) {
        if (!task.dependencies?.includes(currentId)) continue;
        if (visited.has(task.id)) continue;

        visited.add(task.id);
        if (task.status !== 'success' && task.status !== 'failed') {
          this.callbacks.setTaskStatus(task, 'failed');
        }
        queue.push(task.id);
      }
    }
  }

  /**
   * Reset cascade-failed tasks when a task is retried
   */
  cascadeReset(retriedTaskId: string): void {
    const queue: string[] = [retriedTaskId];
    const visited = new Set(queue);

    while (queue.length > 0) {
      const currentId = queue.shift()!;

      for (const task of this.ctx.tasks.values()) {
        if (!task.dependencies?.includes(currentId)) continue;
        if (visited.has(task.id)) continue;

        visited.add(task.id);
        if (task.status === 'failed') {
          const nextStatus = this.callbacks.canExecute(task) ? 'ready' : 'pending';
          this.callbacks.setTaskStatus(task, nextStatus);
        }
        queue.push(task.id);
      }
    }
  }

  // --------------------------------------------------------------------------
  // API Error Recovery
  // --------------------------------------------------------------------------

  /**
   * Handle API error (rate limit, overload, etc.)
   */
  handleApiError(errorText: string, triggeringWrapper?: WorkerWrapper): void {
    // Avoid duplicate handling if already paused for API error
    if (this.ctx.pauseReason === 'apiError') return;

    this.ctx.lastApiErrorText = errorText;
    this.ctx.apiErrorRetryCount++;

    // Increment per-task API error retry count
    let taskMaxRetriesExceeded = false;
    let triggeringTaskId: string | undefined;
    if (triggeringWrapper?.taskId) {
      triggeringTaskId = triggeringWrapper.taskId;
      const task = this.ctx.tasks.get(triggeringTaskId);
      if (task) {
        task.apiErrorRetryCount = (task.apiErrorRetryCount ?? 0) + 1;
        if (task.apiErrorRetryCount >= API_ERROR_CONFIG.maxTaskRetries) {
          taskMaxRetriesExceeded = true;
          console.error(`[ResilienceManager] Task ${triggeringTaskId} exceeded max API retries (${API_ERROR_CONFIG.maxTaskRetries})`);
        }
      }
    }

    console.warn(`[ResilienceManager] API Error detected (global: ${this.ctx.apiErrorRetryCount}/${API_ERROR_CONFIG.maxRetries}): ${errorText.slice(0, 100)}`);

    // 1. Pause scheduler immediately
    this.ctx.paused = true;
    this.ctx.pauseReason = 'apiError';

    // 2. Kill all workers and prepare tasks for recovery
    void this.callbacks.killAllWorkersForRetry();

    // 3. Check if we can retry
    const globalRetriesExceeded = this.ctx.apiErrorRetryCount > API_ERROR_CONFIG.maxRetries;
    const shouldPauseForUser = globalRetriesExceeded || taskMaxRetriesExceeded;

    if (!shouldPauseForUser) {
      const delayMs = this.computeApiErrorRetryDelay(this.ctx.apiErrorRetryCount);

      this.callbacks.onSchedulerStateChanged(true, true, 'apiError');

      this.callbacks.onApiErrorPause({
        errorText,
        retryCount: this.ctx.apiErrorRetryCount,
        maxRetries: API_ERROR_CONFIG.maxRetries,
        nextRetryInMs: delayMs,
        taskId: triggeringTaskId,
        taskRetryCount: triggeringTaskId ? this.ctx.tasks.get(triggeringTaskId)?.apiErrorRetryCount : undefined,
        taskMaxRetries: API_ERROR_CONFIG.maxTaskRetries
      });

      console.log(`[ResilienceManager] Scheduling API error retry in ${Math.round(delayMs / 1000)}s`);

      // Schedule retry
      this.ctx.clearApiErrorRetryTimer();
      this.ctx.apiErrorRetryTimer = setTimeout(() => {
        this.ctx.apiErrorRetryTimer = null;
        this.resumeFromApiError();
      }, delayMs);
      this.ctx.apiErrorRetryTimer.unref?.();
    } else {
      // Max retries exceeded - require user action
      this.callbacks.onSchedulerStateChanged(true, true, 'apiError');

      const reason = taskMaxRetriesExceeded
        ? `任务 ${triggeringTaskId} 达到最大重试次数`
        : `全局重试次数已耗尽`;

      this.callbacks.onApiErrorPause({
        errorText,
        retryCount: this.ctx.apiErrorRetryCount,
        maxRetries: API_ERROR_CONFIG.maxRetries,
        nextRetryInMs: null,
        taskId: triggeringTaskId,
        taskRetryCount: triggeringTaskId ? this.ctx.tasks.get(triggeringTaskId)?.apiErrorRetryCount : undefined,
        taskMaxRetries: API_ERROR_CONFIG.maxTaskRetries,
        pauseReason: reason
      });

      console.error(`[ResilienceManager] API error: ${reason}, waiting for user action`);
    }

    this.callbacks.requestPersist('apiError');
  }

  /**
   * Compute API error retry delay with exponential backoff
   */
  computeApiErrorRetryDelay(retryCount: number): number {
    const attempt = Math.max(1, retryCount);
    const backoff = API_ERROR_CONFIG.baseDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * API_ERROR_CONFIG.baseDelayMs * API_ERROR_CONFIG.jitterRatio);
    const delayMs = backoff + jitter;
    return Math.min(API_ERROR_CONFIG.maxDelayMs, delayMs);
  }

  /**
   * Resume from API error pause
   */
  resumeFromApiError(): void {
    if (!this.ctx.running || this.ctx.pauseReason !== 'apiError') return;

    console.log(`[ResilienceManager] Resuming from API error (attempt ${this.ctx.apiErrorRetryCount}/${API_ERROR_CONFIG.maxRetries})`);

    this.ctx.paused = false;
    this.ctx.pauseReason = null;
    this.ctx.lastApiErrorText = null;

    this.callbacks.onSchedulerStateChanged(true, false, null);
    this.callbacks.triggerTick('apiErrorRetry');
    this.callbacks.requestPersist('apiErrorResume');
  }

  /**
   * Reset API error retry state
   */
  resetApiErrorState(): void {
    this.ctx.apiErrorRetryCount = 0;
    this.ctx.lastApiErrorText = null;
    this.ctx.clearApiErrorRetryTimer();
  }

  /**
   * User-triggered retry after API error max retries exceeded
   */
  retryFromApiError(): void {
    if (this.ctx.pauseReason !== 'apiError') return;

    console.log('[ResilienceManager] User triggered retry from API error');
    this.ctx.apiErrorRetryCount = 0;
    this.resumeFromApiError();
  }
}
