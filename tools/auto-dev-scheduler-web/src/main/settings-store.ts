/**
 * Settings Store - 全局配置持久化
 * 存储位置: userData/settings.json
 * 跨项目生效的配置（Watchdog、AutoRetry、BlockerAutoPause）
 */

import { app } from 'electron';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import type { WatchdogConfig } from './watchdog';
import type { AutoRetryConfig } from '../shared/types';

// ============================================================================
// Types
// ============================================================================

export interface SchedulerConfig {
  blockerAutoPauseEnabled: boolean;
}

export interface AppSettingsV1 {
  version: 1;
  savedAt: string;
  watchdog: WatchdogConfig;
  autoRetry: AutoRetryConfig;
  scheduler: SchedulerConfig;
}

export type AppSettings = AppSettingsV1;

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_SETTINGS: AppSettingsV1 = {
  version: 1,
  savedAt: new Date().toISOString(),
  watchdog: {
    checkIntervalMs: 5 * 60_000,
    activityTimeoutMs: 10 * 60_000,
    slowToolTimeouts: {
      codex: 60 * 60_000,
      gemini: 60 * 60_000,
      npmInstall: 15 * 60_000,
      npmBuild: 20 * 60_000,
      default: 10 * 60_000
    }
  },
  autoRetry: {
    enabled: true,
    maxRetries: 2,
    baseDelayMs: 5_000
  },
  scheduler: {
    blockerAutoPauseEnabled: true
  }
};

// ============================================================================
// Helpers
// ============================================================================

interface SettingsPaths {
  dir: string;
  json: string;
  tmp: string;
  bak: string;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function mergeWatchdog(base: WatchdogConfig, patch: unknown): WatchdogConfig {
  if (!isPlainObject(patch)) return base;
  const p = patch as Partial<WatchdogConfig>;

  const slowToolTimeouts =
    isPlainObject(p.slowToolTimeouts)
      ? { ...base.slowToolTimeouts, ...(p.slowToolTimeouts as Partial<WatchdogConfig['slowToolTimeouts']>) }
      : base.slowToolTimeouts;

  return {
    checkIntervalMs: typeof p.checkIntervalMs === 'number' ? p.checkIntervalMs : base.checkIntervalMs,
    activityTimeoutMs: typeof p.activityTimeoutMs === 'number' ? p.activityTimeoutMs : base.activityTimeoutMs,
    slowToolTimeouts
  };
}

function mergeAutoRetry(base: AutoRetryConfig, patch: unknown): AutoRetryConfig {
  if (!isPlainObject(patch)) return base;
  const p = patch as Partial<AutoRetryConfig>;
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled,
    maxRetries: typeof p.maxRetries === 'number' ? p.maxRetries : base.maxRetries,
    baseDelayMs: typeof p.baseDelayMs === 'number' ? p.baseDelayMs : base.baseDelayMs
  };
}

function mergeScheduler(base: SchedulerConfig, patch: unknown): SchedulerConfig {
  if (!isPlainObject(patch)) return base;
  const p = patch as Partial<SchedulerConfig>;
  return {
    blockerAutoPauseEnabled: typeof p.blockerAutoPauseEnabled === 'boolean'
      ? p.blockerAutoPauseEnabled
      : base.blockerAutoPauseEnabled
  };
}

// ============================================================================
// Store Class
// ============================================================================

export class SettingsStore {
  private pathsResolved: SettingsPaths | null = null;
  private queue: Promise<void> = Promise.resolve();

  async load(): Promise<AppSettingsV1> {
    await this.queue.catch(() => undefined);
    const loaded = await this.doLoad();
    return loaded ?? { ...DEFAULT_SETTINGS };
  }

  async update(partial: Partial<Pick<AppSettingsV1, 'watchdog' | 'autoRetry' | 'scheduler'>>): Promise<AppSettingsV1> {
    return this.enqueue(async () => {
      const current = (await this.doLoad()) ?? DEFAULT_SETTINGS;
      const next: AppSettingsV1 = {
        version: 1,
        savedAt: new Date().toISOString(),
        watchdog: partial.watchdog ? mergeWatchdog(current.watchdog, partial.watchdog) : current.watchdog,
        autoRetry: partial.autoRetry ? mergeAutoRetry(current.autoRetry, partial.autoRetry) : current.autoRetry,
        scheduler: partial.scheduler ? mergeScheduler(current.scheduler, partial.scheduler) : current.scheduler
      };
      await this.doWrite(next);
      return next;
    });
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    let result!: T;
    let error: unknown = null;

    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        try {
          result = await op();
        } catch (err: unknown) {
          error = err;
        }
      });

    return this.queue.then(() => {
      if (error) throw error;
      return result;
    });
  }

  private async getPaths(): Promise<SettingsPaths> {
    if (this.pathsResolved) return this.pathsResolved;

    await app.whenReady();
    const dir = app.getPath('userData');
    this.pathsResolved = {
      dir,
      json: path.join(dir, 'settings.json'),
      tmp: path.join(dir, 'settings.json.tmp'),
      bak: path.join(dir, 'settings.json.bak')
    };
    return this.pathsResolved;
  }

  private async tryLoad(pathStr: string): Promise<AppSettingsV1 | null> {
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
      if (!isPlainObject(raw)) return null;
      const obj = raw as Record<string, unknown>;
      if (obj.version !== 1) return null;

      return {
        version: 1,
        savedAt: typeof obj.savedAt === 'string' ? obj.savedAt : new Date().toISOString(),
        watchdog: mergeWatchdog(DEFAULT_SETTINGS.watchdog, obj.watchdog),
        autoRetry: mergeAutoRetry(DEFAULT_SETTINGS.autoRetry, obj.autoRetry),
        scheduler: mergeScheduler(DEFAULT_SETTINGS.scheduler, obj.scheduler)
      };
    } catch {
      return null;
    }
  }

  private async doLoad(): Promise<AppSettingsV1 | null> {
    const paths = await this.getPaths();

    const main = await this.tryLoad(paths.json);
    if (main) return main;

    const bak = await this.tryLoad(paths.bak);
    if (bak) return bak;

    const tmp = await this.tryLoad(paths.tmp);
    if (tmp) return tmp;

    return null;
  }

  private async doWrite(settings: AppSettingsV1): Promise<void> {
    const paths = await this.getPaths();
    await mkdir(paths.dir, { recursive: true });

    const payload = JSON.stringify(settings, null, 2) + '\n';
    await writeFileAtomic(paths.tmp, payload);

    try {
      await renameWithRetry(paths.json, paths.bak, { allowMissing: true });
    } catch {
      // ignore backup rotation failures
    }

    try {
      await renameWithRetry(paths.tmp, paths.json, { allowMissing: false });
    } finally {
      try { await rm(paths.tmp, { force: true }); } catch { /* ignore */ }
    }
  }
}
