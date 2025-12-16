/**
 * Worker 健康监控（Watchdog）
 * - 基于规则（Layer 1）快速判断：进程存活/明确错误/慢操作等待/工具调用超时
 * - 必要时触发 AI 诊断（Layer 2）：拉起独立 Claude 诊断进程并解析 JSON 决策
 * - 输出操作日志：logs/watchdog-operations.log（JSON Lines）
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

// ============================================================================
// Type Helpers
// ============================================================================

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string') return new Error(err);
  return new Error(String(err));
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen)}...`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function tryParseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function safeMs(n: unknown, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.max(0, Math.floor(v));
}

// ============================================================================
// Configuration Types (D7 Design)
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
  action: 'restart' | 'wait' | 'need_ai';
  reason: string;
  recoveryContext?: RecoveryContext;
}

// ============================================================================
// Worker & Recovery Types
// ============================================================================

export interface WorkerInfo {
  id: string;
  pid: number | null;
  taskId: string | null;
  logFile: string;
  lastActivity: number;
}

export interface RecoveryContext {
  workerId: string;
  pid: number | null;
  taskId: string | null;
  logFile: string;
  observedAtIso: string;
  observedAtMs: number;
  lastActivityMs: number;
  idleMs: number;
  rule?: 'rule1' | 'rule2' | 'rule3' | 'rule4' | 'ai';
  logTail?: string;
  matchedError?: string;
  pendingToolCalls?: PendingToolCallInfo[];
  ai?: {
    enabled: boolean;
    command?: string;
    args?: string[];
    timeoutMs?: number;
    assistantText?: string;
    parsed?: unknown;
    error?: string;
  };
}

export interface PendingToolCallInfo {
  callId: string;
  toolName: string;
  category: SlowToolKind;
  startedAtMs: number;
  ageMs: number;
  timeoutMs: number;
  detail?: string;
}

export interface WatchdogAIConfig {
  enabled?: boolean;
  timeoutMs?: number;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface WatchdogOptions {
  config?: Partial<WatchdogConfig>;
  ai?: WatchdogAIConfig;
  operationLogPath?: string;
  restartHandler?: (worker: WorkerInfo, context: RecoveryContext) => Promise<void> | void;
  waitHandler?: (worker: WorkerInfo, context: RecoveryContext) => Promise<void> | void;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
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

const DEFAULT_AI_CONFIG = {
  enabled: true,
  timeoutMs: 120_000
};

const LOG_TAIL_MAX_BYTES = 256 * 1024;
const LOG_TAIL_MAX_CHARS_IN_CONTEXT = 20_000;
const LOG_TAIL_MAX_CHARS_IN_OPLOG = 8_000;
const AI_TEXT_MAX_CHARS_IN_CONTEXT = 20_000;
const AI_TEXT_MAX_CHARS_IN_OPLOG = 8_000;

// ============================================================================
// Internal Types
// ============================================================================

interface PendingToolCall {
  callId: string;
  toolName: string;
  category: SlowToolKind;
  startedAtMs: number;
  lastUpdateMs: number;
  detail?: string;
}

interface OperationLogEntry {
  ts: string;
  action: DiagnosisResult['action'];
  reason: string;
  workerId: string;
  pid: number | null;
  taskId: string | null;
  source: string;
  context?: RecoveryContext;
}

// ============================================================================
// Watchdog Class
// ============================================================================

export class Watchdog extends EventEmitter {
  private readonly config: WatchdogConfig;
  private readonly ai: WatchdogAIConfig;
  private readonly operationLogPath: string;
  private readonly restartHandler?: WatchdogOptions['restartHandler'];
  private readonly waitHandler?: WatchdogOptions['waitHandler'];

  private timer: NodeJS.Timeout | null = null;
  private tickInProgress = false;

  private workers = new Map<string, WorkerInfo>();
  private pendingToolCalls = new Map<string, Map<string, PendingToolCall>>();

  constructor(options: WatchdogOptions = {}) {
    super();
    this.config = {
      ...DEFAULT_WATCHDOG_CONFIG,
      ...options.config,
      slowToolTimeouts: {
        ...DEFAULT_WATCHDOG_CONFIG.slowToolTimeouts,
        ...(options.config?.slowToolTimeouts ?? {})
      }
    };

    this.ai = { ...DEFAULT_AI_CONFIG, ...(options.ai ?? {}) };
    this.operationLogPath =
      options.operationLogPath ?? path.resolve(process.cwd(), 'logs', 'watchdog-operations.log');
    this.restartHandler = options.restartHandler;
    this.waitHandler = options.waitHandler;
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
      logFile: '',
      lastActivity: atMs
    });
  }

  // --------------------------------------------------------------------------
  // Tool Call Tracking (for Rule 3/4)
  // --------------------------------------------------------------------------

  recordToolCallStarted(workerId: string, toolName: string, callId: string, detail?: string): void {
    const byWorker = this.pendingToolCalls.get(workerId) ?? new Map<string, PendingToolCall>();
    this.pendingToolCalls.set(workerId, byWorker);

    const category = this.inferToolCategory(toolName, detail);
    const nowMs = Date.now();
    byWorker.set(callId, {
      callId,
      toolName,
      category,
      startedAtMs: nowMs,
      lastUpdateMs: nowMs,
      detail
    });

    this.touch(workerId, nowMs);
  }

  recordToolCallProgress(workerId: string, callId: string): void {
    const byWorker = this.pendingToolCalls.get(workerId);
    const existing = byWorker?.get(callId);
    if (!existing) return;
    const nowMs = Date.now();
    existing.lastUpdateMs = nowMs;
    this.touch(workerId, nowMs);
  }

  recordToolCallResult(workerId: string, callId: string): void {
    const byWorker = this.pendingToolCalls.get(workerId);
    if (!byWorker) return;
    byWorker.delete(callId);
    if (byWorker.size === 0) this.pendingToolCalls.delete(workerId);
    this.touch(workerId, Date.now());
  }

  clearToolCalls(workerId: string): void {
    this.pendingToolCalls.delete(workerId);
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  start(): void {
    this.stop();
    if (this.config.checkIntervalMs <= 0) return;

    this.timer = setInterval(() => {
      void this.runOnce(true, 'interval');
    }, this.config.checkIntervalMs);
    this.timer.unref?.();

    void this.runOnce(false, 'start');
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
      this.config.checkIntervalMs = safeMs(partial.checkIntervalMs, DEFAULT_WATCHDOG_CONFIG.checkIntervalMs);
    }
    if (partial.activityTimeoutMs !== undefined) {
      this.config.activityTimeoutMs = safeMs(partial.activityTimeoutMs, DEFAULT_WATCHDOG_CONFIG.activityTimeoutMs);
    }
    if (partial.slowToolTimeouts) {
      const timeouts = partial.slowToolTimeouts;
      if (timeouts.codex !== undefined) {
        this.config.slowToolTimeouts.codex = safeMs(timeouts.codex, DEFAULT_WATCHDOG_CONFIG.slowToolTimeouts.codex);
      }
      if (timeouts.gemini !== undefined) {
        this.config.slowToolTimeouts.gemini = safeMs(timeouts.gemini, DEFAULT_WATCHDOG_CONFIG.slowToolTimeouts.gemini);
      }
      if (timeouts.npmInstall !== undefined) {
        this.config.slowToolTimeouts.npmInstall = safeMs(timeouts.npmInstall, DEFAULT_WATCHDOG_CONFIG.slowToolTimeouts.npmInstall);
      }
      if (timeouts.npmBuild !== undefined) {
        this.config.slowToolTimeouts.npmBuild = safeMs(timeouts.npmBuild, DEFAULT_WATCHDOG_CONFIG.slowToolTimeouts.npmBuild);
      }
      if (timeouts.default !== undefined) {
        this.config.slowToolTimeouts.default = safeMs(timeouts.default, DEFAULT_WATCHDOG_CONFIG.slowToolTimeouts.default);
      }
    }

    // Restart timer if interval changed and was running
    if (this.timer && this.config.checkIntervalMs !== prevInterval) {
      this.start();
    }
  }

  // --------------------------------------------------------------------------
  // Main Loop
  // --------------------------------------------------------------------------

  async runOnce(executeRecovery = true, source = 'manual'): Promise<void> {
    if (this.tickInProgress) return;
    this.tickInProgress = true;

    try {
      const nowMs = Date.now();
      for (const worker of this.workers.values()) {
        const diagnosis = await this.diagnose(worker, nowMs);
        this.emit('diagnosis', worker, diagnosis);

        if (!executeRecovery) continue;

        if (diagnosis.action === 'restart') {
          await this.restart(worker, diagnosis.recoveryContext ?? this.baseContext(worker, nowMs), source);
          continue;
        }

        if (diagnosis.action === 'wait') {
          const ctx = diagnosis.recoveryContext ?? this.baseContext(worker, nowMs);
          const shouldLog = Boolean(ctx.pendingToolCalls?.length) || ctx.idleMs > this.config.activityTimeoutMs;
          if (shouldLog) await this.wait(worker, ctx, source);
          continue;
        }

        await this.appendOperationLog({
          ts: nowIso(),
          action: 'need_ai',
          reason: diagnosis.reason,
          workerId: worker.id,
          pid: worker.pid,
          taskId: worker.taskId,
          source,
          context: diagnosis.recoveryContext ? this.sanitizeContextForLog(diagnosis.recoveryContext) : undefined
        });
      }
    } catch (err: unknown) {
      this.emitErrorSafe(toError(err));
    } finally {
      this.tickInProgress = false;
    }
  }

  // --------------------------------------------------------------------------
  // Diagnosis Entry: Layer 1 → Layer 2
  // --------------------------------------------------------------------------

  private async diagnose(worker: WorkerInfo, nowMs: number): Promise<DiagnosisResult> {
    const rules = await this.diagnoseByRules(worker, nowMs);
    if (rules.action !== 'need_ai') return rules;
    return await this.diagnoseByAI(worker, nowMs, rules.recoveryContext);
  }

  // --------------------------------------------------------------------------
  // Layer 1: Rule-based Diagnosis
  // --------------------------------------------------------------------------

  private async diagnoseByRules(worker: WorkerInfo, nowMs: number): Promise<DiagnosisResult> {
    const ctx = this.baseContext(worker, nowMs);

    // Rule 1: Process dead → restart (skip if pid unknown)
    if (worker.pid !== null && !this.isProcessAlive(worker.pid)) {
      ctx.rule = 'rule1';
      return {
        action: 'restart',
        reason: 'Rule1: 进程不存在或已退出',
        recoveryContext: ctx
      };
    }

    // Read log tail for Rule 2 and AI fallback
    const tail = worker.logFile ? await this.safeReadLogTail(worker.logFile) : null;
    if (tail) ctx.logTail = truncate(tail, LOG_TAIL_MAX_CHARS_IN_CONTEXT);

    // Rule 2: Log has clear errors → restart
    if (tail) {
      const hit = this.findClearError(tail);
      if (hit) {
        ctx.rule = 'rule2';
        ctx.matchedError = hit;
        return {
          action: 'restart',
          reason: `Rule2: 日志出现明确错误：${hit}`,
          recoveryContext: ctx
        };
      }
    }

    // Rule 3/4: Tool call timeouts
    const pending = this.getPendingToolCalls(worker.id, nowMs);
    if (pending.length > 0) {
      ctx.pendingToolCalls = pending;

      const worst = pending
        .slice()
        .sort((a, b) => (b.ageMs / Math.max(1, b.timeoutMs)) - (a.ageMs / Math.max(1, a.timeoutMs)))[0];

      if (worst && worst.ageMs > worst.timeoutMs) {
        ctx.rule = worst.category === 'default' ? 'rule4' : 'rule3';
        const timeoutMin = Math.round(worst.timeoutMs / 60_000);
        const ageMin = Math.round(worst.ageMs / 60_000);
        return {
          action: 'restart',
          reason: `Rule${ctx.rule === 'rule4' ? '4' : '3'}: 工具调用超时无结果（${worst.toolName}，已等待${ageMin}min，阈值${timeoutMin}min）`,
          recoveryContext: ctx
        };
      }

      ctx.rule = 'rule3';
      const oldest = pending.reduce((acc, p) => (p.ageMs > acc.ageMs ? p : acc), pending[0]);
      const remainMs = Math.max(0, oldest.timeoutMs - oldest.ageMs);
      const remainMin = Math.ceil(remainMs / 60_000);
      return {
        action: 'wait',
        reason: `Rule3: 正在等待慢操作/工具结果（${oldest.toolName}），剩余约${remainMin}min 超时`,
        recoveryContext: ctx
      };
    }

    // No pending, but exceeded activity timeout → need AI
    if (ctx.idleMs > this.config.activityTimeoutMs) {
      return {
        action: 'need_ai',
        reason: `无活动超过阈值（${Math.round(ctx.idleMs / 60_000)}min），需要 AI 诊断确认是否卡死`,
        recoveryContext: ctx
      };
    }

    // Healthy
    return {
      action: 'wait',
      reason: '健康状态：无需处理',
      recoveryContext: ctx
    };
  }

  // --------------------------------------------------------------------------
  // Layer 2: AI Diagnosis
  // --------------------------------------------------------------------------

  private async diagnoseByAI(worker: WorkerInfo, nowMs: number, base?: RecoveryContext): Promise<DiagnosisResult> {
    const ctx = base ? { ...base } : this.baseContext(worker, nowMs);
    ctx.rule = 'ai';

    const enabled = this.ai.enabled ?? DEFAULT_AI_CONFIG.enabled;
    if (!enabled) {
      ctx.ai = { enabled: false };
      return {
        action: 'need_ai',
        reason: 'AI 诊断未启用（ai.enabled=false）',
        recoveryContext: ctx
      };
    }

    const aiTimeoutMs = safeMs(this.ai.timeoutMs, DEFAULT_AI_CONFIG.timeoutMs);
    const resolved = this.resolveClaudeCommand();
    ctx.ai = {
      enabled: true,
      command: resolved.command,
      args: resolved.args,
      timeoutMs: aiTimeoutMs
    };

    const prompt = this.buildAIDiagnosticPrompt(worker, ctx);

    try {
      const assistantText = await this.spawnClaudeAndCollectText(prompt, aiTimeoutMs, resolved.command, resolved.args);
      ctx.ai.assistantText = truncate(assistantText, AI_TEXT_MAX_CHARS_IN_CONTEXT);

      const parsed = this.parseAIDecision(assistantText);
      ctx.ai.parsed = parsed ?? undefined;

      if (!parsed) {
        return {
          action: 'need_ai',
          reason: 'AI 返回无法解析为合法 JSON 决策（需人工介入）',
          recoveryContext: ctx
        };
      }

      return {
        action: parsed.action,
        reason: `AI: ${parsed.reason}`,
        recoveryContext: ctx
      };
    } catch (err: unknown) {
      const e = toError(err);
      ctx.ai.error = e.message;
      return {
        action: 'need_ai',
        reason: `AI 诊断失败：${e.message}`,
        recoveryContext: ctx
      };
    }
  }

  private buildAIDiagnosticPrompt(worker: WorkerInfo, ctx: RecoveryContext): string {
    const pending = (ctx.pendingToolCalls ?? [])
      .map(p => `- ${p.toolName} (${p.category}) age=${Math.round(p.ageMs / 1000)}s timeout=${Math.round(p.timeoutMs / 1000)}s callId=${p.callId}`)
      .join('\n');

    const tail = ctx.logTail ? truncate(ctx.logTail, LOG_TAIL_MAX_CHARS_IN_CONTEXT) : '';

    return [
      '你是一个"Worker 健康诊断"代理（Watchdog Diagnostic Agent）。',
      '请基于输入信息判断：此 worker 是否需要重启、继续等待、或仍需人工/更多信息。',
      '',
      '输出要求：',
      '1) 只输出一个 JSON 对象（不要 Markdown，不要代码块，不要解释性文字）。',
      '2) JSON 必须符合：{ "action": "restart"|"wait"|"need_ai", "reason": string }',
      '3) reason 使用中文，简洁明确，包含关键证据（例如日志关键字/超时信息）。',
      '',
      '输入信息：',
      `- workerId: ${worker.id}`,
      `- pid: ${worker.pid ?? 'null'}`,
      `- taskId: ${worker.taskId ?? 'null'}`,
      `- logFile: ${worker.logFile || '(empty)'}`,
      `- idleMs: ${ctx.idleMs} (${Math.round(ctx.idleMs / 60_000)}min)`,
      '',
      pending ? `- pendingToolCalls:\n${pending}` : '- pendingToolCalls: (none)',
      '',
      tail ? `- logTail (truncated):\n${tail}` : '- logTail: (empty/unavailable)',
      '',
      '现在给出你的 JSON 决策：'
    ].join('\n');
  }

  // --------------------------------------------------------------------------
  // Recovery Execution
  // --------------------------------------------------------------------------

  async restart(worker: WorkerInfo, context: RecoveryContext, source = 'watchdog'): Promise<void> {
    const ctx = this.sanitizeContextForLog(context);

    await this.appendOperationLog({
      ts: nowIso(),
      action: 'restart',
      reason: '执行重启',
      workerId: worker.id,
      pid: worker.pid,
      taskId: worker.taskId,
      source,
      context: ctx
    });

    this.emit('restart', worker, context);

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
        await this.restartHandler(worker, context);
      } catch (err: unknown) {
        this.emitErrorSafe(toError(err));
      }
    }
  }

  async wait(worker: WorkerInfo, context: RecoveryContext, source = 'watchdog'): Promise<void> {
    const ctx = this.sanitizeContextForLog(context);

    await this.appendOperationLog({
      ts: nowIso(),
      action: 'wait',
      reason: '继续等待',
      workerId: worker.id,
      pid: worker.pid,
      taskId: worker.taskId,
      source,
      context: ctx
    });

    this.emit('wait', worker, context);

    if (this.waitHandler) {
      try {
        await this.waitHandler(worker, context);
      } catch (err: unknown) {
        this.emitErrorSafe(toError(err));
      }
    }
  }

  // --------------------------------------------------------------------------
  // Private: Helpers
  // --------------------------------------------------------------------------

  private baseContext(worker: WorkerInfo, nowMs: number): RecoveryContext {
    const last = Number.isFinite(worker.lastActivity) ? worker.lastActivity : 0;
    const idle = Math.max(0, nowMs - last);
    return {
      workerId: worker.id,
      pid: worker.pid,
      taskId: worker.taskId,
      logFile: worker.logFile,
      observedAtIso: new Date(nowMs).toISOString(),
      observedAtMs: nowMs,
      lastActivityMs: last,
      idleMs: idle
    };
  }

  private sanitizeContextForLog(ctx: RecoveryContext): RecoveryContext {
    const cloned: RecoveryContext = { ...ctx };
    if (cloned.logTail) cloned.logTail = truncate(cloned.logTail, LOG_TAIL_MAX_CHARS_IN_OPLOG);
    if (cloned.ai?.assistantText) {
      cloned.ai = { ...cloned.ai, assistantText: truncate(cloned.ai.assistantText, AI_TEXT_MAX_CHARS_IN_OPLOG) };
    }
    return cloned;
  }

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

  private getPendingToolCalls(workerId: string, nowMs: number): PendingToolCallInfo[] {
    const byWorker = this.pendingToolCalls.get(workerId);
    if (!byWorker || byWorker.size === 0) return [];

    const list: PendingToolCallInfo[] = [];
    for (const call of byWorker.values()) {
      const timeoutMs = this.config.slowToolTimeouts[call.category] ?? this.config.slowToolTimeouts.default;
      list.push({
        callId: call.callId,
        toolName: call.toolName,
        category: call.category,
        startedAtMs: call.startedAtMs,
        ageMs: Math.max(0, nowMs - call.startedAtMs),
        timeoutMs,
        detail: call.detail
      });
    }
    return list;
  }

  private inferToolCategory(toolName: string, detail?: string): SlowToolKind {
    const raw = `${toolName} ${detail ?? ''}`.toLowerCase();

    if (raw.includes('codex')) return 'codex';
    if (raw.includes('gemini')) return 'gemini';
    if (raw.includes('npm') && raw.includes('install')) return 'npmInstall';
    if (raw.includes('npm') && raw.includes('build')) return 'npmBuild';
    if (raw.includes('npm run build')) return 'npmBuild';

    return 'default';
  }

  private findClearError(logTail: string): string | null {
    const patterns: RegExp[] = [
      /\b504\b/i,
      /\btimeout\b/i,
      /\beconnreset\b/i,
      /\betimedout\b/i
    ];

    const lines = logTail.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] ?? '';
      for (const re of patterns) {
        if (re.test(line)) return truncate(line.trim(), 500);
      }
    }
    return null;
  }

  private async safeReadLogTail(filePath: string): Promise<string | null> {
    try {
      const abs = path.resolve(filePath);
      const s = await stat(abs);
      const size = s.size;
      const start = Math.max(0, size - LOG_TAIL_MAX_BYTES);
      const len = Math.max(0, size - start);
      if (len === 0) return '';

      const fh = await open(abs, 'r');
      try {
        const buf = Buffer.alloc(len);
        await fh.read({ buffer: buf, offset: 0, length: len, position: start });
        return buf.toString('utf8').replace(/^\uFEFF/, '');
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  }

  private emitErrorSafe(err: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  // --------------------------------------------------------------------------
  // Private: AI Helpers
  // --------------------------------------------------------------------------

  private resolveClaudeCommand(): { command: string; args: string[] } {
    if (this.ai.command && Array.isArray(this.ai.args)) {
      return { command: this.ai.command, args: this.ai.args };
    }

    if (process.platform === 'win32') {
      const cmdLine =
        'chcp 65001 >nul && claude --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions';
      return { command: 'cmd.exe', args: ['/c', cmdLine] };
    }

    return {
      command: 'claude',
      args: ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']
    };
  }

  private async spawnClaudeAndCollectText(
    prompt: string,
    timeoutMs: number,
    command: string,
    args: string[]
  ): Promise<string> {
    const cwd = this.ai.cwd ?? process.cwd();
    const env = { ...process.env, ...(this.ai.env ?? {}) };

    return await new Promise<string>((resolve, reject) => {
      const child: ChildProcessWithoutNullStreams = spawn(command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });

      child.stdin.setDefaultEncoding('utf8');
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      const stdoutRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const stderrRl = createInterface({ input: child.stderr, crlfDelay: Infinity });

      const assistantChunks: string[] = [];
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        reject(new Error(`AI 诊断超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);

      const finish = (err: Error | null, text?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { stdoutRl.close(); } catch { /* ignore */ }
        try { stderrRl.close(); } catch { /* ignore */ }
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        if (err) reject(err);
        else resolve(text ?? '');
      };

      stdoutRl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        const parsed = tryParseJson(trimmed);
        if (!isRecord(parsed)) return;

        const type = asString(parsed.type);
        if (type === 'assistant') {
          const msg = parsed.message;
          if (!isRecord(msg)) return;
          const content = msg.content;
          if (!Array.isArray(content)) return;
          for (const block of content) {
            if (!isRecord(block)) continue;
            if (asString(block.type) !== 'text') continue;
            const t = asString(block.text);
            if (t) assistantChunks.push(t);
          }
          return;
        }

        if (type === 'result') {
          finish(null, assistantChunks.join('\n'));
        }
      });

      stderrRl.on('line', () => {
        // Claude CLI may write system logs to stderr; don't fail immediately
      });

      child.once('error', (err) => finish(toError(err)));
      child.once('exit', () => {
        if (!done) finish(null, assistantChunks.join('\n'));
      });

      const msg = { type: 'user', message: { role: 'user', content: prompt } };
      try {
        child.stdin.write(`${JSON.stringify(msg)}\n`, 'utf8');
      } catch (err: unknown) {
        finish(toError(err));
      }
    });
  }

  private parseAIDecision(assistantText: string): { action: DiagnosisResult['action']; reason: string } | null {
    const raw = extractFirstJsonObject(assistantText) ?? assistantText.trim();
    const parsed = tryParseJson(raw);
    if (!isRecord(parsed)) return null;

    const action = asString(parsed.action);
    const reason = asString(parsed.reason);
    if (!action || !reason) return null;

    if (action !== 'restart' && action !== 'wait' && action !== 'need_ai') return null;
    return { action, reason };
  }

  // --------------------------------------------------------------------------
  // Private: Operation Log
  // --------------------------------------------------------------------------

  private async appendOperationLog(entry: OperationLogEntry): Promise<void> {
    try {
      const abs = path.resolve(this.operationLogPath);
      const dir = path.dirname(abs);
      await mkdir(dir, { recursive: true });
      await appendFile(abs, `${JSON.stringify(entry)}\n`, 'utf8');
      this.emit('operationLogged', entry);
    } catch (err: unknown) {
      this.emitErrorSafe(toError(err));
    }
  }
}

