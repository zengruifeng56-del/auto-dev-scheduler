/**
 * Unified Task ID pattern for Auto-Dev Scheduler
 *
 * Supported formats:
 * - W1-T2 (Wave-Task format)
 * - GMT-E-01 (Project-Category-Number format)
 * - BE.API.01 (Dot-separated format)
 *
 * Pattern: word chars + at least one separator (- or .) + more word chars
 * Requires at least one separator to avoid matching single words like "Step", "x", "ID"
 * Rejects: `---`, `...`, trailing separators like `A-`, single words
 */
export const TASK_ID_PATTERN = '\\w+[.-]\\w+(?:[.-]\\w+)*';

/**
 * Create a RegExp for matching Task IDs
 * @param flags - RegExp flags (default: 'gi' for global case-insensitive)
 */
export function createTaskIdRegex(flags = 'gi'): RegExp {
  return new RegExp(TASK_ID_PATTERN, flags);
}

/**
 * Create a RegExp for matching Task IDs with capture group
 * @param flags - RegExp flags (default: 'gi' for global case-insensitive)
 */
export function createTaskIdCaptureRegex(flags = 'gi'): RegExp {
  return new RegExp(`(${TASK_ID_PATTERN})`, flags);
}
