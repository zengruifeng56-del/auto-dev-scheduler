/**
 * Compile Checker
 *
 * Runs TypeScript compilation check (`tsc --noEmit`) and auto-reports errors as issues.
 * This ensures compilation errors are always captured regardless of what workers report.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { IssueSeverity } from '../../shared/types';

// ============================================================================
// Types
// ============================================================================

export interface CompileError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

export interface CompileCheckResult {
  success: boolean;
  errors: CompileError[];
  duration: number;
  /** Indicates tsc binary failed to execute (not compile errors) */
  executionError?: string;
}

export interface CompileIssue {
  title: string;
  severity: IssueSeverity;
  files: string[];
  signature: string;
  details: string;
  isBaseline: boolean;
}

// ============================================================================
// Parse TSC Output
// ============================================================================

// Standard file error: src/file.ts(10,5): error TS2345: ...
const TSC_FILE_ERROR_REGEX = /^(.+)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/;

// Config/global error without file location: error TS5083: Cannot read file ...
const TSC_GLOBAL_ERROR_REGEX = /^error\s+(TS\d+):\s*(.+)$/;

// Config error with file but no line/col: tsconfig.json: error TS5083: ...
const TSC_CONFIG_ERROR_REGEX = /^(.+):\s*error\s+(TS\d+):\s*(.+)$/;

interface ParseResult {
  errors: CompileError[];
  hasGlobalErrors: boolean;
  globalErrorMessages: string[];
}

function parseTscOutput(output: string): ParseResult {
  const errors: CompileError[] = [];
  const globalErrorMessages: string[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try standard file error first (most common)
    const fileMatch = TSC_FILE_ERROR_REGEX.exec(trimmed);
    if (fileMatch) {
      errors.push({
        file: fileMatch[1]!,
        line: parseInt(fileMatch[2]!, 10),
        column: parseInt(fileMatch[3]!, 10),
        code: fileMatch[4]!,
        message: fileMatch[5]!
      });
      continue;
    }

    // Try global error (no file location)
    const globalMatch = TSC_GLOBAL_ERROR_REGEX.exec(trimmed);
    if (globalMatch) {
      globalErrorMessages.push(`${globalMatch[1]}: ${globalMatch[2]}`);
      // Also add as a pseudo-error for tracking
      errors.push({
        file: '<config>',
        line: 0,
        column: 0,
        code: globalMatch[1]!,
        message: globalMatch[2]!
      });
      continue;
    }

    // Try config error (file but no line/col)
    const configMatch = TSC_CONFIG_ERROR_REGEX.exec(trimmed);
    if (configMatch) {
      errors.push({
        file: configMatch[1]!,
        line: 0,
        column: 0,
        code: configMatch[2]!,
        message: configMatch[3]!
      });
      continue;
    }
  }

  return {
    errors,
    hasGlobalErrors: globalErrorMessages.length > 0,
    globalErrorMessages
  };
}

// ============================================================================
// Resolve TSConfig Path
// ============================================================================

function resolveTsconfigPath(projectRoot: string, tsconfigPath?: string): string | null {
  if (tsconfigPath) return tsconfigPath;

  // Check root tsconfig first
  const rootConfig = path.join(projectRoot, 'tsconfig.json');
  if (existsSync(rootConfig)) return rootConfig;

  // Fallback to server/tsconfig.json for monorepo (primary backend code)
  const serverConfig = path.join(projectRoot, 'server', 'tsconfig.json');
  return existsSync(serverConfig) ? serverConfig : null;
}

// ============================================================================
// Run TSC
// ============================================================================

