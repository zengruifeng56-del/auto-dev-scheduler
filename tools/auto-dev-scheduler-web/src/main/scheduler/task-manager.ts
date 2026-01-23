/**
 * Task Manager
 *
 * Manages task state, locks, and dependency graph.
 * Extracted from scheduler-service.ts Phase 6.
 */

import type { SchedulerContext } from './scheduler-context';
import type { Task, TaskStatus } from '../../shared/types';

// ============================================================================
// Callback Interface
// ============================================================================

export interface TaskManagerCallbacks {
  /** Emit task update event to external listeners */
  onTaskStatusChanged(
    taskId: string,
    status: TaskStatus,
    duration?: number,
    startTime?: string,
    endTime?: string,
    workerId?: number,
    retryCount?: number,
    nextRetryAt?: number | null
  ): void;
}

// ============================================================================
// Task Manager Class
// ============================================================================

export class TaskManager {
  constructor(
    private ctx: SchedulerContext,
    private callbacks: TaskManagerCallbacks
  ) {}

  // --------------------------------------------------------------------------
  // Dependency Checking
  // --------------------------------------------------------------------------

  /**
   * Check if a task can execute (all dependencies satisfied)
   */
  canExecute(task: Task): boolean {
    if (!task.dependencies || task.dependencies.length === 0) return true;
    return task.dependencies.every(depId => {
      const dep = this.ctx.tasks.get(depId);
      return dep && dep.status === 'success';
    });
  }

  /**
   * Update pending tasks whose dependencies are now satisfied
   */
  updatePendingTasks(): void {
    for (const task of this.ctx.tasks.values()) {
      if (task.status === 'pending' && this.canExecute(task)) {
        this.setTaskStatus(task, 'ready');
      }
    }
  }

  // --------------------------------------------------------------------------
  // Task Status Management
  // --------------------------------------------------------------------------

  /**
   * Set task status with proper timestamp tracking
   */
  setTaskStatus(task: Task, status: TaskStatus, duration?: number): void {
    const prev = task.status;

    // Track start/end times
    if (status === 'running' && prev !== 'running') {
      task.startTime = new Date().toISOString();
      task.endTime = undefined;
      task.duration = undefined;
    } else if (prev === 'running' && status !== 'running') {
      task.endTime = new Date().toISOString();
    }

    task.status = status;
    if (duration !== undefined) task.duration = duration;

    if (prev !== status) {
      // Wrap callbacks in try-catch to prevent exceptions from crashing scheduler
      try {
        this.callbacks.onTaskStatusChanged(
          task.id,
          status,
          task.duration,
          task.startTime,
          task.endTime,
          task.workerId,
          task.retryCount ?? 0,
          task.nextRetryAt ?? null
        );
      } catch (err) {
        console.error(`[TaskManager] onTaskStatusChanged callback threw for task ${task.id}:`, err);
      }

      // Emit internal event for module communication
      try {
        this.ctx.emitTaskStatusChanged({
          taskId: task.id,
          prevStatus: prev,
          newStatus: status,
          duration: task.duration
        });
      } catch (err) {
        console.error(`[TaskManager] Internal event listener threw for task ${task.id}:`, err);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Task Locking
  // --------------------------------------------------------------------------

  /**
   * Lock a task for a worker
   * @returns true if lock acquired, false if already locked
   */
  lockTask(taskId: string, workerId: number): boolean {
    if (this.ctx.taskLocks.has(taskId)) return false;
    this.ctx.taskLocks.set(taskId, workerId);

    const task = this.ctx.tasks.get(taskId);
    if (task) {
      task.workerId = workerId;
      this.setTaskStatus(task, 'running');
    }
    return true;
  }

  /**
   * Unlock a task
   */
  unlockTask(taskId: string): void {
    this.ctx.taskLocks.delete(taskId);
    const task = this.ctx.tasks.get(taskId);
    if (task) {
      task.workerId = undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Task Finding
  // --------------------------------------------------------------------------

  /**
   * Find tasks that can be executed in the current wave
   * Respects wave gating, locks, and dependencies
   */
  findExecutableTasks(): Task[] {
    const lockedTaskIds = new Set(this.ctx.taskLocks.keys());
    const assignedTaskIds = new Set(
      this.ctx.getActiveWorkers().map(w => w.assignedTaskId)
    );

    // Find incomplete tasks (treat failed-with-retry as incomplete for wave gating)
    const incompleteTasks = [...this.ctx.tasks.values()].filter(
      t =>
        t.status !== 'success' &&
        t.status !== 'canceled' &&
        (t.status !== 'failed' || t.nextRetryAt !== undefined)
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
        this.canExecute(t)
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Check if all tasks completed successfully
   */
  isAllTasksSuccess(): boolean {
    if (this.ctx.tasks.size === 0) return false;
    return [...this.ctx.tasks.values()].every(t => t.status === 'success');
  }

  /**
   * Get tasks sorted by wave and ID
   */
  getTasksSorted(): Task[] {
    return this.ctx.getTasksSorted();
  }

  // --------------------------------------------------------------------------
  // Task Initialization
  // --------------------------------------------------------------------------

  /**
   * Initialize tasks from parsed AUTO-DEV.md file
   * Respects terminal states (success/failed) from file, recalculates others
   */
  initializeTasks(parsedTasks: Map<string, Task>): void {
    this.ctx.tasks.clear();
    this.ctx.taskLocks.clear();

    for (const [id, task] of parsedTasks) {
      const status = task.status === 'success' || task.status === 'failed' || task.status === 'canceled'
        ? task.status
        : 'pending';
      this.ctx.tasks.set(id, { ...task, status });
    }

    // Update tasks whose dependencies are already satisfied to 'ready'
    for (const task of this.ctx.tasks.values()) {
      if (task.status === 'pending' && this.canExecute(task)) {
        task.status = 'ready';
      }
    }
  }

  /**
   * Reset a task for manual retry
   */
  resetTaskForRetry(taskId: string): boolean {
    const task = this.ctx.tasks.get(taskId);
    if (!task || task.status !== 'failed') return false;

    // Reset auto-retry state on manual retry
    task.retryCount = 0;
    task.nextRetryAt = undefined;

    const nextStatus = this.canExecute(task) ? 'ready' : 'pending';
    this.setTaskStatus(task, nextStatus);
    return true;
  }
}
