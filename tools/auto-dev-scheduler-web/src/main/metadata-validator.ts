/**
 * Metadata Validator - Lightweight validation for task metadata consistency
 *
 * Validates:
 * 1. Scope vs TaskId prefix conflicts (e.g., FE-* task with Scope:BE)
 * 2. Persona format validation (<provider>/<name>)
 * 3. Persona file existence (warn-only)
 *
 * All validations are warn-only by default to avoid blocking execution.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { isValidPersonaFormat } from './routing-registry';
import type { Task, TaskScope } from '../shared/types';

// ============================================================================
// Types
// ============================================================================

/**
 * Validation result with warnings and errors
 */
export interface ValidationResult {
  /** True if no blocking errors (warnings are allowed) */
  valid: boolean;
  /** Non-blocking issues that should be logged */
  warnings: string[];
  /** Blocking issues that should prevent execution */
  errors: string[];
}

/**
 * Batch validation summary for multiple tasks
 */
export interface BatchValidationResult {
  /** Number of tasks that passed validation */
  validCount: number;
  /** Number of tasks with warnings */
  warningCount: number;
  /** Number of tasks with errors */
  errorCount: number;
  /** Per-task validation results (only for tasks with issues) */
  taskResults: Map<string, ValidationResult>;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * TaskId prefix to expected scope mapping
 * Used to detect conflicts like FE-* task with Scope:BE
 */
const PREFIX_TO_SCOPE: ReadonlyMap<string, TaskScope> = new Map([
  ['FE-', 'FE'],
  ['FE-COCOS-', 'FE'],
  ['FE-VUE-', 'FE'],
  ['BE-', 'BE'],
  ['BE-API-', 'BE'],
  ['BE-ARCH-', 'BE'],
  ['PROTO-FE-', 'FE'],
  ['PROTO-BE-', 'BE'],
  ['AUDIT-FE-', 'FE'],
  ['AUDIT-BE-', 'BE']
]);

// ============================================================================
// Core Validation Functions
// ============================================================================

/**
 * Get the implied scope from a task ID prefix
 *
 * @param taskId - The task ID to check
 * @returns The implied scope or undefined if no specific scope is implied
 */
function getImpliedScope(taskId: string): TaskScope | undefined {
  const upper = taskId.toUpperCase();

  // Check longer prefixes first (more specific)
  const prefixesByLength = [...PREFIX_TO_SCOPE.keys()].sort((a, b) => b.length - a.length);

  for (const prefix of prefixesByLength) {
    if (upper.startsWith(prefix)) {
      return PREFIX_TO_SCOPE.get(prefix);
    }
  }

  return undefined;
}

/**
 * Validate a single task's metadata for consistency
 *
 * @param task - The task to validate
 * @param projectRoot - Project root path for checking persona file existence
 * @returns Validation result with warnings and errors
 */
export function validateTaskMetadata(task: Task, projectRoot: string): ValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  // 1. Check Scope vs TaskId prefix conflict
  if (task.scope) {
    const impliedScope = getImpliedScope(task.id);
    if (impliedScope && impliedScope !== task.scope) {
      warnings.push(
        `Task ${task.id} has conflicting Scope:${task.scope} with ${impliedScope}- prefix implied by task ID`
      );
    }
  }

  // 2. Validate Persona format if present
  if (task.persona) {
    if (!isValidPersonaFormat(task.persona)) {
      errors.push(
        `Invalid Persona format for task ${task.id}: "${task.persona}", expected <provider>/<name> where provider is gemini/codex/shared`
      );
    } else {
      // 3. Check Persona file existence (warn-only)
      const [provider, name] = task.persona.split('/');
      const promptPath = path.join(projectRoot, '.claude', 'prompts', 'personas', provider!, `${name}.md`);

      if (!existsSync(promptPath)) {
        warnings.push(`Persona file not found for task ${task.id}: ${promptPath}`);
      }
    }
  }

  // 4. Validate taskKind consistency with prefix (informational)
  // This is mainly for catching parsing issues
  if (task.taskKind) {
    const upper = task.id.toUpperCase();
    const expectedKindMap: Record<string, string> = {
      'PROTO-': 'prototype',
      'AUDIT-': 'audit',
      'FE-': 'frontend',
      'BE-': 'backend',
      'INT-': 'integration',
      'REVIEW-': 'review'
    };

    for (const [prefix, expectedKind] of Object.entries(expectedKindMap)) {
      if (upper.startsWith(prefix) && task.taskKind !== expectedKind) {
        warnings.push(
          `Task ${task.id} has taskKind "${task.taskKind}" but ID prefix suggests "${expectedKind}"`
        );
        break;
      }
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors
  };
}

/**
 * Validate all tasks in a batch
 *
 * @param tasks - Map of tasks to validate
 * @param projectRoot - Project root path for checking persona file existence
 * @returns Summary of validation results
 */
export function validateAllTasks(tasks: Map<string, Task>, projectRoot: string): BatchValidationResult {
  const taskResults = new Map<string, ValidationResult>();
  let validCount = 0;
  let warningCount = 0;
  let errorCount = 0;

  for (const [taskId, task] of tasks) {
    const result = validateTaskMetadata(task, projectRoot);

    if (result.errors.length > 0) {
      errorCount++;
      taskResults.set(taskId, result);
    } else if (result.warnings.length > 0) {
      warningCount++;
      taskResults.set(taskId, result);
    } else {
      validCount++;
    }
  }

  return {
    validCount,
    warningCount,
    errorCount,
    taskResults
  };
}

/**
 * Format validation results for logging
 *
 * @param results - Batch validation results
 * @returns Formatted string for logging
 */
export function formatValidationReport(results: BatchValidationResult): string {
  const lines: string[] = [];
  const total = results.validCount + results.warningCount + results.errorCount;

  lines.push(`Metadata Validation: ${results.validCount}/${total} tasks valid`);

  if (results.warningCount > 0) {
    lines.push(`  ⚠️ ${results.warningCount} tasks with warnings`);
  }

  if (results.errorCount > 0) {
    lines.push(`  ❌ ${results.errorCount} tasks with errors`);
  }

  // Detail errors and warnings
  for (const [taskId, result] of results.taskResults) {
    if (result.errors.length > 0) {
      for (const error of result.errors) {
        lines.push(`  [ERROR] ${error}`);
      }
    }
    if (result.warnings.length > 0) {
      for (const warning of result.warnings) {
        lines.push(`  [WARN] ${warning}`);
      }
    }
  }

  return lines.join('\n');
}
