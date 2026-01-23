/**
 * Session Persistence
 *
 * Handles debounced session persistence and hydration.
 * Extracted from scheduler-service.ts for modularity.
 */

import type { AutoRetryConfig, Issue, Task } from '../../shared/types';
import {
  SchedulerSessionStore,
  type SchedulerPauseReason,
  type SchedulerSessionSnapshot,
  type PersistedTaskState
} from '../scheduler-session-store';

// Re-export for convenience
export type { SchedulerPauseReason, SchedulerSessionSnapshot, PersistedTaskState };

// ============================================================================
// Types
// ============================================================================

/**
 * State provider interface for building snapshots
 */
export interface SessionStateProvider {
  getFilePath(): string;
  getProjectRoot(): string;
  isPaused(): boolean;
  getPauseReason(): SchedulerPauseReason | null;
  getAutoRetryConfig(): AutoRetryConfig;
  isBlockerAutoPauseEnabled(): boolean;
  getTasks(): Iterable<Task>;
  getIssues(): Issue[];
}

/**
 * Callbacks for applying restored state
 */
export interface SessionHydrateCallbacks {
  restoreIssues(issues: Issue[]): void;
  applyTaskState(taskId: string, state: PersistedTaskState, now: number): void;
}

// ============================================================================
// Helper
// ============================================================================

function safeAsync(promise: Promise<unknown>, context: string): void {
  promise.catch((err: unknown) => {
    console.warn(`[${context}] Async error (non-fatal):`, err);
  });
}

// ============================================================================
// SessionPersistence Class
// ============================================================================

export class SessionPersistence {
  private readonly store = new SchedulerSessionStore();
  private readonly stateProvider: SessionStateProvider;

  private persistTimer: NodeJS.Timeout | null = null;
  private persistNonce = 0;
  private debounceMs = 750;

  constructor(stateProvider: SessionStateProvider) {
    this.stateProvider = stateProvider;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Request a debounced persist operation.
   * Multiple rapid calls will be coalesced.
   */
  request(reason: string): void {
    const filePath = this.stateProvider.getFilePath();
    if (!filePath) return;
    if (this.persistTimer) return;

    const nonce = this.persistNonce;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (nonce !== this.persistNonce) return;
      safeAsync(this.persistNow(`debounce:${reason}`), 'SessionPersistence.persistNow');
    }, this.debounceMs);
    this.persistTimer.unref?.();
  }

  /**
   * Immediately persist the current state.
   */
  async persistNow(reason: string): Promise<void> {
    const filePath = this.stateProvider.getFilePath();
    if (!filePath) return;

    const snapshot = this.buildSnapshot();
    try {
      await this.store.writeSnapshot(filePath, snapshot);
    } catch (err) {
      console.error(`[SessionPersistence] Failed to persist (${reason}):`, err);
    }
  }

  /**
   * Hydrate state from stored session.
   */
  async hydrate(callbacks: SessionHydrateCallbacks): Promise<void> {
    const filePath = this.stateProvider.getFilePath();
    if (!filePath) return;

    let snapshot: SchedulerSessionSnapshot | null = null;
    try {
      snapshot = await this.store.readSnapshot(filePath);
    } catch (err) {
      console.warn('[SessionPersistence] Failed to read snapshot:', err);
      return;
    }
    if (!snapshot) return;

    // Verify file path matches (case-insensitive on Windows)
    const sameFile = process.platform === 'win32'
      ? snapshot.filePath.toLowerCase() === filePath.toLowerCase()
      : snapshot.filePath === filePath;
    if (!sameFile) return;

    // Restore issues
    callbacks.restoreIssues(snapshot.issues ?? []);

    // Restore task runtime state
    const now = Date.now();
    for (const [taskId, st] of Object.entries(snapshot.taskStates ?? {})) {
      callbacks.applyTaskState(taskId, st, now);
    }

    console.log(`[SessionPersistence] Restored session for ${filePath}`);
  }

  /**
   * Clear pending persist timer.
   * Call this before loading a new file.
   */
  clearTimer(): void {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
  }

  /**
   * Invalidate pending operations (increment nonce).
   * Call this when loading a new file.
   */
  invalidate(): void {
    this.persistNonce++;
    this.clearTimer();
  }

  /**
   * Clear stored session for a file.
   */
  async clearSession(filePath: string): Promise<void> {
    await this.store.clearSnapshot(filePath);
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private buildSnapshot(): SchedulerSessionSnapshot {
    const taskStates: SchedulerSessionSnapshot['taskStates'] = {};

    for (const task of this.stateProvider.getTasks()) {
      taskStates[task.id] = {
        status: task.status,
        duration: task.duration,
        startTime: task.startTime,
        endTime: task.endTime,
        retryCount: task.retryCount,
        nextRetryAt: task.nextRetryAt,
        hasModifiedCode: task.hasModifiedCode,
        apiErrorRetryCount: task.apiErrorRetryCount,
        isApiErrorRecovery: task.isApiErrorRecovery
      };
    }

    return {
      version: 1,
      savedAt: new Date().toISOString(),
      filePath: this.stateProvider.getFilePath(),
      projectRoot: this.stateProvider.getProjectRoot(),
      paused: this.stateProvider.isPaused(),
      pausedReason: this.stateProvider.getPauseReason(),
      autoRetryConfig: { ...this.stateProvider.getAutoRetryConfig() },
      blockerAutoPauseEnabled: this.stateProvider.isBlockerAutoPauseEnabled(),
      taskStates,
      issues: this.stateProvider.getIssues()
    };
  }
}
