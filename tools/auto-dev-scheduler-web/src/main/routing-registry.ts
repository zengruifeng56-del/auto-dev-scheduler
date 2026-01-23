/**
 * Routing Registry - Single source of truth for task persona routing
 *
 * This module centralizes all routing rules for determining which persona
 * (model + prompt) should handle a given task based on:
 * 1. Explicit persona field (highest priority)
 * 2. Task scope (FE/BE/FULL)
 * 3. TaskId prefix pattern matching
 *
 * Priority order: explicit persona > scope > taskId prefix > default (null)
 *
 * Phase 3: Also supports resolving WorkerType from persona.
 */

import type { Task, TaskScope, WorkerType } from '../shared/types';

// ============================================================================
// Types
// ============================================================================

/**
 * Routing rule definition for matching tasks to personas
 */
export interface RoutingRule {
  /** Regex pattern to match against task ID */
  pattern: RegExp;
  /** Persona identifier (e.g., "gemini/cocos-game-expert") or null for Claude direct */
  persona: string | null;
  /** Higher priority rules are checked first (descending order) */
  priority: number;
  /** Human-readable description for debugging/logging */
  description?: string;
}

/**
 * Scope-based routing configuration
 */
export interface ScopeRouting {
  scope: TaskScope;
  persona: string | null;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Routing rules ordered by priority (higher = checked first)
 *
 * Rule categories:
 * - Priority 20+: Composite prefixes (PROTO-FE, AUDIT-BE, etc.)
 * - Priority 15: Audit tasks
 * - Priority 10: Primary domain prefixes (FE-*, BE-*)
 * - Priority 5: Integration/general tasks
 */
export const ROUTING_RULES: readonly RoutingRule[] = Object.freeze([
  // Composite prefixes - highest priority (must check before simple FE-/BE-)
  {
    pattern: /^PROTO-FE-/i,
    persona: 'gemini/cocos-game-expert',
    priority: 20,
    description: 'Frontend prototype generation'
  },
  {
    pattern: /^PROTO-BE-/i,
    persona: 'codex/fastify-backend',
    priority: 20,
    description: 'Backend prototype generation'
  },
  {
    pattern: /^PROTO-VUE-/i,
    persona: 'gemini/vue-tooling-expert',
    priority: 20,
    description: 'Vue/Electron prototype generation'
  },
  // Audit tasks
  {
    pattern: /^AUDIT-FE-/i,
    persona: 'gemini/code-reviewer',
    priority: 15,
    description: 'Frontend code audit'
  },
  {
    pattern: /^AUDIT-BE-/i,
    persona: 'codex/code-reviewer',
    priority: 15,
    description: 'Backend code audit'
  },
  // Primary domain prefixes
  {
    pattern: /^FE-COCOS-/i,
    persona: 'gemini/cocos-game-expert',
    priority: 10,
    description: 'Cocos Creator frontend development'
  },
  {
    pattern: /^FE-VUE-/i,
    persona: 'gemini/vue-tooling-expert',
    priority: 10,
    description: 'Vue/Electron tooling development'
  },
  {
    pattern: /^FE-/i,
    persona: 'gemini/cocos-game-expert',
    priority: 8,
    description: 'Generic frontend (defaults to Cocos)'
  },
  {
    pattern: /^BE-API-/i,
    persona: 'codex/fastify-backend',
    priority: 10,
    description: 'Backend API development'
  },
  {
    pattern: /^BE-ARCH-/i,
    persona: 'codex/system-architect',
    priority: 10,
    description: 'Backend architecture design'
  },
  {
    pattern: /^BE-/i,
    persona: 'codex/fastify-backend',
    priority: 8,
    description: 'Generic backend (defaults to Fastify)'
  },
  // Integration tasks - Claude direct execution
  {
    pattern: /^INT-/i,
    persona: null,
    priority: 5,
    description: 'Integration tasks (Claude direct)'
  },
  // Review tasks
  {
    pattern: /^REVIEW-/i,
    persona: null,
    priority: 5,
    description: 'Review & sync tasks (Claude direct)'
  }
]);

/**
 * Scope-based fallback routing when no prefix matches
 */
export const SCOPE_ROUTING: readonly ScopeRouting[] = Object.freeze([
  { scope: 'FE', persona: 'gemini/cocos-game-expert' },
  { scope: 'BE', persona: 'codex/fastify-backend' },
  { scope: 'FULL', persona: null } // Full-stack tasks use Claude for coordination
]);

// ============================================================================
// Core Routing Logic
// ============================================================================

/**
 * Resolve the persona for a task based on routing priority:
 * 1. Explicit persona field (task.persona) - highest priority
 * 2. Scope-based routing (task.scope)
 * 3. TaskId prefix pattern matching
 * 4. Default: null (Claude direct execution)
 *
 * @param task - The task to resolve persona for
 * @returns Persona string (e.g., "gemini/cocos-game-expert") or null for Claude direct
 */
export function resolvePersona(task: Pick<Task, 'id' | 'persona' | 'scope'>): string | null {
  // Priority 1: Explicit persona always wins
  if (task.persona) {
    return task.persona;
  }

  // Priority 2: Scope-based routing
  if (task.scope) {
    const scopeMatch = SCOPE_ROUTING.find(sr => sr.scope === task.scope);
    if (scopeMatch) {
      return scopeMatch.persona;
    }
  }

  // Priority 3: TaskId prefix pattern matching (sorted by priority descending)
  const sortedRules = [...ROUTING_RULES].sort((a, b) => b.priority - a.priority);
  for (const rule of sortedRules) {
    if (rule.pattern.test(task.id)) {
      return rule.persona;
    }
  }

  // Priority 4: Default - Claude direct execution
  return null;
}

/**
 * Get the matched routing rule for a task (for debugging/logging)
 *
 * @param taskId - The task ID to check
 * @returns The matched RoutingRule or undefined if no match
 */
export function getMatchedRule(taskId: string): RoutingRule | undefined {
  const sortedRules = [...ROUTING_RULES].sort((a, b) => b.priority - a.priority);
  return sortedRules.find(rule => rule.pattern.test(taskId));
}

/**
 * Validate persona format: must be "<provider>/<name>"
 *
 * @param persona - The persona string to validate
 * @returns True if valid format, false otherwise
 */
export function isValidPersonaFormat(persona: string): boolean {
  if (!persona) return false;

  const parts = persona.split('/');
  if (parts.length !== 2) return false;

  const [provider, name] = parts;
  if (!provider || !name) return false;

  // Provider should be known: gemini, codex, or shared
  const validProviders = ['gemini', 'codex', 'shared'];
  return validProviders.includes(provider.toLowerCase());
}

/**
 * List all available personas defined in routing rules
 *
 * @returns Array of unique persona identifiers
 */
export function listAvailablePersonas(): string[] {
  const personas = new Set<string>();

  for (const rule of ROUTING_RULES) {
    if (rule.persona) {
      personas.add(rule.persona);
    }
  }

  for (const sr of SCOPE_ROUTING) {
    if (sr.persona) {
      personas.add(sr.persona);
    }
  }

  return [...personas].sort();
}

// ============================================================================
// Phase 4: Claude-First Architecture
// ============================================================================

/**
 * Resolve worker type - ALWAYS returns 'claude-cli'
 *
 * In the Claude-first architecture, all tasks are routed to Claude.
 * Claude then decides whether to delegate to Codex/Gemini via MCP tools.
 *
 * @param _persona - The persona string (ignored, kept for API compatibility)
 * @returns Always 'claude-cli'
 */
export function resolveWorkerType(_persona: string | null): WorkerType {
  // Phase 4: All tasks go through Claude first
  // Claude uses MCP tools (mcp__codex__codex, mcp__gemini__gemini) for delegation
  return 'claude-cli';
}

/**
 * Delegation target for Claude to consider
 */
export type DelegationTarget = 'codex' | 'gemini' | 'direct';

/**
 * Delegation hint for Claude
 */
export interface DelegationHint {
  target: DelegationTarget;
  persona: string | null;
  reason: string;
  mcpTool?: string;
}

/**
 * Get delegation hint for Claude based on task routing rules
 *
 * This provides suggestions for Claude on whether to delegate to Codex/Gemini.
 * Claude makes the final decision and performs code review after delegation.
 *
 * @param task - The task to get delegation hint for
 * @returns DelegationHint with target recommendation
 */
export function getDelegationHint(task: Pick<Task, 'id' | 'persona' | 'scope'>): DelegationHint {
  const persona = resolvePersona(task);

  if (!persona) {
    return {
      target: 'direct',
      persona: null,
      reason: 'Integration/review task - Claude executes directly'
    };
  }

  const [provider] = persona.split('/');
  switch (provider?.toLowerCase()) {
    case 'codex':
      return {
        target: 'codex',
        persona,
        reason: 'Backend/debug task - delegate to Codex for implementation, then review',
        mcpTool: 'mcp__codex__codex'
      };
    case 'gemini':
      return {
        target: 'gemini',
        persona,
        reason: 'Frontend/UI task - delegate to Gemini for prototype, then review',
        mcpTool: 'mcp__gemini__gemini'
      };
    default:
      return {
        target: 'direct',
        persona,
        reason: 'Shared persona - Claude executes directly'
      };
  }
}

/**
 * Resolve both persona and worker type for a task
 *
 * @param task - The task to resolve routing for
 * @returns Object containing persona, workerType, and delegationHint
 */
export function resolveTaskRouting(task: Pick<Task, 'id' | 'persona' | 'scope'>): {
  persona: string | null;
  workerType: WorkerType;
  delegationHint: DelegationHint;
} {
  const persona = resolvePersona(task);
  const workerType = resolveWorkerType(persona);
  const delegationHint = getDelegationHint(task);
  return { persona, workerType, delegationHint };
}
