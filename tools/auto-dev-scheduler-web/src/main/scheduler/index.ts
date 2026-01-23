/**
 * Scheduler Module Exports
 *
 * Re-exports components for the scheduler subsystem.
 */

export { IssueTracker } from './issue-tracker';
export type { RawIssueReport, IssueTrackerCallbacks } from './issue-tracker';

export { SessionPersistence } from './session-persistence';
export type {
  SessionStateProvider,
  SessionHydrateCallbacks,
  SchedulerPauseReason,
  SchedulerSessionSnapshot,
  PersistedTaskState
} from './session-persistence';

export { SchedulerContext } from './scheduler-context';
export type {
  WorkerKind,
  WorkerWrapper,
  CompletedWorkerLog,
  TaskStatusChangedEvent,
  WorkerSpawnedEvent,
  WorkerCompletedEvent,
  WorkerErrorEvent,
  IssueAddedEvent,
  ApiErrorEvent
} from './scheduler-context';

export { ResilienceManager, API_ERROR_CONFIG } from './resilience-manager';
export type { ResilienceCallbacks, ApiErrorPausePayload } from './resilience-manager';

export { WorkerPool } from './worker-pool';
export type {
  WorkerPoolCallbacks,
  WorkerInstanceWrapper
  // Phase 4: DirectWorkerRequest and DirectWorkerEvent removed
} from './worker-pool';

export { TaskManager } from './task-manager';
export type { TaskManagerCallbacks } from './task-manager';

export { runTscCheck, convertToIssues, diffErrors } from './compile-checker';
export type { CompileError, CompileCheckResult, CompileIssue } from './compile-checker';
