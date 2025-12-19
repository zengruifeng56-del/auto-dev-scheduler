/**
 * Log Manager - 简化版
 * 仅负责任务日志的持久化存储
 */
import { app } from 'electron';
import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import type { LogEntry } from '../shared/types';

// ============================================================================
// Helpers
// ============================================================================

const pad2 = (n: number): string => String(n).padStart(2, '0');

function formatLogFileName(date = new Date()): string {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const h = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const s = pad2(date.getSeconds());
  return `${y}-${m}-${d}-${h}${mi}${s}.log`;
}

function normalizeTaskId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('taskId cannot be empty');
  const safe = trimmed.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!safe) throw new Error('taskId is invalid');
  return safe;
}

// ============================================================================
// Types
// ============================================================================

export interface LogManagerConfig {
  logsRootDir?: string;
  retentionDays?: number;
  maxTaskBytes?: number;
}

interface TaskState {
  queue: Promise<void>;
  logFile: string | null;
}

// ============================================================================
// LogManager Class
// ============================================================================

export class LogManager {
  private logsRootResolved: string | null = null;

  private readonly logsRootOverride?: string;
  private readonly retentionMs: number;
  private readonly maxTaskBytes: number;

  private readonly states = new Map<string, TaskState>();

  constructor(config: LogManagerConfig = {}) {
    this.logsRootOverride = config.logsRootDir;
    const days = config.retentionDays ?? 7;
    this.retentionMs = Math.max(0, days) * 24 * 60 * 60 * 1000;
    this.maxTaskBytes = config.maxTaskBytes ?? 5 * 1024 * 1024;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  async startTaskLog(taskId: string): Promise<void> {
    const id = normalizeTaskId(taskId);
    const state = this.getState(id);
    return this.enqueue(id, () => this.doStartTaskLog(id, state));
  }

  async appendLog(taskId: string, entry: LogEntry): Promise<void> {
    const id = normalizeTaskId(taskId);
    const state = this.getState(id);
    return this.enqueue(id, () => this.doAppendLog(id, state, entry));
  }

  async endTaskLog(taskId: string): Promise<void> {
    const id = normalizeTaskId(taskId);
    const state = this.getState(id);
    return this.enqueue(id, () => this.doEndTaskLog(id, state));
  }

  async clearTaskLogs(taskId: string): Promise<void> {
    const id = normalizeTaskId(taskId);
    const state = this.getState(id);

    return this.enqueue(id, async () => {
      const taskDir = await this.getTaskDirPath(id);
      await rm(taskDir, { recursive: true, force: true });
      state.logFile = null;
      this.states.delete(id);
    });
  }

  // --------------------------------------------------------------------------
  // State Management
  // --------------------------------------------------------------------------

  private getState(taskId: string): TaskState {
    let state = this.states.get(taskId);
    if (!state) {
      state = { queue: Promise.resolve(), logFile: null };
      this.states.set(taskId, state);
    }
    return state;
  }

  private enqueue(taskId: string, op: () => Promise<void>): Promise<void> {
    const state = this.getState(taskId);
    state.queue = state.queue.catch(() => undefined).then(op);
    return state.queue;
  }

  // --------------------------------------------------------------------------
  // Directory Resolution
  // --------------------------------------------------------------------------

  private async getLogsRootDir(): Promise<string> {
    if (this.logsRootResolved) return this.logsRootResolved;

    if (this.logsRootOverride) {
      this.logsRootResolved = path.resolve(this.logsRootOverride);
      return this.logsRootResolved;
    }

    await app.whenReady();
    this.logsRootResolved = path.join(app.getPath('userData'), 'logs');
    return this.logsRootResolved;
  }

  private async getTaskDirPath(taskId: string): Promise<string> {
    const root = await this.getLogsRootDir();
    return path.join(root, taskId);
  }

  private async ensureTaskDir(taskId: string): Promise<string> {
    const dir = await this.getTaskDirPath(taskId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  // --------------------------------------------------------------------------
  // Core Operations
  // --------------------------------------------------------------------------

  private async doStartTaskLog(taskId: string, state: TaskState): Promise<void> {
    if (state.logFile) return;

    const taskDir = await this.ensureTaskDir(taskId);
    await this.cleanupTaskDir(taskDir);

    const logFile = formatLogFileName();
    state.logFile = logFile;

    const logPath = path.join(taskDir, logFile);
    await appendFile(logPath, '', 'utf8');
  }

  private async doAppendLog(taskId: string, state: TaskState, entry: LogEntry): Promise<void> {
    if (!state.logFile) {
      await this.doStartTaskLog(taskId, state);
    }
    if (!state.logFile) return;

    const taskDir = await this.ensureTaskDir(taskId);
    const logPath = path.join(taskDir, state.logFile);
    await appendFile(logPath, this.formatLogLine(entry), 'utf8');
  }

  private async doEndTaskLog(taskId: string, state: TaskState): Promise<void> {
    if (!state.logFile) return;

    const taskDir = await this.ensureTaskDir(taskId);
    await this.cleanupTaskDir(taskDir, state.logFile);

    state.logFile = null;
    this.states.delete(taskId);
  }

  // --------------------------------------------------------------------------
  // Log Formatting
  // --------------------------------------------------------------------------

  private formatLogLine(entry: LogEntry): string {
    const iso = new Date().toISOString();
    const safeContent = entry.content.replace(/\r?\n/g, '\\n');
    return `[${iso}] [${entry.ts}] [${entry.type}] ${safeContent}\n`;
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  private async cleanupTaskDir(taskDir: string, keepLogFile?: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(taskDir, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    const now = Date.now();
    const logFiles: Array<{ name: string; fullPath: string; mtimeMs: number; size: number }> = [];

    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.log')) continue;

      const fullPath = path.join(taskDir, ent.name);
      let st;
      try {
        st = await stat(fullPath);
      } catch {
        continue;
      }

      // Delete expired logs
      if (this.retentionMs > 0 && now - st.mtimeMs > this.retentionMs) {
        try { await rm(fullPath, { force: true }); } catch { /* ignore */ }
        continue;
      }

      logFiles.push({ name: ent.name, fullPath, mtimeMs: st.mtimeMs, size: st.size });
    }

    // Delete oldest logs if exceeding max size
    let totalBytes = logFiles.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes <= this.maxTaskBytes) return;

    logFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const f of logFiles) {
      if (keepLogFile && f.name === keepLogFile) continue;
      try { await rm(f.fullPath, { force: true }); } catch { /* ignore */ }
      totalBytes -= f.size;
      if (totalBytes <= this.maxTaskBytes) return;
    }
  }
}
