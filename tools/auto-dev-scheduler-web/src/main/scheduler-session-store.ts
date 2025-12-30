/**
 * Scheduler Session Store - 会话状态持久化
 * 存储位置: userData/sessions/<sha1(filePath)>.json
 * 按文件隔离，存储 Issues、任务状态、暂停原因等
 */

import { app } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import type { AutoRetryConfig, Issue, TaskStatus } from '../shared/types';

// ============================================================================
// Types
// ============================================================================

export type SchedulerPauseReason = 'user' | 'blocker';

export interface PersistedTaskState {
  status: TaskStatus;
  duration?: number;
  startTime?: string;
  endTime?: string;
  retryCount?: number;
  nextRetryAt?: number;
}

export interface SchedulerSessionSnapshotV1 {
  version: 1;
  savedAt: string;
  filePath: string;
  projectRoot: string;
  paused: boolean;
  pausedReason: SchedulerPauseReason | null;
  autoRetryConfig: AutoRetryConfig;
  blockerAutoPauseEnabled: boolean;
  taskStates: Record<string, PersistedTaskState>;
  issues: Issue[];
}

export type SchedulerSessionSnapshot = SchedulerSessionSnapshotV1;

// ============================================================================
// Helpers
// ============================================================================

interface SessionPaths {
  rootDir: string;
  jsonPath: string;
  tmpPath: string;
  bakPath: string;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const VALID_TASK_STATUS = new Set<TaskStatus>([
  'pending', 'ready', 'running', 'success', 'failed', 'canceled'
]);

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && VALID_TASK_STATUS.has(value as TaskStatus);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(
  fromPath: string,
  toPath: string,
  options: { allowMissing?: boolean } = {}
): Promise<void> {
  const { allowMissing = false } = options;
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rename(fromPath, toPath);
      return;
    } catch (err: unknown) {
      const code = isErrnoException(err) ? err.code : undefined;
      if (allowMissing && code === 'ENOENT') return;
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
        await sleep(25 * attempt);
        continue;
      }
      throw err;
    }
  }
}

async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const fh = await open(filePath, 'w');
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
}

function normalizeFileKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function computeSessionId(filePath: string): string {
  return createHash('sha1')
    .update(normalizeFileKey(filePath))
    .digest('hex')
    .slice(0, 16);
}

// ============================================================================
// Store Class
// ============================================================================

export class SchedulerSessionStore {
  private sessionsRootResolved: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  async readSnapshot(filePath: string): Promise<SchedulerSessionSnapshot | null> {
    await this.queue.catch(() => undefined);
    return this.doReadSnapshot(filePath);
  }

  async writeSnapshot(filePath: string, snapshot: SchedulerSessionSnapshot): Promise<void> {
    return this.enqueue(() => this.doWriteSnapshot(filePath, snapshot));
  }

  async clearSnapshot(filePath: string): Promise<void> {
    return this.enqueue(async () => {
      const paths = await this.getSessionPaths(filePath);
      await rm(paths.jsonPath, { force: true });
      await rm(paths.bakPath, { force: true });
      await rm(paths.tmpPath, { force: true });
    });
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    this.queue = this.queue.catch(() => undefined).then(op);
    return this.queue;
  }

  private async getSessionsRootDir(): Promise<string> {
    if (this.sessionsRootResolved) return this.sessionsRootResolved;

    await app.whenReady();
    this.sessionsRootResolved = path.join(app.getPath('userData'), 'sessions');
    return this.sessionsRootResolved;
  }

  private async getSessionPaths(filePath: string): Promise<SessionPaths> {
    const rootDir = await this.getSessionsRootDir();
    const id = computeSessionId(filePath);
    return {
      rootDir,
      jsonPath: path.join(rootDir, `${id}.json`),
      tmpPath: path.join(rootDir, `${id}.json.tmp`),
      bakPath: path.join(rootDir, `${id}.json.bak`)
    };
  }

  private async tryLoad(pathStr: string): Promise<SchedulerSessionSnapshot | null> {
    let text: string;
    try {
      text = await readFile(pathStr, 'utf8');
    } catch (err: unknown) {
      if (isErrnoException(err) && err.code === 'ENOENT') return null;
      throw err;
    }

    const trimmed = text.replace(/^\uFEFF/, '').trim();
    if (!trimmed) return null;

    try {
      const raw = JSON.parse(trimmed) as unknown;
      return this.sanitizeSnapshot(raw);
    } catch {
      return null;
    }
  }

