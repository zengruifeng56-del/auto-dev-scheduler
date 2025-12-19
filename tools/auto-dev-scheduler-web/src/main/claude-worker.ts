import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import treeKill from 'tree-kill';

import { TASK_ID_PATTERN } from '../shared/task-id';
import type { LogEntry, LogEntryType } from '../shared/types';

// ============================================================================
// Type Guards
// ============================================================================

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatTime(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function normalizeLine(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen)}...`;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.at(-1) || p;
}

function tryParseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string') return new Error(err);
  return new Error(String(err));
}

function formatToolName(name: string): string {
  return name.replace(/^mcp__/, '').replace(/__/g, ':');
}

// ============================================================================
// TaskId Detection
// ============================================================================

// Use unified Task ID pattern from shared module
const TASK_ID_REGEXES: RegExp[] = [
  new RegExp(`\\bTask:\\s*(${TASK_ID_PATTERN})\\b`, 'i'),
  new RegExp(`\\bTask\\s+(${TASK_ID_PATTERN})\\b`, 'i'),
  new RegExp(`\\bTaskId\\s*[:=]\\s*(${TASK_ID_PATTERN})\\b`, 'i'),
  new RegExp(`\\[\\s*(${TASK_ID_PATTERN})\\b`, 'i'),
  new RegExp(`(${TASK_ID_PATTERN})\\s*任务\\b`),
  new RegExp(`开始执行\\s*(${TASK_ID_PATTERN})`),
  new RegExp(`(?:抢占|锁定|执行)\\s*(${TASK_ID_PATTERN})`)
];

function extractTaskId(text: string): string | null {
  for (const re of TASK_ID_REGEXES) {
    const match = re.exec(text);
    if (match?.[1]) return match[1];
  }
  return null;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface SlowToolTimeouts {
  codex: number;
  gemini: number;
  npmInstall: number;
  npmBuild: number;
  default: number;
}

export interface WatchdogConfig {
  enabled: boolean;
  idleTimeoutMs: number;
  hardTimeoutMs?: number;
  tickMs: number;
  slowToolTimeouts: SlowToolTimeouts;
}

export interface ClaudeWorkerConfig {
  workerId?: number;
  /** Pre-assigned task ID from scheduler (for /auto-dev --task mode) */
  assignedTaskId?: string;
  watchdog?: Partial<WatchdogConfig> & { slowToolTimeouts?: Partial<SlowToolTimeouts> };
  startupMessage?: object | null;
  autoKillOnComplete?: boolean;
}

const DEFAULT_SLOW_TOOL_TIMEOUTS: SlowToolTimeouts = {
  codex: 60 * 60_000,      // 60 分钟
  gemini: 60 * 60_000,     // 60 分钟
  npmInstall: 15 * 60_000, // 15 分钟
  npmBuild: 20 * 60_000,   // 20 分钟
  default: 10 * 60_000     // 10 分钟
};

const DEFAULT_WATCHDOG: WatchdogConfig = {
  enabled: true,
  idleTimeoutMs: 5 * 60_000,
  hardTimeoutMs: undefined,
  tickMs: 1_000,
  slowToolTimeouts: DEFAULT_SLOW_TOOL_TIMEOUTS
};

// ============================================================================
// ClaudeWorker Class
// ============================================================================

export class ClaudeWorker extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutRl: ReadlineInterface | null = null;
  private stderrRl: ReadlineInterface | null = null;

  private startMs = 0;
  private lastActivityMs = 0;
  private watchdogTimer: NodeJS.Timeout | null = null;

  private completed = false;
  private killing = false;

  private taskId: string | null = null;
  private tokenUsage: string | null = null;
  private currentTool: string | null = null;
  private currentSlowToolCategory: keyof SlowToolTimeouts | null = null;
  private slowToolStartMs: number | null = null;

  readonly workerId?: number;
  /** Pre-assigned task ID from scheduler */
  readonly assignedTaskId?: string;
  private readonly watchdog: WatchdogConfig;
  private readonly startupMessage: object | null;
  private readonly autoKillOnComplete: boolean;

  constructor(config: ClaudeWorkerConfig = {}) {
    super();
    this.workerId = config.workerId;
    this.assignedTaskId = config.assignedTaskId;
    this.watchdog = {
      ...DEFAULT_WATCHDOG,
      ...config.watchdog,
      slowToolTimeouts: {
        ...DEFAULT_SLOW_TOOL_TIMEOUTS,
        ...(config.watchdog?.slowToolTimeouts ?? {})
      }
    };
    this.startupMessage = config.startupMessage === undefined
      ? { type: 'user', message: { role: 'user', content: '/auto-dev' } }
      : config.startupMessage;
    this.autoKillOnComplete = config.autoKillOnComplete ?? true;

    // If task is pre-assigned, set it immediately so scheduler can track
    if (this.assignedTaskId) {
      this.taskId = this.assignedTaskId;
    }
  }

  // --------------------------------------------------------------------------
  // Public Accessors
  // --------------------------------------------------------------------------

  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  get currentTaskId(): string | null {
    return this.taskId;
  }

  get currentTokenUsage(): string | null {
    return this.tokenUsage;
  }

  get currentToolName(): string | null {
    return this.currentTool;
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  async start(projectRoot: string): Promise<void> {
    if (this.process) {
      throw new Error('ClaudeWorker already started');
    }

    this.reset();

    const cmdLine =
      'chcp 65001 >nul && claude --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions';

    const child = spawn('cmd.exe', ['/c', cmdLine], {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.process = child;
    this.startMs = Date.now();
    this.lastActivityMs = this.startMs;

    child.stdin.setDefaultEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    this.emitLog('start', `Claude CLI started (pid=${child.pid})`);

    this.setupEventHandlers(child);
    this.setupStreamParsers(child);
    this.startWatchdog();

    await this.waitForSpawn(child);

    if (this.startupMessage) {
      this.send(this.startupMessage);
    }
  }

  send(message: object): void {
    if (!this.process) {
      throw new Error('ClaudeWorker not started');
    }
    if (this.process.stdin.destroyed) {
      throw new Error('ClaudeWorker stdin closed');
    }

    let payload: string;
    try {
      payload = JSON.stringify(message);
    } catch (err) {
      const e = toError(err);
      this.emitLog('error', `JSON stringify failed: ${e.message}`);
      throw e;
    }

    try {
      this.process.stdin.write(`${payload}\n`, 'utf8');
    } catch (err) {
      const e = toError(err);
      this.emitLog('error', `stdin write failed: ${e.message}`);
      this.emitErrorSafe(e);
      throw e;
    }

    this.touchActivity();
  }

  async kill(): Promise<void> {
    const proc = this.process;
    if (!proc || this.killing) return;

    // Check if process already exited
    if (proc.exitCode !== null || proc.signalCode !== null) return;

    const pid = proc.pid;
    if (pid === undefined) return;

    this.killing = true;
    this.emitLog('system', `Killing process tree (pid=${pid})`);

    await new Promise<void>((resolve) => {
      treeKill(pid, 'SIGKILL', (err) => {
        if (err) {
          const e = toError(err);
          this.emitLog('error', `tree-kill failed: ${e.message}`);
          this.emitErrorSafe(e);
        }
        this.killing = false;
        resolve();
      });
    });
  }

  // --------------------------------------------------------------------------
  // Private: Initialization
  // --------------------------------------------------------------------------

  private reset(): void {
    this.completed = false;
    this.killing = false;
    this.taskId = null;
    this.tokenUsage = null;
    this.currentTool = null;
    this.currentSlowToolCategory = null;
    this.slowToolStartMs = null;
  }

  private setupEventHandlers(child: ChildProcessWithoutNullStreams): void {
    child.on('error', (err) => {
      const e = toError(err);
      this.emitLog('error', `Process error: ${e.message}`);
      this.emitErrorSafe(e);
      this.finalize(false);
    });

    child.on('exit', (code, signal) => {
      if (this.completed) return;
      const success = code === 0 && signal === null;
      this.emitLog('system', `Process exit (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      this.finalize(success);
    });

    child.on('close', () => {
      this.cleanupStreams();
      this.process = null;
    });
  }

  private setupStreamParsers(child: ChildProcessWithoutNullStreams): void {
    this.stdoutRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.stderrRl = createInterface({ input: child.stderr, crlfDelay: Infinity });

    this.stdoutRl.on('line', (line) => this.handleStdoutLine(line));
    this.stderrRl.on('line', (line) => this.handleStderrLine(line));
  }

  private waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onError);
        resolve();
      };
      const onError = (err: unknown) => {
        child.off('spawn', onSpawn);
        reject(toError(err));
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  }

  // --------------------------------------------------------------------------
  // Private: Stream Parsing
  // --------------------------------------------------------------------------

  private handleStdoutLine(line: string): void {
    this.touchActivity();
    const trimmed = line.trim();
    if (!trimmed) return;

    const parsed = tryParseJson(trimmed);
    if (parsed === null) {
      this.emitLog('output', truncate(normalizeLine(trimmed), 2000));
      this.detectTaskId(trimmed);
      return;
    }

    this.handleStreamJson(parsed, trimmed);
  }

  private handleStderrLine(line: string): void {
    this.touchActivity();
    const trimmed = line.trim();
    if (!trimmed) return;

    this.emitLog('error', truncate(normalizeLine(trimmed), 2000));
    this.detectTaskId(trimmed);
  }

  private handleStreamJson(value: unknown, rawLine: string): void {
    if (!isRecord(value)) {
      this.emitLog('output', truncate(normalizeLine(rawLine), 2000));
      return;
    }

    const type = asString(value.type);
    switch (type) {
      case 'system':
        this.handleSystemMessage(value);
        break;
      case 'assistant':
        this.handleAssistantMessage(value);
        break;
      case 'user':
        this.handleUserMessage(value);
        break;
      case 'result':
        this.handleResultMessage(value);
        break;
      default:
        this.emitLog('system', truncate(normalizeLine(rawLine), 2000));
        this.detectTaskId(rawLine);
    }
  }

  private handleSystemMessage(obj: JsonObject): void {
    const subtype = asString(obj.subtype);
    const sessionId = asString(obj.session_id);

    if (subtype === 'init' && sessionId) {
      this.emitLog('system', `Session: ${sessionId}`);
    } else if (subtype) {
      this.emitLog('system', `system:${subtype}`);
    }
  }

  private handleAssistantMessage(obj: JsonObject): void {
    const message = obj.message;
    if (!isRecord(message)) return;

    this.updateTokenUsage(message);

    const content = message.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (!isRecord(block)) continue;
      const blockType = asString(block.type);

      if (blockType === 'tool_use') {
        this.handleToolUse(block);
      } else if (blockType === 'text') {
        const text = asString(block.text);
        if (text) {
          this.emitLog('output', truncate(normalizeLine(text), 4000));
          this.detectTaskId(text);
        }
      }
    }
  }

  private handleToolUse(block: JsonObject): void {
    const toolName = asString(block.name) ?? 'unknown';
    this.currentTool = toolName;

    const input = isRecord(block.input) ? block.input : null;
    const detail = input ? this.summarizeToolInput(input) : undefined;
    const displayName = formatToolName(toolName);

    // All tool calls use slow tool timeout to prevent premature idle kills
    const slowCategory = this.inferSlowToolCategory(toolName, detail);
    this.currentSlowToolCategory = slowCategory;
    this.slowToolStartMs = Date.now();
    const timeoutMin = Math.round(this.watchdog.slowToolTimeouts[slowCategory] / 60_000);
    // Only log timeout info for non-default categories
    if (slowCategory !== 'default') {
      this.emitLog('tool', `${displayName} → ${detail ?? ''} (slow tool: ${slowCategory}, timeout: ${timeoutMin}min)`);
    } else {
      this.emitLog('tool', detail ? `${displayName} → ${detail}` : displayName);
    }

    if (input) {
      const command = asString(input.command);
      if (command) this.detectTaskId(command);

      const oldStr = asString(input.old_string);
      if (oldStr) this.detectTaskId(oldStr);

      const newStr = asString(input.new_string);
      if (newStr) this.detectTaskId(newStr);
    }
  }

  private inferSlowToolCategory(toolName: string, detail?: string): keyof SlowToolTimeouts {
    const raw = `${toolName} ${detail ?? ''}`.toLowerCase();

    if (raw.includes('codex')) return 'codex';
    if (raw.includes('gemini')) return 'gemini';
    if (raw.includes('npm') && raw.includes('install')) return 'npmInstall';
    if (raw.includes('npm') && (raw.includes('build') || raw.includes('run build'))) return 'npmBuild';

    // Use 'default' timeout for all other tools to prevent premature idle kills
    return 'default';
  }

  private handleUserMessage(obj: JsonObject): void {
    const message = obj.message;
    if (!isRecord(message)) return;

    const content = message.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (!isRecord(block) || asString(block.type) !== 'tool_result') continue;

      // Clear slow tool state on tool result
      if (this.currentSlowToolCategory) {
        const elapsed = this.slowToolStartMs ? Date.now() - this.slowToolStartMs : 0;
        const elapsedMin = Math.round(elapsed / 60_000);
        this.emitLog('system', `Slow tool ${this.currentSlowToolCategory} completed (${elapsedMin}min)`);
      }
      this.currentTool = null;
      this.currentSlowToolCategory = null;
      this.slowToolStartMs = null;

      const isError = Boolean(block.is_error);
      const rawContent = block.content;

      // Handle both string and object content
      let contentStr: string;
      if (typeof rawContent === 'string') {
        contentStr = rawContent;
      } else if (rawContent !== undefined && rawContent !== null) {
        try {
          contentStr = JSON.stringify(rawContent);
        } catch {
          contentStr = String(rawContent);
        }
      } else {
        contentStr = '';
      }

      const preview = truncate(normalizeLine(contentStr), 200);
      const prefix = isError ? 'ERR' : 'OK';
      this.emitLog('result', preview ? `${prefix} → ${preview}` : prefix);

      if (contentStr) this.detectTaskId(contentStr);
    }
  }

  private handleResultMessage(obj: JsonObject): void {
    const subtype = asString(obj.subtype);
    const success = subtype === 'success';
    const durationMs = asNumber(obj.duration_ms) ?? (Date.now() - this.startMs);
    const durSec = Math.round(durationMs / 100) / 10;

    this.emitLog('system', `Complete: ${success ? 'OK' : 'FAIL'} ${durSec}s`);
    this.finalize(success);

    if (this.autoKillOnComplete) {
      void this.kill();
    }
  }

  // --------------------------------------------------------------------------
  // Private: Token Usage
  // --------------------------------------------------------------------------

  private updateTokenUsage(message: JsonObject): void {
    const usage = message.usage;
    if (!isRecord(usage)) return;

    const inputTokens = asNumber(usage.input_tokens) ?? 0;
    const outputTokens = asNumber(usage.output_tokens) ?? 0;
    const cacheRead = asNumber(usage.cache_read_input_tokens) ?? 0;
    const total = inputTokens + outputTokens + cacheRead;

    if (total > 0) {
      this.tokenUsage = `${Math.round(total / 100) / 10}k`;
    }
  }

  // --------------------------------------------------------------------------
  // Private: Tool Input Summary
  // --------------------------------------------------------------------------

  private summarizeToolInput(input: JsonObject): string | undefined {
    const filePath = asString(input.file_path);
    if (filePath) return basename(filePath);

    const command = asString(input.command);
    if (command) return truncate(normalizeLine(command), 80);

    const pattern = asString(input.pattern);
    if (pattern) return `pattern: ${truncate(normalizeLine(pattern), 80)}`;

    const query = asString(input.query);
    if (query) return truncate(normalizeLine(query), 80);

    const prompt = asString(input.PROMPT);
    if (prompt) return truncate(normalizeLine(prompt), 80);

    return undefined;
  }

  // --------------------------------------------------------------------------
  // Private: TaskId Detection
  // --------------------------------------------------------------------------

  private detectTaskId(text: string): void {
    // 调度器模式：已预分配任务时跳过检测，避免误匹配代码片段（如 Math.floor）
    if (this.assignedTaskId) return;

    const id = extractTaskId(text);
    if (id && id !== this.taskId) {
      this.taskId = id;
      this.emitLog('system', `Task detected: ${id}`);
      this.emit('taskDetected', id);
    }
  }

  // --------------------------------------------------------------------------
  // Private: Watchdog
  // --------------------------------------------------------------------------

  private touchActivity(): void {
    this.lastActivityMs = Date.now();
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    if (!this.watchdog.enabled || this.watchdog.tickMs <= 0) return;

    this.watchdogTimer = setInterval(() => this.checkWatchdog(), this.watchdog.tickMs);
    this.watchdogTimer.unref?.();
  }

  private checkWatchdog(): void {
    if (!this.process || this.completed) return;

    const now = Date.now();
    const idleMs = now - this.lastActivityMs;
    const totalMs = now - this.startMs;

    // Check slow tool timeout OR idle timeout (mutually exclusive)
    if (this.currentSlowToolCategory && this.slowToolStartMs) {
      // Use slow tool timeout instead of idle timeout
      const effectiveTimeoutMs = this.watchdog.slowToolTimeouts[this.currentSlowToolCategory];
      const slowToolElapsed = now - this.slowToolStartMs;

      if (slowToolElapsed > effectiveTimeoutMs) {
        const timeoutMin = Math.round(effectiveTimeoutMs / 60_000);
        const elapsedMin = Math.round(slowToolElapsed / 60_000);
        const err = new Error(`Timeout: slow tool ${this.currentSlowToolCategory} exceeded ${timeoutMin}min (elapsed: ${elapsedMin}min)`);
        this.emitLog('error', err.message);
        this.emitErrorSafe(err);
        void this.kill();
        this.finalize(false);
        return;
      }
      // Slow tool is still within timeout, skip idle check but continue to hardTimeout check
    } else {
      // Normal idle timeout check (only when not waiting for slow tool)
      if (idleMs > this.watchdog.idleTimeoutMs) {
        const err = new Error(`Timeout: ${Math.round(idleMs / 1000)}s idle`);
        this.emitLog('error', err.message);
        this.emitErrorSafe(err);
        void this.kill();
        this.finalize(false);
        return;
      }
    }

    // Hard timeout check: ALWAYS executed regardless of slow tool state
    if (this.watchdog.hardTimeoutMs !== undefined && totalMs > this.watchdog.hardTimeoutMs) {
      const err = new Error(`Timeout: ${Math.round(totalMs / 1000)}s total (hard limit)`);
      this.emitLog('error', err.message);
      this.emitErrorSafe(err);
      void this.kill();
      this.finalize(false);
    }
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // Private: Cleanup
  // --------------------------------------------------------------------------

  private finalize(success: boolean): void {
    if (this.completed) return;
    this.completed = true;
    this.stopWatchdog();
    const durationMs = Date.now() - this.startMs;
    this.emit('complete', success, durationMs);
  }

  private cleanupStreams(): void {
    try { this.stdoutRl?.close(); } catch { /* ignore */ }
    try { this.stderrRl?.close(); } catch { /* ignore */ }
    this.stdoutRl = null;
    this.stderrRl = null;
  }

  private emitErrorSafe(err: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  private emitLog(type: LogEntryType, content: string): void {
    const entry: LogEntry = { ts: formatTime(), type, content };
    this.emit('log', entry);
  }
}

// ============================================================================
// Type Augmentation for EventEmitter
// ============================================================================

export interface ClaudeWorker {
  on(event: 'log', listener: (entry: LogEntry) => void): this;
  on(event: 'taskDetected', listener: (taskId: string) => void): this;
  on(event: 'complete', listener: (success: boolean, durationMs: number) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;

  once(event: 'log', listener: (entry: LogEntry) => void): this;
  once(event: 'taskDetected', listener: (taskId: string) => void): this;
  once(event: 'complete', listener: (success: boolean, durationMs: number) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;

  emit(event: 'log', entry: LogEntry): boolean;
  emit(event: 'taskDetected', taskId: string): boolean;
  emit(event: 'complete', success: boolean, durationMs: number): boolean;
  emit(event: 'error', error: Error): boolean;
}
