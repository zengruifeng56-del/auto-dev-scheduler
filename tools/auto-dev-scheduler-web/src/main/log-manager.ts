/**
 * Log Manager
 * Task-level log persistence and checkpoint recovery (meta.json) management
 *
 * Directory structure:
 * logs/
 * ├── {taskId}/
 * │   ├── YYYY-MM-DD-HHMMSS.log
 * │   └── meta.json
 */
import { app } from 'electron';
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  LogEntry,
  RecoveryCheckpoint,
  RecoveryContext,
  TaskLogRunStatus
} from '../shared/types';

// ============================================================================
// Internal Types
// ============================================================================

interface TaskRunMeta {
  startTime: string;
  endTime: string | null;
  status: TaskLogRunStatus;
  logFile: string;
  checkpoint: RecoveryCheckpoint;
}

interface TaskMeta {
  taskId: string;
  lastRun: TaskRunMeta;
}

interface TaskState {
  queue: Promise<void>;
  buffered: LogEntry[];
  current: {
    startTime: string;
    logFile: string;
    checkpoint: RecoveryCheckpoint;
  } | null;
}

export interface LogManagerConfig {
  logsRootDir?: string;
  retentionDays?: number;
  maxTaskBytes?: number;
  maxBufferedEntries?: number;
}

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

