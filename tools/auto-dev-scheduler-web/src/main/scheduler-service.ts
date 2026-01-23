/**
 * Scheduler Service
 * - AUTO-DEV.md 启动时解析，任务完成时更新 checkbox 状态
 * - 调度器内存管理所有任务状态和锁
 * - 文件写入队列确保并发安全
 */

import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ClaudeWorker, type ClaudeWorkerConfig, type RawIssueReport } from './claude-worker';
// Phase 4: CodexWorker and GeminiWorker no longer directly used
// Claude uses MCP tools for delegation
import { updateTaskCheckbox } from './file-writer';
import { LogManager } from './log-manager';
import { validateAllTasks, formatValidationReport } from './metadata-validator';
import { inferProjectRoot, parseAutoDevFile, extractTaskContent } from './parser';
import { resolvePersona, resolveWorkerType, getDelegationHint, type DelegationHint } from './routing-registry';
import { createArtifactStore } from './artifact-store';
// Phase 4: IWorker no longer used directly
import type { SchedulerPauseReason } from './scheduler-session-store';

// Import modular scheduler components
import {
  SchedulerContext,
  IssueTracker,
  SessionPersistence,
  ResilienceManager,
  TaskManager,
  WorkerPool,
  runTscCheck,
  convertToIssues,
  diffErrors,
  type WorkerWrapper as SchedulerWorkerWrapper,
  type WorkerInstanceWrapper,
  type CompileError
} from './scheduler';

import type {
  AutoRetryConfig,
  Issue,
  IssueStatus,
  LogEntry,
  Progress,
  Task,
  TaskStatus,
  WorkerState
} from '../shared/types';

export type { SchedulerPauseReason } from './scheduler-session-store';

// ============================================================================
// Event Payload Types
// ============================================================================

export interface FileLoadedPayload {
  filePath: string;
  projectRoot: string;
  tasks: Task[];
}

export interface TaskUpdatePayload {
  taskId: string;
  status: TaskStatus;
  duration?: number;
  startTime?: string;
  endTime?: string;
  workerId?: number;
  retryCount?: number;
  nextRetryAt?: number | null;
}

export interface WorkerLogPayload {
  workerId: number;
  taskId?: string;
  entry: LogEntry;
}

export interface SchedulerStatePayload {
  running: boolean;
  paused: boolean;
  pausedReason?: SchedulerPauseReason | null;
}

export interface WorkerStatePayload {
  workerId: number;
  active: boolean;
  taskId?: string;
  tokenUsage?: string;
  currentTool?: string;
  workerKind?: 'claude' | 'codex' | 'gemini';
}

export interface IssueReportedPayload {
  issue: Issue;
}

export interface IssueUpdatePayload {
  issueId: string;
  status: IssueStatus;
}

export interface SchedulerState {
  running: boolean;
  paused: boolean;
  pausedReason?: SchedulerPauseReason | null;
  filePath: string;
  projectRoot: string;
  tasks: Task[];
  workers: WorkerState[];
  progress: Progress;
  issues: Issue[];
}

// Routing preview types (Phase 3: dry-run)
export interface RoutingDecision {
  taskId: string;
  wave?: number;
  persona: string | null;
  workerType: string;
  reason: string;
  dependencies?: string[];
}

export interface RoutingPreviewResult {
  decisions: RoutingDecision[];
  summary: {
    claude: number;
    codex: number;
    gemini: number;
  };
}

export interface BlockerAutoPausePayload {
  issue: Issue;
  openBlockers: number;
}

export interface ApiErrorPayload {
  errorText: string;
  retryCount: number;
  maxRetries: number;
  nextRetryInMs: number | null;  // null = no more retries, waiting for user action
  // Per-task retry info
  taskId?: string;
  taskRetryCount?: number;
  taskMaxRetries?: number;
  pauseReason?: string;
}

type EventPayload =
  | { type: 'fileLoaded'; payload: FileLoadedPayload }
  | { type: 'taskUpdate'; payload: TaskUpdatePayload }
  | { type: 'workerLog'; payload: WorkerLogPayload }
  | { type: 'progress'; payload: Progress }
  | { type: 'schedulerState'; payload: SchedulerStatePayload }
  | { type: 'workerState'; payload: WorkerStatePayload }
  | { type: 'issueReported'; payload: IssueReportedPayload }
  | { type: 'issueUpdate'; payload: IssueUpdatePayload }
  | { type: 'blockerAutoPause'; payload: BlockerAutoPausePayload }
  | { type: 'apiError'; payload: ApiErrorPayload };

// Phase 4: Only ClaudeWorker is used directly
// Codex/Gemini are delegated via MCP tools
type WorkerInstance = ClaudeWorker;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Safely execute a fire-and-forget promise with error handling.
 * Prevents unhandled rejections from crashing the app.
 */
function safeAsync(promise: Promise<unknown>, context: string): void {
  promise.catch((err: unknown) => {
    console.warn(`[${context}] Async error (non-fatal):`, err);
  });
}

/**
 * Load persona prompt content from the personas directory.
 * Persona format: "{provider}/{name}" -> ".claude/prompts/personas/{provider}/{name}.md"
 *
 * @param persona - The persona identifier (e.g., "gemini/cocos-game-expert")
 * @param projectRoot - The project root directory
 * @returns The prompt content if found, null otherwise
 */
async function loadPersonaPrompt(persona: string, projectRoot: string): Promise<string | null> {
  if (!persona) {
    return null;
  }

  const parts = persona.split('/');
  if (parts.length !== 2) {
    return null;
  }

  const provider = parts[0]?.trim().toLowerCase();
  const name = parts[1]?.trim();
  if (!provider || !name) {
    return null;
  }

  // Security: Guard against path traversal / arbitrary file reads via task.persona
  const validProviders = ['gemini', 'codex', 'shared'];
  if (!validProviders.includes(provider)) {
    console.warn(`[Scheduler] Invalid persona provider: ${provider}`);
    return null;
  }

  // Security: Validate persona name format (alphanumeric, dash, underscore only)
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
    console.warn(`[Scheduler] Invalid persona name format: ${name}`);
    return null;
  }

  const promptPath = path.join(projectRoot, '.claude', 'prompts', 'personas', provider, `${name}.md`);

  try {
    const content = await readFile(promptPath, 'utf8');
    return content.trim() || null;
  } catch {
    // File not found or read error - graceful fallback
    console.warn(`[Scheduler] Persona prompt not found: ${promptPath}`);
    return null;
  }
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  tickMs: 5_000,
  maxParallel: 4,
  maxWorkerLogs: 1000,
  pendingTaskIdTimeoutMs: 2 * 60_000,  // 2 minutes to detect taskId
};

const DEFAULT_AUTO_RETRY_CONFIG: AutoRetryConfig = {
  enabled: true,
  maxRetries: 2,
  baseDelayMs: 5_000,
};

