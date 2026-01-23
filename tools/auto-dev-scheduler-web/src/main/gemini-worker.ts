/**
 * @deprecated Phase 4: Claude-First Architecture
 *
 * This file is DEPRECATED and no longer used by the scheduler.
 *
 * In Phase 4, all tasks are routed through Claude first. Claude then decides
 * whether to delegate to Codex/Gemini via MCP tools:
 * - mcp__codex__codex: For backend/debug tasks
 * - mcp__gemini__gemini: For frontend/UI tasks
 *
 * This file is kept for reference but should not be used directly.
 * The scheduler now uses ClaudeWorker exclusively.
 *
 * ---
 *
 * Original description:
 * Gemini Worker - Direct CLI invocation for frontend/UI tasks
 *
 * Wraps the `gemini` CLI command for:
 * - Frontend code (CSS/React/Vue/HTML)
 * - UI component design
 * - Task planning and clarification
 *
 * Design: Uses sandbox mode for safety, passes prompt via stdin to avoid
 * Windows command-line length limits.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

import treeKill from 'tree-kill';

import type { LogEntry, WorkerCapabilities, WorkerRunRequest, WorkerRunResult } from '../shared/types';
import { getDefaultCapabilities, type IWorker, type WorkerEvent } from './worker-types';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_TIMEOUT_MS = 30 * 60_000; // 30 minutes

// ============================================================================
// GeminiWorker Implementation
// ============================================================================

export class GeminiWorker extends EventEmitter implements IWorker {
  readonly id: string;
  readonly capabilities: WorkerCapabilities;

  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutRl: ReadlineInterface | null = null;
  private stderrRl: ReadlineInterface | null = null;
  private currentRunId: string | null = null;
  private sessionId: string | null = null;
  private disposed = false;
  private timeoutTimer: NodeJS.Timeout | null = null;

  constructor(workerId?: number) {
    super();
    this.id = `gemini-${workerId ?? randomUUID().slice(0, 8)}`;
    this.capabilities = getDefaultCapabilities('gemini-cli');
  }

  async *run(req: WorkerRunRequest): AsyncIterable<WorkerEvent> {
    if (this.disposed) {
      throw new Error('Worker has been disposed');
    }

    this.currentRunId = req.runId;
    const startMs = Date.now();
    const timeoutMs = req.timeout ?? DEFAULT_TIMEOUT_MS;

    yield { type: 'status', phase: 'starting', at: startMs };

    try {
      // Build gemini command - use stdin for prompt to avoid length limits
      // No sandbox for full write access
      const args = [
        '--cd', req.projectRoot
      ];

      // Add session ID for continuity
      if (this.sessionId) {
        args.push('--SESSION_ID', this.sessionId);
      }

      this.emitLog('system', `Starting Gemini: gemini ${args.join(' ')}`);

      const child = spawn('gemini', args, {
        cwd: req.projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: true
      });

      this.process = child;

      // Register exit promise IMMEDIATELY after spawn to avoid missing events
      const exitPromise = new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code));
        child.once('error', () => resolve(null));
      });

      // Set up timeout
      this.timeoutTimer = setTimeout(() => {
        this.emitLog('error', `Timeout after ${timeoutMs / 1000}s`);
        void this.killProcess();
      }, timeoutMs);

      child.stdin.setDefaultEncoding('utf8');
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      // Write prompt to stdin and close (prepend personaPrompt if present)
      const personaPrompt = req.personaPrompt?.trim();
      const fullPrompt = personaPrompt ? `${personaPrompt}\n\n---\n\n${req.prompt}` : req.prompt;
      child.stdin.write(fullPrompt);
      child.stdin.end();

      this.stdoutRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      this.stderrRl = createInterface({ input: child.stderr, crlfDelay: Infinity });

      yield { type: 'status', phase: 'running', at: Date.now() };

      // Collect stderr - CLI outputs info to stderr, not just errors
      const stderrLines: string[] = [];
      this.stderrRl.on('line', (line) => {
        stderrLines.push(line);
        this.emitLog('system', line);
      });

      // Process stdout - preserve all lines (including empty for diff format)
      for await (const line of this.stdoutRl) {
        // Try to parse as JSON for session ID
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.SESSION_ID && typeof parsed.SESSION_ID === 'string') {
            this.sessionId = parsed.SESSION_ID;
          }
        } catch {
          // Not JSON, just output
        }

        yield { type: 'stdout', text: line, at: Date.now() };
        // Log truncated version for UI
        const logLine = line.length > 500 ? `${line.slice(0, 500)}...` : line;
        if (logLine.trim()) {
          this.emitLog('output', logLine);
        }
      }

      // Clear timeout
      if (this.timeoutTimer) {
        clearTimeout(this.timeoutTimer);
        this.timeoutTimer = null;
      }

      // Wait for process to exit (use pre-registered promise to avoid missing events)
      const exitCode = child.exitCode ?? await exitPromise;

      const durationMs = Date.now() - startMs;
      const success = exitCode === 0;

      yield { type: 'status', phase: 'finishing', at: Date.now() };

      // Build error message with stderr context
      let errorMsg: string | undefined;
      if (!success) {
        const stderrTail = stderrLines.slice(-10).join('\n');
        errorMsg = `Gemini exited with code ${exitCode}`;
        if (stderrTail) {
          errorMsg += `\nStderr:\n${stderrTail}`;
        }
      }

      const result: WorkerRunResult = {
        success,
        durationMs,
        error: errorMsg
      };

      yield { type: 'final', at: Date.now(), result };

      this.emitLog('system', `Gemini completed: ${success ? 'OK' : 'FAIL'} in ${Math.round(durationMs / 1000)}s`);
    } catch (err) {
      // Clear timeout on error
      if (this.timeoutTimer) {
        clearTimeout(this.timeoutTimer);
        this.timeoutTimer = null;
      }

      const error = err instanceof Error ? err.message : String(err);
      this.emitLog('error', `Gemini error: ${error}`);

      yield {
        type: 'final',
        at: Date.now(),
        result: {
          success: false,
          durationMs: Date.now() - startMs,
          error
        }
      };
    } finally {
      this.cleanup();
    }
  }

  async cancel(runId: string): Promise<void> {
    if (this.currentRunId !== runId) return;
    await this.killProcess();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    await this.killProcess();
    this.removeAllListeners();
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private async killProcess(): Promise<void> {
    const proc = this.process;
    if (!proc) return;

    const pid = proc.pid;
    if (pid === undefined) return;

    await new Promise<void>((resolve) => {
      treeKill(pid, 'SIGKILL', () => resolve());
    });

    this.process = null;
  }

  private cleanup(): void {
    try { this.stdoutRl?.close(); } catch { /* ignore */ }
    try { this.stderrRl?.close(); } catch { /* ignore */ }
    this.stdoutRl = null;
    this.stderrRl = null;
    this.process = null;
    this.currentRunId = null;
  }

  private emitLog(type: LogEntry['type'], content: string): void {
    const entry: LogEntry = {
      ts: new Date().toISOString().slice(11, 19),
      type,
      content
    };
    this.emit('log', entry);
  }
}

// ============================================================================
// Type Augmentation
// ============================================================================

export interface GeminiWorker {
  on(event: 'log', listener: (entry: LogEntry) => void): this;
  emit(event: 'log', entry: LogEntry): boolean;
}