function basename(p: string): string {
  return path.posix.basename(p.replace(/\\/g, '/'));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function coerceCheckpoint(v: unknown): RecoveryCheckpoint {
  if (!isRecord(v)) return { completedSteps: [], nextStep: '' };

  const stepsRaw = v.completedSteps;
  const nextRaw = v.nextStep;

  const completedSteps = Array.isArray(stepsRaw)
    ? stepsRaw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(-100)
    : [];

  const nextStep = typeof nextRaw === 'string' ? nextRaw.trim().slice(0, 200) : '';

  return { completedSteps, nextStep };
}

function coerceRunStatus(v: unknown): TaskLogRunStatus | undefined {
  return v === 'completed' || v === 'interrupted' ? v : undefined;
}

// ============================================================================
// LogManager Class
// ============================================================================

export class LogManager {
  private logsRootResolved: string | null = null;

  private readonly logsRootOverride?: string;
  private readonly retentionMs: number;
  private readonly maxTaskBytes: number;
  private readonly maxBufferedEntries: number;

  private readonly states = new Map<string, TaskState>();

  constructor(config: LogManagerConfig = {}) {
    this.logsRootOverride = config.logsRootDir;
    const days = config.retentionDays ?? 7;
    this.retentionMs = Math.max(0, days) * 24 * 60 * 60 * 1000;
    this.maxTaskBytes = config.maxTaskBytes ?? 5 * 1024 * 1024;
    this.maxBufferedEntries = config.maxBufferedEntries ?? 2000;
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

  async endTaskLog(taskId: string, status: TaskLogRunStatus): Promise<void> {
    const id = normalizeTaskId(taskId);
    const state = this.getState(id);
    return this.enqueue(id, () => this.doEndTaskLog(id, state, status));
  }

  async getRecoveryContext(taskId: string): Promise<RecoveryContext | null> {
    const id = normalizeTaskId(taskId);
    const state = this.getState(id);
    await state.queue.catch(() => undefined);

    const meta = await this.readMeta(id);
    if (!meta || meta.lastRun.status !== 'interrupted') return null;

    const taskDir = await this.getTaskDirPath(id);
    const logFilePath = path.join(taskDir, meta.lastRun.logFile);

    return {
      taskId: meta.taskId,
      logDir: taskDir,
      logFile: meta.lastRun.logFile,
      logFilePath,
      startTime: meta.lastRun.startTime,
      endTime: meta.lastRun.endTime,
      status: meta.lastRun.status,
      checkpoint: meta.lastRun.checkpoint
    };
  }

  async clearTaskLogs(taskId: string): Promise<void> {
    const id = normalizeTaskId(taskId);
    const state = this.getState(id);

    return this.enqueue(id, async () => {
      const taskDir = await this.getTaskDirPath(id);
      await rm(taskDir, { recursive: true, force: true });
      state.current = null;
      state.buffered = [];
      this.states.delete(id);
    });
  }

  // --------------------------------------------------------------------------
  // State Management
  // --------------------------------------------------------------------------

  private getState(taskId: string): TaskState {
    let state = this.states.get(taskId);
    if (!state) {
      state = { queue: Promise.resolve(), buffered: [], current: null };
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

  private async getMetaPath(taskId: string): Promise<string> {
    const taskDir = await this.getTaskDirPath(taskId);
    return path.join(taskDir, 'meta.json');
  }

  // --------------------------------------------------------------------------
  // Core Operations
  // --------------------------------------------------------------------------

  private async doStartTaskLog(taskId: string, state: TaskState): Promise<void> {
    if (state.current) return;

    const taskDir = await this.ensureTaskDir(taskId);
    await this.cleanupTaskDir(taskDir);

    const now = new Date();
    const startTime = now.toISOString();
    const logFile = formatLogFileName(now);
    const checkpoint: RecoveryCheckpoint = { completedSteps: [], nextStep: '' };

    state.current = { startTime, logFile, checkpoint };

    const meta: TaskMeta = {
      taskId,
      lastRun: { startTime, endTime: null, status: 'interrupted', logFile, checkpoint }
    };
    await this.writeMeta(taskId, meta);

    const logPath = path.join(taskDir, logFile);
    await appendFile(logPath, '', 'utf8');

    if (state.buffered.length > 0) {
      for (const entry of state.buffered) {
        await appendFile(logPath, this.formatLogLine(entry), 'utf8');
        this.updateCheckpoint(checkpoint, entry);
      }
      state.buffered = [];
      await this.writeMeta(taskId, meta);
    }
  }

  private async doAppendLog(taskId: string, state: TaskState, entry: LogEntry): Promise<void> {
    if (!state.current) {
      state.buffered.push(entry);
      while (state.buffered.length > this.maxBufferedEntries) state.buffered.shift();
      return;
    }

    const taskDir = await this.ensureTaskDir(taskId);
    const logPath = path.join(taskDir, state.current.logFile);
    await appendFile(logPath, this.formatLogLine(entry), 'utf8');

    const changed = this.updateCheckpoint(state.current.checkpoint, entry);
    if (changed) {
      await this.writeMeta(taskId, {
        taskId,
        lastRun: {
          startTime: state.current.startTime,
          endTime: null,
          status: 'interrupted',
          logFile: state.current.logFile,
          checkpoint: state.current.checkpoint
        }
      });
    }
  }

  private async doEndTaskLog(taskId: string, state: TaskState, status: TaskLogRunStatus): Promise<void> {
    if (!state.current) {
      if (state.buffered.length === 0) return;
      await this.doStartTaskLog(taskId, state);
    }
    if (!state.current) return;

    const taskDir = await this.ensureTaskDir(taskId);
    const meta: TaskMeta = {
      taskId,
      lastRun: {
        startTime: state.current.startTime,
        endTime: status === 'completed' ? new Date().toISOString() : null,
        status,
        logFile: state.current.logFile,
        checkpoint: state.current.checkpoint
      }
    };

    await this.writeMeta(taskId, meta);
    await this.cleanupTaskDir(taskDir, state.current.logFile);

    state.current = null;
    state.buffered = [];
    this.states.delete(taskId);
  }

  // --------------------------------------------------------------------------
  // Meta I/O
  // --------------------------------------------------------------------------

  private async readMeta(taskId: string): Promise<TaskMeta | null> {
    const metaPath = await this.getMetaPath(taskId);

    let raw: string;
    try {
      raw = await readFile(metaPath, 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }

    if (!isRecord(parsed)) return null;

    const id = asString(parsed.taskId) ?? taskId;
    const lastRunRaw = parsed.lastRun;
    if (!isRecord(lastRunRaw)) return null;

    const startTime = asString(lastRunRaw.startTime);
    const endTimeRaw = lastRunRaw.endTime;
    const status = coerceRunStatus(lastRunRaw.status);
    const logFile = asString(lastRunRaw.logFile);
    const checkpoint = coerceCheckpoint(lastRunRaw.checkpoint);

    const endTime = endTimeRaw === null ? null : typeof endTimeRaw === 'string' ? endTimeRaw : null;

    if (!startTime || !status || !logFile) return null;

    return {
      taskId: id,
      lastRun: { startTime, endTime, status, logFile, checkpoint }
    };
  }

  private async writeMeta(taskId: string, meta: TaskMeta): Promise<void> {
    const metaPath = await this.getMetaPath(taskId);
    const content = `${JSON.stringify(meta, null, 2)}\n`;
    await this.writeFileAtomic(metaPath, content);
  }

  private async writeFileAtomic(targetPath: string, content: string): Promise<void> {
    const dir = path.dirname(targetPath);
    await mkdir(dir, { recursive: true });

    const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmpPath, content, 'utf8');

    try {
      await rename(tmpPath, targetPath);
      return;
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST' && e.code !== 'EPERM') {
        try { await rm(tmpPath, { force: true }); } catch { /* ignore */ }
        throw err;
      }
    }

    await rm(targetPath, { force: true });
    await rename(tmpPath, targetPath);
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
  // Checkpoint Extraction
  // --------------------------------------------------------------------------

  private updateCheckpoint(checkpoint: RecoveryCheckpoint, entry: LogEntry): boolean {
    let changed = false;

    const nextStep = this.extractNextStep(entry.content);
    if (nextStep && nextStep !== checkpoint.nextStep) {
      checkpoint.nextStep = nextStep;
      changed = true;
    }

    const steps = this.extractCompletedSteps(entry.content);
    for (const s of steps) {
      if (!checkpoint.completedSteps.includes(s)) {
        checkpoint.completedSteps.push(s);
        changed = true;
      }
    }

    if (checkpoint.completedSteps.length > 100) {
      checkpoint.completedSteps = checkpoint.completedSteps.slice(-100);
      changed = true;
    }

    return changed;
  }

  private extractCompletedSteps(content: string): string[] {
    const lower = content.toLowerCase();

    const isCreate = /create_text_file|write_file|new file|created|added/.test(lower) ||
                     /创建|已创建|新增|生成/.test(content);
    const isUpdate = /apply_patch|replace_|insert_|rename_|updated|changed/.test(lower) ||
                     /修改|已更新|变更/.test(content);

    const fileRe = /([A-Za-z0-9_.\-\/\\]+?\.(?:ts|tsx|js|jsx|json|md|txt|yml|yaml|vue|css|scss))/g;
    const found = new Set<string>();

    for (const m of content.matchAll(fileRe)) {
      const raw = m[1];
      if (!raw) continue;
      const base = basename(raw);
      if (!base) continue;

      if (isCreate) found.add(`${base} created`);
      else if (isUpdate) found.add(`${base} updated`);
    }

    return [...found];
  }

  private extractNextStep(content: string): string | null {
    const patterns: RegExp[] = [
      /\bnext\s*step\s*[:：]\s*([A-Za-z0-9_.\-\/\\]+?\.[A-Za-z0-9]+)\b/i,
      /\bnext\s*[:：]\s*([A-Za-z0-9_.\-\/\\]+?\.[A-Za-z0-9]+)\b/i,
      /下一步\s*[:：]\s*([A-Za-z0-9_.\-\/\\]+?\.[A-Za-z0-9]+)\b/,
      /建议(?:从|先)?\s*([A-Za-z0-9_.\-\/\\]+?\.(?:ts|tsx|js|jsx|json|md|txt|vue))\s*(?:开始|继续)/i
    ];

    for (const re of patterns) {
      const m = re.exec(content);
      const candidate = m?.[1]?.trim();
      if (!candidate) continue;
      return basename(candidate).slice(0, 200);
    }

    return null;
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

      if (this.retentionMs > 0 && now - st.mtimeMs > this.retentionMs) {
        try { await rm(fullPath, { force: true }); } catch { /* ignore */ }
        continue;
      }

      logFiles.push({ name: ent.name, fullPath, mtimeMs: st.mtimeMs, size: st.size });
    }

    let totalBytes = logFiles.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes <= this.maxTaskBytes) return;

    logFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const f of logFiles) {
      if (keepLogFile && f.name === keepLogFile) continue;
      try { await rm(f.fullPath, { force: true }); } catch { /* ignore */ }
      totalBytes -= f.size;
      if (totalBytes <= this.maxTaskBytes) return;
    }

    if (keepLogFile) {
      const keep = logFiles.find((f) => f.name === keepLogFile);
      if (keep) {
        await this.truncateFileToTail(keep.fullPath, this.maxTaskBytes);
      }
    }
  }

  private async truncateFileToTail(filePath: string, maxBytes: number): Promise<void> {
    if (maxBytes <= 0) {
      await writeFile(filePath, '', 'utf8');
      return;
    }

    const st = await stat(filePath);
    if (st.size <= maxBytes) return;

    const fd = await open(filePath, 'r');
    try {
      const start = Math.max(0, st.size - maxBytes);
      const buf = Buffer.allocUnsafe(Math.min(maxBytes, st.size));
      const { bytesRead } = await fd.read(buf, 0, buf.length, start);
      let slice = buf.subarray(0, bytesRead);

      // Skip incomplete UTF-8 leading bytes
      let skipBytes = 0;
      while (skipBytes < slice.length && (slice[skipBytes]! & 0xC0) === 0x80) {
        skipBytes++;
      }
      if (skipBytes > 0) {
        slice = slice.subarray(skipBytes);
      }

      await writeFile(filePath, slice);
    } finally {
      await fd.close();
    }
  }
}