const AUTO_RETRY_MAX_DELAY_MS = 5 * 60_000;  // 5 minutes cap

// API Error (rate limit, overload) retry configuration
const API_ERROR_CONFIG = {
  maxRetries: 5,                    // Maximum global retry attempts before requiring user action
  maxTaskRetries: 3,                // Maximum per-task API error retries
  baseDelayMs: 10_000,              // 10 seconds base delay
  maxDelayMs: 5 * 60_000,           // 5 minutes cap
  jitterRatio: 0.2,                 // 20% random jitter
};

// ============================================================================
// API Error Recovery Prompt Template
// ============================================================================

/**
 * Recovery prompt for tasks that were interrupted by API error after modifying code.
 * This prompt tells the new Claude to check current state and continue.
 */
const API_ERROR_RECOVERY_PROMPT_TEMPLATE = `
# ⚠️ 系统异常恢复模式

## 紧急上下文
上一个执行该任务的 AI Worker 由于 **API 错误** 意外中断。
当前代码库可能处于 **不一致** 或 **半完成** 状态。

## 你的核心职责
你不是在开始一个新任务，而是在**接管并继续完成**一个被中断的任务。
你必须严格遵守以下流程：

### 第一步：环境诊断（必须执行）
1. 运行 \`git status\` 和 \`git diff\` 查看上一个 Worker 留下的修改
2. 如果发现有文件被修改，**必须**读取其内容

### 第二步：代码完整性检查
1. 检查修改的文件是否存在**语法错误**（未闭合的括号、中断的函数、不完整的代码块）
2. 如果发现断尾代码：
   - 根据逻辑补全，或
   - 删除不完整的片段
3. **严禁**：不要在断尾处直接追加代码

### 第三步：任务接管
1. 确认环境修复后，重新分析下方的【原始任务描述】
2. 仔细检查哪些部分已经完成，哪些还需要做
3. 继续完成剩余工作
4. **必须核对所有验收标准，除非全部完成，否则不要停止**

---

## 原始任务描述
{{ORIGINAL_TASK_CONTENT}}
`.trim();

function buildRecoveryPrompt(originalTaskContent: string): string {
  return API_ERROR_RECOVERY_PROMPT_TEMPLATE.replace(
    '{{ORIGINAL_TASK_CONTENT}}',
    originalTaskContent
  );
}

/**
 * Phase 4: Build delegation instruction for Claude-first architecture
 *
 * This provides Claude with guidance on how to delegate to Codex/Gemini
 * via MCP tools, and reminds Claude to review and modify the output.
 */
function buildDelegationInstruction(hint: DelegationHint): string {
  if (hint.target === 'codex') {
    return `
## 🔵 MANDATORY Multi-Model Delegation: Codex

**⚠️ CRITICAL CONSTRAINT**: You MUST delegate this task. Direct execution is FORBIDDEN.

**Task Category**: ${hint.reason}

**Delegation Protocol (MANDATORY)**:
1. You are a ROUTER, not an executor. Analyze requirements but do NOT write code directly.
2. You **MUST** call \`${hint.mcpTool}\` to delegate to Codex:
   - Request unified diff patch (read-only sandbox)
   - Codex handles: backend logic, architecture, debugging
3. After receiving Codex's response:
   - Review the output critically
   - Verify correctness against project patterns
   - Modify as needed for production quality
   - Apply changes using Edit tool
4. Run relevant tests to verify implementation

**FORBIDDEN ACTIONS**:
- ❌ Writing backend code directly without delegation
- ❌ Skipping the MCP tool call
- ❌ Deciding "I can do this faster myself"

**If delegation fails**: Output "DELEGATION_FAILED: <reason>" and stop.
`.trim();
  }

  if (hint.target === 'gemini') {
    return `
## 🟢 MANDATORY Multi-Model Delegation: Gemini

**⚠️ CRITICAL CONSTRAINT**: You MUST delegate this task. Direct execution is FORBIDDEN.

**Task Category**: ${hint.reason}

**Delegation Protocol (MANDATORY)**:
1. You are a ROUTER, not an executor. Analyze requirements but do NOT write UI code directly.
2. You **MUST** call \`${hint.mcpTool}\` to delegate to Gemini:
   - Request CSS/Vue/HTML prototype code
   - Gemini handles: frontend aesthetics, UI components, styling
   - ⚠️ Gemini has 32k effective context - be concise
3. After receiving Gemini's response:
   - Review the output critically
   - Verify compatibility with project patterns
   - Check performance and accessibility
   - Modify as needed and apply using Edit tool
4. Run relevant preview checks

**FORBIDDEN ACTIONS**:
- ❌ Writing frontend code directly without delegation
- ❌ Skipping the MCP tool call
- ❌ Deciding "I can do this faster myself"

**If delegation fails**: Output "DELEGATION_FAILED: <reason>" and stop.
`.trim();
  }

  return '';
}

// ============================================================================
// Scheduler Class
// ============================================================================

export class Scheduler extends EventEmitter {
  // Core shared state (replaces individual Maps)
  private readonly ctx = new SchedulerContext();

  // Modular components
  private readonly issueTracker: IssueTracker;
  private readonly sessionPersistence: SessionPersistence;
  private readonly taskManager: TaskManager;
  private readonly resilienceManager: ResilienceManager;
  private readonly workerPool: WorkerPool;

  // Timers
  private tickTimer: NodeJS.Timeout | null = null;

  // Log manager
  private readonly logManager = new LogManager();

  // Compile checker state
  private baselineCompileErrors: CompileError[] = [];
  private compileCheckEnabled = true;

