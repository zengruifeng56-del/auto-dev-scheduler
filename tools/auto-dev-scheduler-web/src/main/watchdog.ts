/**
 * Worker 健康监控（Watchdog）- 简化版
 * 仅基于规则判断：进程存活/明确错误/工具调用超时
 */

import { EventEmitter } from 'node:events';

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string') return new Error(err);
  return new Error(String(err));
}

function safeMs(n: unknown, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.max(0, Math.floor(v));
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface WatchdogConfig {
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

export type SlowToolKind = keyof WatchdogConfig['slowToolTimeouts'];

export interface DiagnosisResult {
  action: 'restart' | 'wait';
  reason: string;
}

// ============================================================================
// Worker Types
// ============================================================================

export interface WorkerInfo {
  id: string;
  pid: number | null;
  taskId: string | null;
  lastActivity: number;
}

interface PendingToolCall {
  callId: string;
  toolName: string;
  category: SlowToolKind;
  startedAtMs: number;
}

export interface WatchdogOptions {
  config?: Partial<WatchdogConfig>;
  restartHandler?: (worker: WorkerInfo) => Promise<void> | void;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONFIG: WatchdogConfig = {
  checkIntervalMs: 5 * 60_000,
  activityTimeoutMs: 10 * 60_000,
  slowToolTimeouts: {
    codex: 60 * 60_000,
    gemini: 60 * 60_000,
    npmInstall: 15 * 60_000,
    npmBuild: 20 * 60_000,
    default: 10 * 60_000
  }
};

// ============================================================================
// Watchdog Class
// ============================================================================

export class Watchdog extends EventEmitter {
  private readonly config: WatchdogConfig;
  private readonly restartHandler?: WatchdogOptions['restartHandler'];

  private timer: NodeJS.Timeout | null = null;
  private tickInProgress = false;

  private workers = new Map<string, WorkerInfo>();
  private pendingToolCalls = new Map<string, Map<string, PendingToolCall>>();

  constructor(options: WatchdogOptions = {}) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...options.config,
      slowToolTimeouts: {
        ...DEFAULT_CONFIG.slowToolTimeouts,
        ...(options.config?.slowToolTimeouts ?? {})
      }
    };
    this.restartHandler = options.restartHandler;
  }

  // --------------------------------------------------------------------------
  // Worker Management
  // --------------------------------------------------------------------------

  upsertWorker(worker: WorkerInfo): void {
    const lastActivity = Number.isFinite(worker.lastActivity) ? worker.lastActivity : Date.now();
    this.workers.set(worker.id, { ...worker, lastActivity });
  }

  removeWorker(workerId: string): void {
    this.workers.delete(workerId);
    this.pendingToolCalls.delete(workerId);
  }

  touch(workerId: string, atMs = Date.now()): void {
    const existing = this.workers.get(workerId);
    if (existing) {
      existing.lastActivity = atMs;
      return;
    }
    this.workers.set(workerId, {
      id: workerId,
      pid: null,
      taskId: null,
      lastActivity: atMs
    });
  }

  // --------------------------------------------------------------------------
  // Tool Call Tracking
  // --------------------------------------------------------------------------

  recordToolCallStarted(workerId: string, toolName: string, callId: string): void {
    const byWorker = this.pendingToolCalls.get(workerId) ?? new Map<string, PendingToolCall>();
    this.pendingToolCalls.set(workerId, byWorker);

    const category = this.inferToolCategory(toolName);
    byWorker.set(callId, {
      callId,
      toolName,
      category,
      startedAtMs: Date.now()
    });

    this.touch(workerId);
  }

  clearToolCalls(workerId: string): void {
    this.pendingToolCalls.delete(workerId);
    this.touch(workerId);
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  start(): void {
    this.stop();
    if (this.config.checkIntervalMs <= 0) return;

    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.config.checkIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stop();
    this.workers.clear();
    this.pendingToolCalls.clear();
  }

  // --------------------------------------------------------------------------
  // Config Accessors
  // --------------------------------------------------------------------------

  getConfig(): WatchdogConfig {
    return { ...this.config, slowToolTimeouts: { ...this.config.slowToolTimeouts } };
  }

  updateConfig(partial: Partial<WatchdogConfig>): void {
    const prevInterval = this.config.checkIntervalMs;

    if (partial.checkIntervalMs !== undefined) {
      this.config.checkIntervalMs = safeMs(partial.checkIntervalMs, DEFAULT_CONFIG.checkIntervalMs);
    }
    if (partial.activityTimeoutMs !== undefined) {
      this.config.activityTimeoutMs = safeMs(partial.activityTimeoutMs, DEFAULT_CONFIG.activityTimeoutMs);
    }
    if (partial.slowToolTimeouts) {
      const t = partial.slowToolTimeouts;
      if (t.codex !== undefined) this.config.slowToolTimeouts.codex = safeMs(t.codex, DEFAULT_CONFIG.slowToolTimeouts.codex);
      if (t.gemini !== undefined) this.config.slowToolTimeouts.gemini = safeMs(t.gemini, DEFAULT_CONFIG.slowToolTimeouts.gemini);
      if (t.npmInstall !== undefined) this.config.slowToolTimeouts.npmInstall = safeMs(t.npmInstall, DEFAULT_CONFIG.slowToolTimeouts.npmInstall);
      if (t.npmBuild !== undefined) this.config.slowToolTimeouts.npmBuild = safeMs(t.npmBuild, DEFAULT_CONFIG.slowToolTimeouts.npmBuild);
      if (t.default !== undefined) this.config.slowToolTimeouts.default = safeMs(t.default, DEFAULT_CONFIG.slowToolTimeouts.default);
    }

    if (this.timer && this.config.checkIntervalMs !== prevInterval) {
      this.start();
    }
  }

  // --------------------------------------------------------------------------
  // Main Loop
  // --------------------------------------------------------------------------

  async runOnce(): Promise<void> {
    if (this.tickInProgress) return;
    this.tickInProgress = true;

    try {
      const nowMs = Date.now();
      for (const worker of this.workers.values()) {
        const diagnosis = this.diagnose(worker, nowMs);
        this.emit('diagnosis', worker, diagnosis);

        if (diagnosis.action === 'restart') {
          await this.restart(worker);
        }
      }
    } catch (err: unknown) {
      this.emitErrorSafe(toError(err));
    } finally {
      this.tickInProgress = false;
    }
  }

  // --------------------------------------------------------------------------
  // Rule-based Diagnosis (simplified)
  // --------------------------------------------------------------------------

  private diagnose(worker: WorkerInfo, nowMs: number): DiagnosisResult {
    const idleMs = Math.max(0, nowMs - (worker.lastActivity || 0));

    // Rule 1: Process dead
    if (worker.pid !== null && !this.isProcessAlive(worker.pid)) {
      return { action: 'restart', reason: '进程不存在或已退出' };
    }

    // Rule 2: Tool call timeout
    const pending = this.getPendingToolCalls(worker.id, nowMs);
    if (pending.length > 0) {
      const worst = pending.sort((a, b) => b.ageMs - a.ageMs)[0];
      if (worst && worst.ageMs > worst.timeoutMs) {
        const timeoutMin = Math.round(worst.timeoutMs / 60_000);
        const ageMin = Math.round(worst.ageMs / 60_000);
        return {
          action: 'restart',
          reason: `工具调用超时（${worst.toolName}，已等待${ageMin}min，阈值${timeoutMin}min）`
        };
      }
      // Still waiting for tool result
      return { action: 'wait', reason: `等待工具结果（${pending[0]?.toolName}）` };
    }

    // Rule 3: Activity timeout (no pending tool calls)
    if (idleMs > this.config.activityTimeoutMs) {
      const idleMin = Math.round(idleMs / 60_000);
      return { action: 'restart', reason: `无活动超时（${idleMin}min）` };
    }

    return { action: 'wait', reason: '健康' };
  }

  // --------------------------------------------------------------------------
  // Recovery
  // --------------------------------------------------------------------------

  private async restart(worker: WorkerInfo): Promise<void> {
    this.emit('restart', worker);

    // Try to kill existing process
    if (this.isProcessAlive(worker.pid) && worker.pid) {
      try { process.kill(worker.pid, 'SIGTERM'); } catch { /* ignore */ }
      await new Promise<void>((r) => setTimeout(r, 1_000));
      if (this.isProcessAlive(worker.pid)) {
        try { process.kill(worker.pid, 'SIGKILL'); } catch { /* ignore */ }
      }
    }

    if (this.restartHandler) {
      try {
        await this.restartHandler(worker);
      } catch (err: unknown) {
        this.emitErrorSafe(toError(err));
      }
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private isProcessAlive(pid: number | null): boolean {
    if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      return e?.code === 'EPERM';
    }
  }

  private getPendingToolCalls(workerId: string, nowMs: number): Array<{ toolName: string; ageMs: number; timeoutMs: number }> {
    const byWorker = this.pendingToolCalls.get(workerId);
    if (!byWorker || byWorker.size === 0) return [];

    return [...byWorker.values()].map(call => ({
      toolName: call.toolName,
      ageMs: Math.max(0, nowMs - call.startedAtMs),
      timeoutMs: this.config.slowToolTimeouts[call.category] ?? this.config.slowToolTimeouts.default
    }));
  }

  private inferToolCategory(toolName: string): SlowToolKind {
    const raw = toolName.toLowerCase();
    if (raw.includes('codex')) return 'codex';
    if (raw.includes('gemini')) return 'gemini';
    if (raw.includes('npm') && raw.includes('install')) return 'npmInstall';
    if (raw.includes('npm') && raw.includes('build')) return 'npmBuild';
    return 'default';
  }

  private emitErrorSafe(err: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }
}

// ============================================================================
// EventEmitter Type Augmentation
// ============================================================================

export interface Watchdog {
  on(event: 'diagnosis', listener: (worker: WorkerInfo, result: DiagnosisResult) => void): this;
  on(event: 'restart', listener: (worker: WorkerInfo) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;

  emit(event: 'diagnosis', worker: WorkerInfo, result: DiagnosisResult): boolean;
  emit(event: 'restart', worker: WorkerInfo): boolean;
  emit(event: 'error', error: Error): boolean;
}
