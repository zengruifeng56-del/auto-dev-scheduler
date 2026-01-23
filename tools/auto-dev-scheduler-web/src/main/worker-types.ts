/**
 * Worker Types - Unified interfaces for multi-model worker support
 *
 * Design decisions (from Phase 3 design.md):
 * - Composition over inheritance (don't inherit ClaudeWorker)
 * - Standardized output contract (framed JSON events)
 * - Worker capabilities declaration
 * - Event-based streaming interface
 */

import type { EventEmitter } from 'node:events';

import type {
  ArtifactDraft,
  ArtifactRef,
  LogEntry,
  WorkerCapabilities,
  WorkerRunPhase,
  WorkerRunRequest,
  WorkerRunResult,
  WorkerType
} from '../shared/types';

// ============================================================================
// Worker Events
// ============================================================================

export type WorkerEvent =
  | { type: 'stdout'; text: string; at: number }
  | { type: 'stderr'; text: string; at: number }
  | { type: 'log'; entry: LogEntry; at: number }
  | { type: 'artifact'; draft: ArtifactDraft; at: number }
  | { type: 'status'; phase: WorkerRunPhase; at: number }
  | { type: 'final'; at: number; result: WorkerRunResult };

// ============================================================================
// IWorker Interface
// ============================================================================

export interface IWorker extends EventEmitter {
  readonly id: string;
  readonly capabilities: WorkerCapabilities;

  /**
   * Start a task execution
   * Returns an async iterable of events (for streaming)
   */
  run(req: WorkerRunRequest): AsyncIterable<WorkerEvent>;

  /**
   * Cancel a running task
   */
  cancel(runId: string): Promise<void>;

  /**
   * Clean up worker resources
   */
  dispose(): Promise<void>;
}

// ============================================================================
// Worker Factory Interface
// ============================================================================

export interface WorkerConfig {
  type: WorkerType;
  projectRoot: string;
  workerId?: number;
  model?: string;
  timeout?: number;
}

export interface IWorkerFactory {
  create(cfg: WorkerConfig): IWorker;
  resolveType(persona: string | null): WorkerType;
}

// ============================================================================
// Helper Functions
// ============================================================================

// Note: resolveWorkerType is defined in routing-registry.ts as the single source of truth

/**
 * Get default capabilities for a worker type
 */
export function getDefaultCapabilities(type: WorkerType): WorkerCapabilities {
  switch (type) {
    case 'codex-cli':
      return {
        type: 'codex-cli',
        maxConcurrentRuns: 1,
        supportsStreaming: true,
        supportsArtifacts: true
      };
    case 'gemini-cli':
      return {
        type: 'gemini-cli',
        maxConcurrentRuns: 1,
        supportsStreaming: true,
        supportsArtifacts: true
      };
    case 'claude-cli':
    default:
      return {
        type: 'claude-cli',
        maxConcurrentRuns: 1,
        supportsStreaming: true,
        supportsArtifacts: true
      };
  }
}