  private sanitizeSnapshot(raw: unknown): SchedulerSessionSnapshot | null {
    if (!isPlainObject(raw)) return null;
    const obj = raw as Record<string, unknown>;
    if (obj.version !== 1) return null;

    const filePath = typeof obj.filePath === 'string' ? obj.filePath : '';
    const projectRoot = typeof obj.projectRoot === 'string' ? obj.projectRoot : '';
    if (!filePath || !projectRoot) return null;

    const savedAt = typeof obj.savedAt === 'string' ? obj.savedAt : new Date().toISOString();
    const paused = typeof obj.paused === 'boolean' ? obj.paused : false;

    const pausedReasonRaw = obj.pausedReason;
    const pausedReason: SchedulerPauseReason | null =
      pausedReasonRaw === 'user' || pausedReasonRaw === 'blocker' ? pausedReasonRaw : null;

    const autoRetryConfigRaw = obj.autoRetryConfig as Partial<AutoRetryConfig> | undefined;
    const autoRetryConfig: AutoRetryConfig = {
      enabled: typeof autoRetryConfigRaw?.enabled === 'boolean' ? autoRetryConfigRaw.enabled : true,
      maxRetries: typeof autoRetryConfigRaw?.maxRetries === 'number' ? autoRetryConfigRaw.maxRetries : 2,
      baseDelayMs: typeof autoRetryConfigRaw?.baseDelayMs === 'number' ? autoRetryConfigRaw.baseDelayMs : 5_000
    };

    const blockerAutoPauseEnabled =
      typeof obj.blockerAutoPauseEnabled === 'boolean' ? obj.blockerAutoPauseEnabled : true;

    const taskStates: Record<string, PersistedTaskState> = {};
    const taskStatesRaw = obj.taskStates;
    if (isPlainObject(taskStatesRaw)) {
      for (const [taskId, st] of Object.entries(taskStatesRaw)) {
        if (!taskId || !isPlainObject(st)) continue;
        const s = st as Record<string, unknown>;
        if (!isTaskStatus(s.status)) continue;

        taskStates[taskId] = {
          status: s.status,
          duration: typeof s.duration === 'number' ? s.duration : undefined,
          startTime: typeof s.startTime === 'string' ? s.startTime : undefined,
          endTime: typeof s.endTime === 'string' ? s.endTime : undefined,
          retryCount: typeof s.retryCount === 'number' ? Math.max(0, Math.floor(s.retryCount)) : undefined,
          nextRetryAt: typeof s.nextRetryAt === 'number' ? Math.floor(s.nextRetryAt) : undefined
        };
      }
    }

    const issues = Array.isArray(obj.issues) ? (obj.issues as Issue[]) : [];

    return {
      version: 1,
      savedAt,
      filePath,
      projectRoot,
      paused,
      pausedReason,
      autoRetryConfig,
      blockerAutoPauseEnabled,
      taskStates,
      issues
    };
  }

  private async doReadSnapshot(filePath: string): Promise<SchedulerSessionSnapshot | null> {
    const paths = await this.getSessionPaths(filePath);

    const main = await this.tryLoad(paths.jsonPath);
    if (main) return main;

    const bak = await this.tryLoad(paths.bakPath);
    if (bak) return bak;

    const tmp = await this.tryLoad(paths.tmpPath);
    if (tmp) return tmp;

    return null;
  }

  private async doWriteSnapshot(filePath: string, snapshot: SchedulerSessionSnapshot): Promise<void> {
    const paths = await this.getSessionPaths(filePath);
    await mkdir(paths.rootDir, { recursive: true });

    const payload = JSON.stringify(snapshot, null, 2) + '\n';
    await writeFileAtomic(paths.tmpPath, payload);

    try {
      await renameWithRetry(paths.jsonPath, paths.bakPath, { allowMissing: true });
    } catch {
      // ignore backup rotation failures
    }

    try {
      await renameWithRetry(paths.tmpPath, paths.jsonPath, { allowMissing: false });
    } finally {
      try { await rm(paths.tmpPath, { force: true }); } catch { /* ignore */ }
    }
  }
}
