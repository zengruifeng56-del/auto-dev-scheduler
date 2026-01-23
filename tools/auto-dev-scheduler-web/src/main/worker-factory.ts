/**
 * Worker Factory - Creates workers based on task persona/type
 *
 * Phase 4: Claude-First Architecture
 *
 * In the new architecture, all tasks are routed through Claude.
 * Claude decides whether to delegate to Codex/Gemini via MCP tools:
 * - mcp__codex__codex: For backend/debug tasks
 * - mcp__gemini__gemini: For frontend/UI tasks
 *
 * This factory is now simplified - it only supports claude-cli worker type.
 * The routing rules from routing-registry.ts are still used to provide
 * delegation hints to Claude.
 */

import type { WorkerType } from '../shared/types';
// Phase 4: CodexWorker and GeminiWorker are deprecated
// import { CodexWorker } from './codex-worker';
// import { GeminiWorker } from './gemini-worker';
import { resolveWorkerType } from './routing-registry';
import type { IWorker, IWorkerFactory, WorkerConfig } from './worker-types';

// ============================================================================
// ClaudeWorkerAdapter
// ============================================================================

// Note: ClaudeWorker already exists but doesn't implement IWorker interface.
// For Phase 3, we'll create a thin adapter that wraps the existing ClaudeWorker
// when needed. For now, we throw an error for claude-cli type since the
// scheduler still uses ClaudeWorker directly.

class ClaudeWorkerNotImplementedError extends Error {
  constructor() {
    super(
      'ClaudeWorker IWorker adapter not yet implemented. ' +
      'The scheduler still uses the existing ClaudeWorker directly for claude-cli tasks. ' +
      'This factory is for Codex/Gemini workers only in Phase 3.'
    );
    this.name = 'ClaudeWorkerNotImplementedError';
  }
}

// ============================================================================
// WorkerFactory Implementation
// ============================================================================

export class WorkerFactory implements IWorkerFactory {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Phase 4: All worker types now route to Claude
   *
   * ClaudeWorker is handled directly by the scheduler.
   * This factory method now throws for all types since the scheduler
   * no longer uses it for worker creation.
   */
  create(cfg: WorkerConfig): IWorker {
    // Phase 4: All tasks go through Claude
    // The scheduler creates ClaudeWorker instances directly
    // This factory is kept for API compatibility but should not be called
    switch (cfg.type) {
      case 'codex-cli':
      case 'gemini-cli':
        // Phase 4: These are now handled via MCP tools inside Claude
        throw new Error(
          `Phase 4: ${cfg.type} is no longer directly instantiated. ` +
          `Claude uses MCP tools for delegation. ` +
          `See routing-registry.ts getDelegationHint() for delegation logic.`
        );

      case 'claude-cli':
        // Claude is handled separately by existing scheduler logic
        throw new ClaudeWorkerNotImplementedError();

      default: {
        const _exhaustive: never = cfg.type;
        throw new Error(`Unknown worker type: ${cfg.type}`);
      }
    }
  }

  resolveType(persona: string | null): WorkerType {
    return resolveWorkerType(persona);
  }
}

// ============================================================================
// Factory Creation Helper
// ============================================================================

export function createWorkerFactory(projectRoot: string): IWorkerFactory {
  return new WorkerFactory(projectRoot);
}

// ============================================================================
// Routing Preview Types
// ============================================================================

export interface RoutingDecision {
  taskId: string;
  persona: string | null;
  workerType: WorkerType;
  reason: string;
}

export interface RoutingPreview {
  decisions: RoutingDecision[];
  summary: {
    claude: number;
    codex: number;
    gemini: number;
  };
}

/**
 * Generate routing preview for a list of tasks (dry-run)
 */
export function generateRoutingPreview(
  tasks: Array<{ id: string; persona?: string | null }>,
  resolvePersona: (task: { id: string }) => string | null
): RoutingPreview {
  const decisions: RoutingDecision[] = [];
  const summary = { claude: 0, codex: 0, gemini: 0 };

  for (const task of tasks) {
    const persona = task.persona ?? resolvePersona(task);
    const workerType = resolveWorkerType(persona);

    let reason: string;
    if (task.persona) {
      reason = 'explicit persona';
    } else if (persona) {
      reason = 'routing rule match';
    } else {
      reason = 'default (Claude)';
    }

    decisions.push({
      taskId: task.id,
      persona,
      workerType,
      reason
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

  return { decisions, summary };
}

/**
 * Format routing preview for console output
 */
export function formatRoutingPreview(preview: RoutingPreview): string {
  const lines: string[] = ['=== Route Preview ===', ''];

  // Group by worker type
  const byType: Record<string, RoutingDecision[]> = {
    'claude-cli': [],
    'codex-cli': [],
    'gemini-cli': []
  };

  for (const d of preview.decisions) {
    byType[d.workerType].push(d);
  }

  // Format each group
  const typeLabels: Record<string, string> = {
    'claude-cli': '🟣 Claude',
    'codex-cli': '🔵 Codex',
    'gemini-cli': '🟢 Gemini'
  };

  for (const [type, decisions] of Object.entries(byType)) {
    if (decisions.length === 0) continue;

    lines.push(`${typeLabels[type]} (${decisions.length} tasks):`);
    for (const d of decisions) {
      const personaStr = d.persona ? `→ ${d.persona}` : '(direct)';
      lines.push(`  ${d.taskId} ${personaStr}`);
    }
    lines.push('');
  }

  // Summary
  lines.push('Summary:');
  lines.push(`  Claude: ${preview.summary.claude}`);
  lines.push(`  Codex:  ${preview.summary.codex}`);
  lines.push(`  Gemini: ${preview.summary.gemini}`);

  return lines.join('\n');
}