  constructor() {
    super();

    // Initialize IssueTracker
    this.issueTracker = new IssueTracker(this.ctx, {
      onIssueReported: (issue) => {
        this.emitEvent({ type: 'issueReported', payload: { issue } });
      },
      onIssueUpdated: (issueId, status) => {
        this.emitEvent({ type: 'issueUpdate', payload: { issueId, status } });
      },
      requestPersist: (reason) => this.requestPersist(reason),
      onBlockerDetected: () => this.handleBlockerAutoPause()
    });

    // Initialize SessionPersistence
    this.sessionPersistence = new SessionPersistence({
      getFilePath: () => this.ctx.filePath,
      getProjectRoot: () => this.ctx.projectRoot,
      isPaused: () => this.ctx.paused,
      getPauseReason: () => this.ctx.pauseReason,
      getAutoRetryConfig: () => this.ctx.autoRetryConfig,
      isBlockerAutoPauseEnabled: () => this.ctx.blockerAutoPauseEnabled,
      getTasks: () => this.ctx.tasks.values(),
      getIssues: () => this.issueTracker.getIssuesForSnapshot()
    });

    // Initialize TaskManager
    this.taskManager = new TaskManager(this.ctx, {
      onTaskStatusChanged: (taskId, status, duration, startTime, endTime, workerId, retryCount, nextRetryAt) => {
        this.emitEvent({
          type: 'taskUpdate',
          payload: { taskId, status, duration, startTime, endTime, workerId, retryCount, nextRetryAt }
        });
        this.requestPersist('taskUpdate');
        // Update pending tasks when a task completes successfully
        if (status === 'success') {
          this.taskManager.updatePendingTasks();
        }
        // Handle wave completion tracking
        const task = this.ctx.tasks.get(taskId);
        if (task) {
          // If a task re-enters a non-terminal state (e.g., retry), reopen the wave
          if (!this.isTaskTerminal(task)) {
            this.clearCompletedWave(task.wave);
          } else {
            // Check if wave is complete when a task reaches terminal status
            this.checkWaveCompletionAndRunCompileCheck(taskId);
          }
        }
      }
    });

    // Initialize ResilienceManager
    this.resilienceManager = new ResilienceManager(this.ctx, {
      setTaskStatus: (task, status, duration) => this.taskManager.setTaskStatus(task, status, duration),
      onApiErrorPause: (payload) => this.emitEvent({ type: 'apiError', payload }),
      onSchedulerStateChanged: (running, paused, reason) => {
        this.emitEvent({ type: 'schedulerState', payload: { running, paused, pausedReason: reason as SchedulerPauseReason | null } });
      },
      killAllWorkersForRetry: () => this.killAllWorkersForRetry(),
      requestPersist: (reason) => this.sessionPersistence.request(reason),
      triggerTick: (reason) => safeAsync(this.tick(reason), 'Scheduler.tick'),
      canExecute: (task) => this.taskManager.canExecute(task)
    });

    // Initialize WorkerPool
    this.workerPool = new WorkerPool(this.ctx, {
      onWorkerLog: (workerId, taskId, entry) => {
        this.emitEvent({ type: 'workerLog', payload: { workerId, taskId, entry } });
      },
      onWorkerStateChanged: (workerId, active, taskId, tokenUsage, currentTool, workerKind) => {
        this.emitEvent({
          type: 'workerState',
          payload: { workerId, active, taskId, tokenUsage, currentTool, workerKind }
        });
      },
      onWorkerComplete: () => { /* handled via TaskManager */ },
      onWorkerError: () => { /* handled via logs */ },
      onApiErrorDetected: (errorText, wrapper) => this.resilienceManager.handleApiError(errorText, wrapper),
      lockTask: (taskId, workerId) => this.taskManager.lockTask(taskId, workerId),
      unlockTask: (taskId) => this.taskManager.unlockTask(taskId),
      setTaskStatus: (task, status, duration) => this.taskManager.setTaskStatus(task, status, duration),
      handleTaskFailure: (task, duration) => this.resilienceManager.handleTaskFailure(task, duration),
      findExecutableTasks: () => this.taskManager.findExecutableTasks(),
      triggerTick: (reason) => safeAsync(this.tick(reason), 'Scheduler.tick'),
      appendLog: (taskId, entry) => safeAsync(this.logManager.appendLog(taskId, entry), 'LogManager.appendLog'),
      startTaskLog: (taskId) => safeAsync(this.logManager.startTaskLog(taskId), 'LogManager.startTaskLog'),
      endTaskLog: (taskId) => safeAsync(this.logManager.endTaskLog(taskId), 'LogManager.endTaskLog'),
      updateTaskCheckbox: (filePath, taskId, success) => updateTaskCheckbox(filePath, taskId, success),
      getDelegationHintForTask: (taskId) => {
        const task = this.ctx.tasks.get(taskId);
        if (!task) return null;
        const hint = getDelegationHint(task);
        return { target: hint.target, mcpTool: hint.mcpTool };
      },
      createClaudeWorker: (workerId, assignedTaskId, startupContent) => this.createClaudeWorker(workerId, assignedTaskId, startupContent),
      // Phase 4: createCodexWorker and createGeminiWorker removed
      // Claude uses MCP tools for delegation
      extractTaskContent: (filePath, taskId) => extractTaskContent(filePath, taskId),
      buildStartupContent: (taskId, filePath, needsRecoveryPrompt) => this.buildStartupContent(taskId, filePath, needsRecoveryPrompt),
      resolvePersona: (task) => resolvePersona(task),
      resolveWorkerType: (persona) => resolveWorkerType(persona),
      onIssueReported: (raw, reporterTaskId, reporterWorkerId) => {
        this.issueTracker.addIssue(raw as RawIssueReport, reporterTaskId, reporterWorkerId);
      },
      requestPersist: (reason) => this.sessionPersistence.request(reason)
    });
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  async loadFile(filePath: string, options: { ignoreSession?: boolean } = {}): Promise<void> {
    await this.stop();

    this.sessionPersistence.invalidate();
    this.clearPersistTimer();

    this.ctx.filePath = filePath;
    this.ctx.projectRoot = inferProjectRoot(filePath);
    this.ctx.tasks.clear();
    this.ctx.taskLocks.clear();
    this.ctx.issues.clear();
    this.ctx.completedWorkerLogs = [];
    this.completedWaves.clear();
    this.baselineCompileErrors = [];
    this.compileCheckEnabled = true;

    const parsed = await parseAutoDevFile(filePath);

    // Initialize tasks: respect terminal states (success/failed) from file, recalculate others
    for (const [id, task] of parsed.tasks) {
      const status = task.status === 'success' || task.status === 'failed' || task.status === 'canceled'
        ? task.status
        : 'pending';
      this.ctx.tasks.set(id, { ...task, status });
    }

    // Update tasks whose dependencies are already satisfied to 'ready'
    for (const task of this.ctx.tasks.values()) {
      if (task.status === 'pending' && this.canExecute(task, this.ctx.tasks)) {
        task.status = 'ready';
      }
    }

    // Validate task metadata (warn-only, does not block execution)
    const validationResult = validateAllTasks(this.ctx.tasks, this.ctx.projectRoot);
    if (validationResult.warningCount > 0 || validationResult.errorCount > 0) {
      console.log(formatValidationReport(validationResult));
    }

    // Hydrate from session store (issues, task runtime state)
    if (!options.ignoreSession) {
      await this.hydrateFromSessionStore();
    }

    this.emitEvent({
      type: 'fileLoaded',
      payload: {
        filePath: this.ctx.filePath,
        projectRoot: this.ctx.projectRoot,
        tasks: this.getTaskList()
      }
    });

    this.emitProgress();
    this.requestPersist('loadFile');
  }

  start(maxParallel = 1): void {
    if (this.ctx.running) return;
    if (this.ctx.tasks.size === 0) return;

    const requested = Number.isFinite(maxParallel) ? Math.floor(maxParallel) : 1;
    this.ctx.maxParallel = Math.min(Math.max(1, requested), CONFIG.maxParallel);
    this.ctx.running = true;
    this.ctx.paused = false;
    this.ctx.pauseReason = null;

    // Phase 4: Initialize runId and artifactStore for each scheduler run
    this.ctx.runId = randomUUID();
    this.ctx.artifactStore = createArtifactStore(this.ctx.projectRoot);

    // Run baseline compile check (async, non-blocking)
    if (this.compileCheckEnabled) {
      safeAsync(this.runBaselineCompileCheck(), 'Scheduler.baselineCompileCheck');
    }

    this.emitEvent({ type: 'schedulerState', payload: { running: true, paused: false, pausedReason: null } });
    this.requestPersist('start');
    this.ensureTickTimer();
    safeAsync(this.tick('start'), 'Scheduler.tick');
  }

  pause(): void {
    if (!this.ctx.running || this.ctx.paused) return;
    this.ctx.paused = true;
    this.ctx.pauseReason = 'user';
    this.emitEvent({ type: 'schedulerState', payload: { running: true, paused: true, pausedReason: 'user' } });
    this.requestPersist('pause');
  }

  resume(): void {
    if (!this.ctx.running || !this.ctx.paused) return;

    // Check for open blockers before resuming
    if (this.ctx.blockerAutoPauseEnabled && this.getOpenBlockers().length > 0) {
      this.ctx.pauseReason = 'blocker';
      this.emitEvent({ type: 'schedulerState', payload: { running: true, paused: true, pausedReason: 'blocker' } });
      return;
    }

    this.ctx.paused = false;
    this.ctx.pauseReason = null;
    this.emitEvent({ type: 'schedulerState', payload: { running: true, paused: false, pausedReason: null } });
    this.requestPersist('resume');
    safeAsync(this.tick('resume'), 'Scheduler.tick');
  }

  async stop(): Promise<void> {
    this.clearPersistTimer();
    this.resilienceManager.resetApiErrorState();
    this.ctx.running = false;
    this.ctx.paused = false;
    this.ctx.pauseReason = null;
    this.stopTickTimer();

    // CRITICAL: Release all locks BEFORE killing workers to prevent race condition
    // where a worker completes during kill() and marks task as success
    const lockedTaskIds = [...this.ctx.taskLocks.keys()];
    for (const taskId of lockedTaskIds) {
      const task = this.ctx.tasks.get(taskId);
      if (task && task.status === 'running') {
        this.setTaskStatus(task, 'ready');
      }
      this.unlockTask(taskId);
    }

    // Archive logs and kill all workers (late completions will be ignored due to missing locks)
    const killPromises = [...this.ctx.workers.values()].map(async (w) => {
      w.closing = true;
      // Archive logs before killing (mark as stopped)
      this.ctx.completedWorkerLogs.push({
        workerId: w.id,
        taskId: w.taskId,
        logs: [...w.logs],
        stopped: true
      });
      try {
        // Phase 4: All workers are Claude workers
        if (w.workerKind === 'claude') {
          await (w.worker as ClaudeWorker).kill();
        }
        // else: Direct workers are no longer instantiated in Phase 4
      } catch (err) {
        console.warn(`[Scheduler] Failed to kill worker ${w.id}:`, err);
      }
    });
    await Promise.all(killPromises);

    this.ctx.clearWorkers();

    this.emitEvent({ type: 'schedulerState', payload: { running: false, paused: false, pausedReason: null } });
    this.emitProgress();
    await this.persistNow('stop');
  }

  getState(): SchedulerState {
    return {
      running: this.ctx.running,
      paused: this.ctx.paused,
      pausedReason: this.ctx.pauseReason,
      filePath: this.ctx.filePath,
      projectRoot: this.ctx.projectRoot,
      tasks: this.getTaskList(),
      workers: this.getWorkerStates(),
      progress: this.getProgress(),
      issues: this.getIssueList()
    };
  }

  /**
   * Generate routing preview (dry-run mode)
   * Shows which worker type would be used for each task without executing.
   */
  getRoutingPreview(): RoutingPreviewResult {
    const decisions: RoutingDecision[] = [];
    const summary = { claude: 0, codex: 0, gemini: 0 };

    // Group tasks by wave
    const tasksByWave = new Map<number, Task[]>();
    for (const task of this.ctx.tasks.values()) {
      const wave = task.wave;
      if (!tasksByWave.has(wave)) {
        tasksByWave.set(wave, []);
      }
      tasksByWave.get(wave)!.push(task);
    }

    // Sort waves
    const sortedWaves = [...tasksByWave.keys()].sort((a, b) => a - b);

    for (const wave of sortedWaves) {
      const tasks = tasksByWave.get(wave)!;
      for (const task of tasks.sort((a, b) => a.id.localeCompare(b.id))) {
        const persona = resolvePersona(task);
        const workerType = resolveWorkerType(persona);

        let reason: string;
        if (task.persona) {
          reason = 'explicit persona';
        } else if (task.scope) {
          reason = `scope: ${task.scope}`;
        } else if (persona) {
          reason = 'prefix rule';
        } else {
          reason = 'default';
        }

        decisions.push({
          taskId: task.id,
          wave: task.wave,
          persona,
          workerType,
          reason,
          dependencies: task.dependencies
        });

        // Update summary
        switch (workerType) {
          case 'codex-cli':
            summary.codex++;
            break;
          case 'gemini-cli':
            summary.gemini++;
            break;
          case 'claude-cli':
          default:
            summary.claude++;
            break;
        }
      }
    }

    return { decisions, summary };
  }

  /**
   * Format routing preview for console output
   */
  formatRoutingPreview(): string {
    const preview = this.getRoutingPreview();
    const lines: string[] = ['=== Route Preview (Dry-Run) ===', ''];

    // Color/icon mapping
    const typeIcons: Record<string, string> = {
      'claude-cli': '🟣',
      'codex-cli': '🔵',
      'gemini-cli': '🟢'
    };

    // Group by wave
    const byWave = new Map<number, RoutingDecision[]>();
    for (const d of preview.decisions) {
      const wave = d.wave ?? 99;
      if (!byWave.has(wave)) {
        byWave.set(wave, []);
      }
      byWave.get(wave)!.push(d);
    }

    // Format each wave
    const sortedWaves = [...byWave.keys()].sort((a, b) => a - b);
    for (const wave of sortedWaves) {
      lines.push(`Wave ${wave}:`);
      const tasks = byWave.get(wave)!;
      for (const d of tasks) {
        const icon = typeIcons[d.workerType] ?? '⚪';
        const personaStr = d.persona ? ` → ${d.persona}` : '';
        const depsStr = d.dependencies?.length ? ` [deps: ${d.dependencies.join(', ')}]` : '';
        lines.push(`  ${icon} ${d.taskId}${personaStr} (${d.reason})${depsStr}`);
      }
      lines.push('');
    }

    // Summary
    lines.push('--- Summary ---');
    lines.push(`🟣 Claude: ${preview.summary.claude} tasks`);
    lines.push(`🔵 Codex:  ${preview.summary.codex} tasks`);
    lines.push(`🟢 Gemini: ${preview.summary.gemini} tasks`);
    lines.push(`   Total:  ${preview.decisions.length} tasks`);

    return lines.join('\n');
  }

  async sendToWorker(workerId: number, content: string): Promise<void> {
    const wrapper = this.ctx.workers.get(workerId);
    if (!wrapper) throw new Error(`Worker ${workerId} not found`);

    // Only ClaudeWorker supports send()
    if (wrapper.workerKind !== 'claude') {
      throw new Error(`Worker ${workerId} (${wrapper.workerKind}) does not support interactive messages`);
    }

    (wrapper.worker as ClaudeWorker).send({
      type: 'user',
      message: { role: 'user', content }
    });
  }

  async killWorker(workerId: number): Promise<void> {
    const wrapper = this.ctx.workers.get(workerId);
    if (!wrapper) return;

    const instance = this.getWorkerInstanceWrapper(wrapper) ?? undefined;
    await this.workerPool.killWorker(workerId, instance);
  }

  exportLogs(): string {
    const lines: string[] = [];
    lines.push(`=== Auto-Dev Scheduler Logs ===`);
    lines.push(`File: ${this.ctx.filePath}`);
    lines.push(`Project: ${this.ctx.projectRoot}`);
    lines.push(`Exported: ${new Date().toISOString()}`);
    lines.push('');

    for (const completed of this.ctx.completedWorkerLogs) {
      const status = completed.stopped ? 'stopped' : 'completed';
      lines.push(`--- Worker ${completed.workerId} (Task: ${completed.taskId}) [${status}] ---`);
      for (const entry of completed.logs) {
        lines.push(`[${entry.ts}] [${entry.type}] ${entry.content}`);
      }
      lines.push('');
    }

    for (const [workerId, wrapper] of this.ctx.workers) {
      lines.push(`--- Worker ${workerId} (Task: ${wrapper.taskId}) [active] ---`);
      for (const entry of wrapper.logs) {
        lines.push(`[${entry.ts}] [${entry.type}] ${entry.content}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Export all issues to a centralized markdown file
   */
  async exportIssuesToFile(outputPath?: string): Promise<string> {
    const defaultPath = path.join(
      this.ctx.projectRoot,
      'openspec',
      'execution',
      'ISSUES.md'
    );
    const filePath = outputPath || defaultPath;
    await this.issueTracker.writeToFile(filePath);
    return filePath;
  }

  async clearTaskLogs(taskId: string): Promise<void> {
    await this.logManager.clearTaskLogs(taskId);
  }

  getAutoRetryConfig(): AutoRetryConfig {
    return { ...this.ctx.autoRetryConfig };
  }

  updateAutoRetryConfig(partial: Partial<AutoRetryConfig>): void {
    if (partial.enabled !== undefined) {
      this.ctx.autoRetryConfig.enabled = Boolean(partial.enabled);
    }
    if (partial.maxRetries !== undefined && Number.isFinite(partial.maxRetries)) {
      this.ctx.autoRetryConfig.maxRetries = Math.max(0, Math.min(10, Math.floor(partial.maxRetries)));
    }
    if (partial.baseDelayMs !== undefined && Number.isFinite(partial.baseDelayMs)) {
      // Match UI: 1-300 seconds (1000-300000ms)
      this.ctx.autoRetryConfig.baseDelayMs = Math.max(1000, Math.min(300_000, Math.floor(partial.baseDelayMs)));
    }
  }

  retryTask(taskId: string): void {
    const task = this.ctx.tasks.get(taskId);
    if (!task || task.status !== 'failed') return;

    // Reset auto-retry state on manual retry
    task.retryCount = 0;
    task.nextRetryAt = undefined;

    const nextStatus = this.canExecute(task, this.ctx.tasks) ? 'ready' : 'pending';
    this.setTaskStatus(task, nextStatus);
    this.cascadeReset(taskId);

    if (this.ctx.running) {
      safeAsync(this.tick('retryTask'), 'Scheduler.tick');
    }
  }

  // --------------------------------------------------------------------------
  // Tick Loop
  // --------------------------------------------------------------------------

  private async tick(_reason: string): Promise<void> {
    if (!this.ctx.running) return;

    // Promote tasks whose retry delay has elapsed
    this.promoteDueRetries();

    // Update pending tasks that now have deps satisfied
    this.updatePendingTasks();

    // Check if all done
    if (this.isAllTasksSuccess()) {
      this.ctx.running = false;
      this.ctx.paused = false;
      this.ctx.pauseReason = null;
      this.stopTickTimer();
      this.emitEvent({ type: 'schedulerState', payload: { running: false, paused: false } });
      this.emitProgress();
      this.requestPersist('complete');
      return;
    }

    // Deadlock detection: no workers running, no executable tasks, and no pending retries
    // Include pending spawns to avoid false deadlocks while workers are starting
    const activeCount = this.ctx.getActiveWorkerCount();
    const hasExecutable = this.findExecutableTasks().length > 0;
    const hasPendingRetries = this.hasPendingRetries();
    if (activeCount === 0 && !hasExecutable && !hasPendingRetries) {
      this.ctx.running = false;
      this.ctx.paused = false;
      this.ctx.pauseReason = null;
      this.stopTickTimer();
      this.emitEvent({ type: 'schedulerState', payload: { running: false, paused: false } });
      this.emitProgress();
      this.requestPersist('deadlock');
      return;
    }

    if (!this.ctx.paused) {
      // Start new workers if needed (via WorkerPool)
      this.workerPool.startWorkersIfNeeded();
    }

    this.emitProgress();
  }

  private ensureTickTimer(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      safeAsync(this.tick('timer'), 'Scheduler.tick');
    }, CONFIG.tickMs);
    this.tickTimer.unref?.();
  }

  private stopTickTimer(): void {
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  // --------------------------------------------------------------------------
  // Task Management (delegated to TaskManager)
  // --------------------------------------------------------------------------

  private canExecute(task: Task, _allTasks: Map<string, Task>): boolean {
    return this.taskManager.canExecute(task);
  }

  private updatePendingTasks(): void {
    this.taskManager.updatePendingTasks();
  }

  // --------------------------------------------------------------------------
  // Auto-Retry Logic (delegated to ResilienceManager)
  // --------------------------------------------------------------------------

  private handleTaskFailure(task: Task, duration?: number): { scheduled: boolean; delayMs?: number } {
    return this.resilienceManager.handleTaskFailure(task, duration);
  }

  private promoteDueRetries(): void {
    this.resilienceManager.promoteDueRetries();
  }

  private hasPendingRetries(): boolean {
    return this.resilienceManager.hasPendingRetries();
  }

  private cascadeFailure(failedTaskId: string): void {
    this.resilienceManager.cascadeFailure(failedTaskId);
  }

  private cascadeReset(retriedTaskId: string): void {
    this.resilienceManager.cascadeReset(retriedTaskId);
  }

  private setTaskStatus(task: Task, status: TaskStatus, duration?: number): void {
    this.taskManager.setTaskStatus(task, status, duration);
  }

  private lockTask(taskId: string, workerId: number): boolean {
    return this.taskManager.lockTask(taskId, workerId);
  }

  private unlockTask(taskId: string): void {
    this.taskManager.unlockTask(taskId);
  }

  private findExecutableTasks(): Task[] {
    return this.taskManager.findExecutableTasks();
  }

  private isAllTasksSuccess(): boolean {
    if (this.ctx.tasks.size === 0) return false;
    return [...this.ctx.tasks.values()].every(t => t.status === 'success');
  }

  // --------------------------------------------------------------------------
  // Worker Management (delegated to WorkerPool)
  // --------------------------------------------------------------------------

  private async killAllWorkersForRetry(): Promise<void> {
    await this.workerPool.killAllWorkersForRetry((wrapper) => this.getWorkerInstanceWrapper(wrapper));
    this.emitProgress();
  }

  private getWorkerInstanceWrapper(wrapper: SchedulerWorkerWrapper): WorkerInstanceWrapper | null {
    // Phase 4: Only Claude workers are instantiated directly
    if (wrapper.workerKind !== 'claude') {
      // Direct Codex/Gemini workers are no longer instantiated
      return null;
    }
    return this.wrapClaudeWorker(wrapper.worker as ClaudeWorker);
  }

  private createClaudeWorker(workerId: number, assignedTaskId: string, startupContent: string): WorkerInstanceWrapper {
    const config: ClaudeWorkerConfig = {
      workerId,
      assignedTaskId,
      startupMessage: {
        type: 'user',
        message: { role: 'user', content: startupContent }
      },
      autoKillOnComplete: true
    };
    return this.wrapClaudeWorker(new ClaudeWorker(config));
  }

  // Phase 4: createCodexWorker and createGeminiWorker removed
  // Claude uses MCP tools (mcp__codex__codex, mcp__gemini__gemini) for delegation

  private wrapClaudeWorker(worker: ClaudeWorker): WorkerInstanceWrapper {
    return {
      instance: worker,
      start: (projectRoot: string) => worker.start(projectRoot),
      kill: () => worker.kill(),
      get hasModifiedCode() { return worker.hasModifiedCode; },
      get tokenUsage() { return worker.currentTokenUsage ?? undefined; },
      get currentTool() { return worker.currentToolName ?? undefined; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      on: (event: string, listener: (...args: any[]) => void) => { (worker as any).on(event, listener); }
    };
  }

  // Phase 4: wrapDirectWorker removed - no longer needed

  private async buildStartupContent(taskId: string, filePath: string, needsRecoveryPrompt: boolean): Promise<string> {
    const task = this.ctx.tasks.get(taskId);
    const resolvedPersona = task ? resolvePersona(task) : null;

    // Phase 4: Get delegation hint for Claude-first architecture
    const delegationHint: DelegationHint | null = task ? getDelegationHint(task) : null;

    let personaPrompt: string | null = null;
    if (resolvedPersona) {
      personaPrompt = await loadPersonaPrompt(resolvedPersona, this.ctx.projectRoot);
      if (personaPrompt) {
        console.log(`[Scheduler] Loaded persona prompt for task ${taskId}: ${resolvedPersona}`);
      } else {
        console.warn(`[Scheduler] Persona resolved to ${resolvedPersona} but prompt file not found`);
      }
    }

    let startupContent: string;
    if (needsRecoveryPrompt) {
      const originalTaskContent = `/auto-dev --task ${taskId} --file "${filePath}"`;
      startupContent = buildRecoveryPrompt(originalTaskContent);
      console.log(`[Scheduler] Using recovery prompt for task ${taskId} (hasModifiedCode: true)`);
    } else {
      startupContent = `/auto-dev --task ${taskId} --file "${filePath}"`;
      if (this.issueTracker.isIntegrationTask(taskId)) {
        const openIssues = this.issueTracker.getOpen();
        if (openIssues.length > 0) {
          const issuesSummary = this.issueTracker.formatForInjection(openIssues);
          startupContent = `${startupContent}\n\n${issuesSummary}`;
        }
      }
    }

    // Phase 4: Add delegation hint for Claude-first architecture
    if (delegationHint && delegationHint.target !== 'direct') {
      const delegationInstruction = buildDelegationInstruction(delegationHint);
      startupContent = `${delegationInstruction}\n\n---\n\n${startupContent}`;
      console.log(`[Scheduler] Added delegation hint for task ${taskId}: target=${delegationHint.target}, mcpTool=${delegationHint.mcpTool}`);
    }

    if (personaPrompt) {
      startupContent = `${personaPrompt}\n\n---\n\n${startupContent}`;
    }

    return startupContent;
  }

  // --------------------------------------------------------------------------
  // State Helpers
  // --------------------------------------------------------------------------

  private getTaskList(): Task[] {
    return [...this.ctx.tasks.values()].sort((a, b) => {
      if (a.wave !== b.wave) return a.wave - b.wave;
      return a.id.localeCompare(b.id);
    });
  }

  private getWorkerStates(): WorkerState[] {
    return [...this.ctx.workers.values()].map(w => {
      // Only ClaudeWorker has tokenUsage and currentTool properties
      const claudeWorker = w.workerKind === 'claude' ? (w.worker as ClaudeWorker) : null;
      return {
        id: w.id,
        active: !w.closing,
        taskId: w.taskId,
        logs: w.logs,
        tokenUsage: claudeWorker?.currentTokenUsage ?? undefined,
        currentTool: claudeWorker?.currentToolName ?? undefined,
        workerKind: w.workerKind
      };
    });
  }

  private getProgress(): Progress {
    const total = this.ctx.tasks.size;
    const completed = [...this.ctx.tasks.values()].filter(t => t.status === 'success').length;
    return { completed, total };
  }

  // Track which waves have already triggered compile check (avoid duplicate runs)
  private completedWaves = new Set<number>();

  /**
   * Check if a task is truly terminal (not pending retry).
   * A task is terminal if it's success/canceled, or failed without nextRetryAt.
   */
  private isTaskTerminal(task: Task): boolean {
    if (task.status === 'success' || task.status === 'canceled') return true;
    if (task.status === 'failed' && !task.nextRetryAt) return true;
    return false;
  }

  /**
   * Check if all tasks in a specific wave have reached terminal state.
   * Terminal = success, canceled, or failed without pending retry.
   */
  private isWaveComplete(waveId: number): boolean {
    const waveTasks = [...this.ctx.tasks.values()].filter(t => t.wave === waveId);
    if (waveTasks.length === 0) return false;
    return waveTasks.every(t => this.isTaskTerminal(t));
  }

  /**
   * Check and trigger compile check when a wave completes.
   * Called after a task reaches terminal status (success/failed/canceled).
   */
  private checkWaveCompletionAndRunCompileCheck(taskId: string): void {
    const task = this.ctx.tasks.get(taskId);
    if (!task) return;

    // Skip if task is pending retry (not truly terminal)
    if (!this.isTaskTerminal(task)) return;

    const waveId = task.wave;
    if (this.completedWaves.has(waveId)) return; // Already processed

    if (this.isWaveComplete(waveId)) {
      this.completedWaves.add(waveId);
      console.log(`[Scheduler] Wave ${waveId} complete, triggering compile check...`);
      safeAsync(this.runPostWaveCompileCheck(waveId), 'Scheduler.postWaveCompileCheck');
    }
  }

  /**
   * Clear completed wave tracking for a specific wave.
   * Called when a task is retried to allow re-triggering compile check.
   */
  clearCompletedWave(waveId: number): void {
    this.completedWaves.delete(waveId);
  }

  // --------------------------------------------------------------------------
  // Issue Management (delegated to IssueTracker)
  // --------------------------------------------------------------------------

  private getIssueList(): Issue[] {
    return this.issueTracker.getAll();
  }

  private addIssue(raw: RawIssueReport, reporterTaskId: string, reporterWorkerId: number): Issue {
    return this.issueTracker.addIssue(raw, reporterTaskId, reporterWorkerId);
  }

  updateIssueStatus(issueId: string, status: IssueStatus): boolean {
    return this.issueTracker.updateStatus(issueId, status);
  }

  clearAllIssues(): void {
    this.issueTracker.clear();
  }

  getOpenIssues(): Issue[] {
    return this.issueTracker.getOpen();
  }

  getOpenBlockers(): Issue[] {
    return this.issueTracker.getOpenBlockers();
  }

  private isIntegrationTask(taskId: string): boolean {
    return this.issueTracker.isIntegrationTask(taskId);
  }

  private formatIssuesForInjection(issues: Issue[]): string {
    return this.issueTracker.formatForInjection(issues);
  }

  // formatSingleIssue is now internal to IssueTracker

  // --------------------------------------------------------------------------
  // Session Persistence (delegated to SessionPersistence)
  // --------------------------------------------------------------------------

  private clearPersistTimer(): void {
    this.sessionPersistence.clearTimer();
  }

  private requestPersist(reason: string): void {
    this.sessionPersistence.request(reason);
  }

  private async persistNow(reason: string): Promise<void> {
    await this.sessionPersistence.persistNow(reason);
  }

  private async hydrateFromSessionStore(): Promise<void> {
    await this.sessionPersistence.hydrate({
      restoreIssues: (issues) => {
        this.ctx.issues.clear();
        for (const issue of issues) {
          if (issue && typeof issue.id === 'string') {
            this.ctx.issues.set(issue.id, issue);
          }
        }
      },
      applyTaskState: (taskId, st, now) => {
        const task = this.ctx.tasks.get(taskId);
        if (!task) return;

        task.duration = st.duration;
        task.startTime = st.startTime;
        task.endTime = st.endTime;
        task.retryCount = st.retryCount;
        task.nextRetryAt = st.nextRetryAt;
        task.hasModifiedCode = st.hasModifiedCode;
        task.apiErrorRetryCount = st.apiErrorRetryCount;
        task.isApiErrorRecovery = st.isApiErrorRecovery;

        const fileStatus = task.status;
        let restoredStatus = st.status;

        if (restoredStatus === 'running') {
          restoredStatus = this.taskManager.canExecute(task) ? 'ready' : 'pending';
        }

        const isTerminal = (status: TaskStatus): boolean =>
          status === 'success' || status === 'failed' || status === 'canceled';

        // File status takes precedence in these cases:
        // 1. File says success, session says otherwise -> keep file's success (user manually reset is respected)
        // 2. File says non-terminal (pending/ready), session says terminal -> keep file's non-terminal
        //    This handles the case where user manually resets a task in AUTO-DEV.md by changing [x] to [ ]
        // 3. File is terminal, session is non-terminal -> keep file's terminal (already completed)
        const shouldOverrideStatus =
          // Don't override if file is success and session is not
          !(fileStatus === 'success' && restoredStatus !== 'success') &&
          // Don't override if file is non-terminal but session is terminal (user reset the task)
          !(!isTerminal(fileStatus) && isTerminal(restoredStatus)) &&
          // Don't override if file is terminal and session is non-terminal
          !(isTerminal(fileStatus) && !isTerminal(restoredStatus));

        if (shouldOverrideStatus) {
          task.status = restoredStatus;
        }

        if (task.status === 'failed' && task.nextRetryAt !== undefined && task.nextRetryAt <= now) {
          task.status = this.taskManager.canExecute(task) ? 'ready' : 'pending';
          task.nextRetryAt = undefined;
        }
      }
    });
  }

  // --------------------------------------------------------------------------
  // Blocker Auto-Pause
  // --------------------------------------------------------------------------

  getBlockerAutoPauseEnabled(): boolean {
    return this.ctx.blockerAutoPauseEnabled;
  }

  setBlockerAutoPauseEnabled(enabled: boolean): void {
    this.ctx.blockerAutoPauseEnabled = enabled;
    this.sessionPersistence.request('blockerConfig');

    if (enabled && this.ctx.running && !this.ctx.paused && this.getOpenBlockers().length > 0) {
      this.handleBlockerAutoPause();
    }
  }

  private handleBlockerAutoPause(): void {
    if (!this.ctx.running || !this.ctx.blockerAutoPauseEnabled || this.ctx.paused) return;

    const blockers = this.getOpenBlockers();
    if (blockers.length === 0) return;

    this.ctx.paused = true;
    this.ctx.pauseReason = 'blocker';

    this.emitEvent({
      type: 'schedulerState',
      payload: { running: true, paused: true, pausedReason: 'blocker' }
    });

    this.emitEvent({
      type: 'blockerAutoPause',
      payload: { issue: blockers[0]!, openBlockers: blockers.length }
    });

    this.sessionPersistence.request('blockerAutoPause');
  }

  // --------------------------------------------------------------------------
  // API Error Handling (delegated to ResilienceManager)
  // --------------------------------------------------------------------------

  /**
   * Public method for user to manually retry after API error max retries exceeded
   */
  retryFromApiError(): void {
    this.resilienceManager.retryFromApiError();
  }

  // --------------------------------------------------------------------------
  // Event Emission
  // --------------------------------------------------------------------------

  private emitEvent(event: EventPayload): void {
    try {
      (this.emit as (event: string, msg: EventPayload) => boolean)(event.type, event);
    } catch (err) {
      // Isolate listener exceptions from scheduler logic
      console.error(`[Scheduler] Event listener error (${event.type}):`, err);
    }
  }

  private emitProgress(): void {
    this.emitEvent({ type: 'progress', payload: this.getProgress() });
  }

  private emitWorkerState(wrapper: SchedulerWorkerWrapper): void {
    // Only ClaudeWorker has tokenUsage and currentTool properties
    const claudeWorker = wrapper.workerKind === 'claude' ? (wrapper.worker as ClaudeWorker) : null;
    this.emitEvent({
      type: 'workerState',
      payload: {
        workerId: wrapper.id,
        active: !wrapper.closing,
        taskId: wrapper.taskId,
        tokenUsage: claudeWorker?.currentTokenUsage ?? undefined,
        currentTool: claudeWorker?.currentToolName ?? undefined,
        workerKind: wrapper.workerKind
      }
    });
  }

  // --------------------------------------------------------------------------
  // Compile Checker
  // --------------------------------------------------------------------------

  /**
   * Run baseline compile check at scheduler start.
   * Records existing errors for comparison later.
   */
  private async runBaselineCompileCheck(): Promise<void> {
    console.log('[Scheduler] Running baseline compile check...');

    const result = await runTscCheck(this.ctx.projectRoot);
    const durSec = Math.round(result.duration / 100) / 10;

    // Handle tsc execution failure (not compilation errors)
    if (result.executionError) {
      console.warn(`[Scheduler] Baseline compile check failed: ${result.executionError} - disabling compile checks`);
      // Report as issue so UI is aware
      this.issueTracker.addIssue({
        title: '编译检查初始化失败: tsc 执行错误',
        severity: 'warning',
        files: [],
        signature: 'compile-check:baseline-failed',
        details: `基线编译检查执行失败，已禁用后续编译检查: ${result.executionError}`,
        ownerTaskId: null
      }, 'COMPILE_CHECK', 0);
      this.compileCheckEnabled = false;
      return;
    }

    this.baselineCompileErrors = result.errors;
    const errCount = result.errors.length;

    if (errCount > 0) {
      console.log(`[Scheduler] Baseline: ${errCount} TypeScript errors (${durSec}s) - recorded for regression detection`);
      // Baseline errors are stored internally for comparison only.
      // Only NEW errors introduced by tasks will be reported to the user.
    } else {
      console.log(`[Scheduler] Baseline: No TypeScript errors (${durSec}s)`);
    }
  }

  /**
   * Run compile check after a wave completes.
   * Compares with baseline and reports new errors.
   */
  async runPostWaveCompileCheck(waveId: number): Promise<void> {
    if (!this.compileCheckEnabled) return;

    console.log(`[Scheduler] Running post-wave ${waveId} compile check...`);

    const result = await runTscCheck(this.ctx.projectRoot);
    const durSec = Math.round(result.duration / 100) / 10;

    // Handle tsc execution failure (not compilation errors)
    if (result.executionError) {
      console.warn(`[Scheduler] Wave ${waveId}: tsc execution failed - ${result.executionError}`);
      this.issueTracker.addIssue({
        title: `Wave ${waveId} 编译检查失败: tsc 执行错误`,
        severity: 'warning',
        files: [],
        signature: `compile-check:tsc-failed:wave-${waveId}`,
        details: `Wave ${waveId} 完成后的编译检查执行失败: ${result.executionError}`,
        ownerTaskId: null
      }, 'COMPILE_CHECK', 0);
      return;
    }

    if (result.errors.length === 0) {
      console.log(`[Scheduler] Wave ${waveId}: No TypeScript errors (${durSec}s)`);
      return;
    }

    const { added, removed, unchanged } = diffErrors(this.baselineCompileErrors, result.errors);

    console.log(`[Scheduler] Wave ${waveId}: ${result.errors.length} errors (${durSec}s) - ` +
      `${added.length} new, ${removed.length} fixed, ${unchanged.length} unchanged`);

    // Report new errors (not in baseline)
    if (added.length > 0) {
      const issues = convertToIssues(added, []);
      for (const issue of issues) {
        this.issueTracker.addIssue({
          title: issue.title,
          severity: issue.severity,
          files: issue.files,
          signature: issue.signature,
          details: `[Wave ${waveId}] ${issue.details}`,
          ownerTaskId: null
        }, 'COMPILE_CHECK', 0);
      }
    }

    // Update baseline to include current errors (so we don't re-report fixed then broken again)
    this.baselineCompileErrors = result.errors;
  }

  /**
   * Enable or disable compile checking
   */
  setCompileCheckEnabled(enabled: boolean): void {
    this.compileCheckEnabled = enabled;
  }

  /**
   * Get compile check enabled state
   */
  getCompileCheckEnabled(): boolean {
    return this.compileCheckEnabled;
  }
}

// ============================================================================
// EventEmitter Type Augmentation
// ============================================================================

export interface Scheduler {
  on(event: 'fileLoaded', listener: (msg: { type: 'fileLoaded'; payload: FileLoadedPayload }) => void): this;
  on(event: 'taskUpdate', listener: (msg: { type: 'taskUpdate'; payload: TaskUpdatePayload }) => void): this;
  on(event: 'workerLog', listener: (msg: { type: 'workerLog'; payload: WorkerLogPayload }) => void): this;
  on(event: 'progress', listener: (msg: { type: 'progress'; payload: Progress }) => void): this;
  on(event: 'schedulerState', listener: (msg: { type: 'schedulerState'; payload: SchedulerStatePayload }) => void): this;
  on(event: 'workerState', listener: (msg: { type: 'workerState'; payload: WorkerStatePayload }) => void): this;
  on(event: 'issueReported', listener: (msg: { type: 'issueReported'; payload: IssueReportedPayload }) => void): this;
  on(event: 'issueUpdate', listener: (msg: { type: 'issueUpdate'; payload: IssueUpdatePayload }) => void): this;
  on(event: 'apiError', listener: (msg: { type: 'apiError'; payload: ApiErrorPayload }) => void): this;

  emit(event: 'fileLoaded', msg: { type: 'fileLoaded'; payload: FileLoadedPayload }): boolean;
  emit(event: 'taskUpdate', msg: { type: 'taskUpdate'; payload: TaskUpdatePayload }): boolean;
  emit(event: 'workerLog', msg: { type: 'workerLog'; payload: WorkerLogPayload }): boolean;
  emit(event: 'progress', msg: { type: 'progress'; payload: Progress }): boolean;
  emit(event: 'schedulerState', msg: { type: 'schedulerState'; payload: SchedulerStatePayload }): boolean;
  emit(event: 'workerState', msg: { type: 'workerState'; payload: WorkerStatePayload }): boolean;
  emit(event: 'issueReported', msg: { type: 'issueReported'; payload: IssueReportedPayload }): boolean;
  emit(event: 'issueUpdate', msg: { type: 'issueUpdate'; payload: IssueUpdatePayload }): boolean;
  emit(event: 'apiError', msg: { type: 'apiError'; payload: ApiErrorPayload }): boolean;
}