export async function runTscCheck(projectRoot: string, tsconfigPath?: string): Promise<CompileCheckResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    const resolvedTsconfig = resolveTsconfigPath(projectRoot, tsconfigPath);
    if (!resolvedTsconfig) {
      console.warn(`[CompileChecker] No tsconfig.json found under ${projectRoot}; skipping tsc check.`);
      resolve({ success: true, errors: [], duration: Date.now() - startTime });
      return;
    }

    // --pretty defaults to false when stdout is not a TTY, so keep args minimal
    const args = ['--noEmit', '-p', resolvedTsconfig];

    // Try to find tsc: prefer local node_modules, fallback to npx
    const isWin = process.platform === 'win32';
    const localTsc = path.join(projectRoot, 'node_modules', '.bin', isWin ? 'tsc.cmd' : 'tsc');
    const useLocalTsc = existsSync(localTsc);

    let cmd: string;
    let cmdArgs: string[];
    if (isWin) {
      cmd = 'cmd.exe';
      cmdArgs = useLocalTsc
        ? ['/d', '/s', '/c', localTsc, ...args]
        : ['/d', '/s', '/c', 'npx', 'tsc', ...args];
    } else {
      cmd = useLocalTsc ? localTsc : 'npx';
      cmdArgs = useLocalTsc ? args : ['tsc', ...args];
    }

    const proc = spawn(cmd, cmdArgs, {
      cwd: projectRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      console.warn('[CompileChecker] Failed to run tsc:', err.message);
      resolve({
        success: false,
        errors: [],
        duration: Date.now() - startTime,
        executionError: err.message
      });
    });

    proc.on('close', (code) => {
      const output = stdout + stderr;
      const parseResult = parseTscOutput(output);

      // Only set executionError if tsc failed AND we couldn't parse any errors
      // This means something went wrong with tsc itself (not found, crashed, etc.)
      const executionError = code !== 0 && parseResult.errors.length === 0
        ? `tsc exited with code ${code} but no errors parsed. Output: ${output.slice(0, 200)}`
        : undefined;

      resolve({
        success: code === 0,
        errors: parseResult.errors,
        duration: Date.now() - startTime,
        executionError
      });
    });
  });
}

// ============================================================================
// Convert to Issues
// ============================================================================

export function convertToIssues(errors: CompileError[], baselineErrors: CompileError[] = []): CompileIssue[] {
  // Create set of baseline error signatures for quick lookup
  const baselineSet = new Set(
    baselineErrors.map(e => computeErrorSignature(e))
  );

  return errors.map(error => {
    const signature = computeErrorSignature(error);
    const isBaseline = baselineSet.has(signature);

    return {
      title: `TypeScript Error ${error.code}: ${truncateMessage(error.message)}`,
      severity: 'error' as IssueSeverity,
      files: [error.file],
      signature: `tsc:${signature}`,
      details: `${error.file}:${error.line}:${error.column} - ${error.message}`,
      isBaseline
    };
  });
}

function computeErrorSignature(error: CompileError): string {
  // Normalize file path and create deterministic signature
  const normalized = error.file.replace(/\\/g, '/');
  const data = `${error.code}:${normalized}:${error.line}:${error.column}`;
  return createHash('sha1').update(data).digest('hex').slice(0, 12);
}

function truncateMessage(message: string, maxLen = 80): string {
  if (message.length <= maxLen) return message;
  return message.slice(0, maxLen - 3) + '...';
}

// ============================================================================
// Diff Errors
// ============================================================================

export function diffErrors(
  before: CompileError[],
  after: CompileError[]
): { added: CompileError[]; removed: CompileError[]; unchanged: CompileError[] } {
  const beforeSigs = new Map(before.map(e => [computeErrorSignature(e), e]));
  const afterSigs = new Map(after.map(e => [computeErrorSignature(e), e]));

  const added: CompileError[] = [];
  const removed: CompileError[] = [];
  const unchanged: CompileError[] = [];

  for (const [sig, error] of afterSigs) {
    if (beforeSigs.has(sig)) {
      unchanged.push(error);
    } else {
      added.push(error);
    }
  }

  for (const [sig, error] of beforeSigs) {
    if (!afterSigs.has(sig)) {
      removed.push(error);
    }
  }

  return { added, removed, unchanged };
}