// ============================================================================
// EventEmitter Type Augmentation
// ============================================================================

export interface Watchdog {
  on(event: 'diagnosis', listener: (worker: WorkerInfo, result: DiagnosisResult) => void): this;
  on(event: 'restart', listener: (worker: WorkerInfo, context: RecoveryContext) => void): this;
  on(event: 'wait', listener: (worker: WorkerInfo, context: RecoveryContext) => void): this;
  on(event: 'operationLogged', listener: (entry: OperationLogEntry) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;

  once(event: 'diagnosis', listener: (worker: WorkerInfo, result: DiagnosisResult) => void): this;
  once(event: 'restart', listener: (worker: WorkerInfo, context: RecoveryContext) => void): this;
  once(event: 'wait', listener: (worker: WorkerInfo, context: RecoveryContext) => void): this;
  once(event: 'operationLogged', listener: (entry: OperationLogEntry) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;

  emit(event: 'diagnosis', worker: WorkerInfo, result: DiagnosisResult): boolean;
  emit(event: 'restart', worker: WorkerInfo, context: RecoveryContext): boolean;
  emit(event: 'wait', worker: WorkerInfo, context: RecoveryContext): boolean;
  emit(event: 'operationLogged', entry: OperationLogEntry): boolean;
  emit(event: 'error', error: Error): boolean;
}
