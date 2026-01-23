/**
 * File Writer with Queue
 *
 * Ensures sequential file writes to prevent race conditions
 * when multiple workers complete tasks simultaneously.
 */

import { promises as fs } from 'node:fs';

// Safe logging to prevent EPIPE errors in GUI mode (no console)
function safeLog(level: 'log' | 'warn', ...args: unknown[]): void {
  try {
    console[level](...args);
  } catch {
    // Ignore EPIPE and other console errors in GUI mode
  }
}

type WriteTask = {
  filePath: string;
  operation: () => Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
};

class FileWriteQueue {
  private queues = new Map<string, WriteTask[]>();
  private processing = new Set<string>();

  /**
   * Normalize file path for use as Map key.
   * On Windows, paths are case-insensitive, so normalize to lowercase.
   */
  private normalizeKey(filePath: string): string {
    return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
  }

  /**
   * Queue a write operation for a specific file.
   * Operations on the same file are serialized.
   */
  async enqueue(filePath: string, operation: () => Promise<void>): Promise<void> {
    const key = this.normalizeKey(filePath);
    return new Promise((resolve, reject) => {
      const task: WriteTask = { filePath, operation, resolve, reject };

      if (!this.queues.has(key)) {
        this.queues.set(key, []);
      }
      this.queues.get(key)!.push(task);

      this.processQueue(key);
    });
  }

  private async processQueue(key: string): Promise<void> {
    if (this.processing.has(key)) return;

    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) return;

    this.processing.add(key);

    while (queue.length > 0) {
      const task = queue.shift()!;
      try {
        await task.operation();
        task.resolve();
      } catch (err) {
        task.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    this.processing.delete(key);
  }
}

const fileWriteQueue = new FileWriteQueue();

/**
 * Update a task's checkbox status in AUTO-DEV.md
 *
 * @param filePath Path to AUTO-DEV.md
 * @param taskId Task ID (e.g., "TASK-01", "REVIEW-SYNC")
 * @param success true = [x], false = [ ] (reset)
 */
export async function updateTaskCheckbox(
  filePath: string,
  taskId: string,
  success: boolean
): Promise<void> {
  await fileWriteQueue.enqueue(filePath, async () => {
    const content = await fs.readFile(filePath, 'utf-8');

    // Step 1: Find the task header (### TASK-ID: Title or ### Task: TASK-ID ...)
    // Support various header formats and both : and Chinese colon
    const headerPattern = new RegExp(
      `^###\\s+(?:Task[：:\\s]+)?${escapeRegex(taskId)}(?=[：:\\s]|$)[^\\r\\n]*$`,
      'im'
    );

    const headerMatch = headerPattern.exec(content);
    if (!headerMatch || headerMatch.index === undefined) {
      safeLog('warn', `[FileWriter] Task ${taskId} header not found in ${filePath}`);
      return;
    }

    const blockStart = headerMatch.index;

    // Step 2: Find the next task header to determine block boundary
    // Task IDs follow pattern: letters/numbers with separators (-, ., _)
    const nextHeaderPattern = /^###\s+(?:Task[：:\s]+)?[A-Za-z][A-Za-z0-9]*[-._][A-Za-z0-9-._]*(?=[：:\s]|$)/gim;
    nextHeaderPattern.lastIndex = blockStart + headerMatch[0].length;
    const nextHeaderMatch = nextHeaderPattern.exec(content);
    const blockEnd = nextHeaderMatch?.index ?? content.length;

    // Step 3: Extract the task block
    const block = content.slice(blockStart, blockEnd);

    // Step 4: Find the first checkbox in the block
    // Match: - [ ], - [x], - [X], * [ ], + [ ], with possible leading whitespace
    const checkboxPattern = /^(\s*[-*+]\s*\[)([ xX~!])(\])/m;
    const checkboxMatch = checkboxPattern.exec(block);

    if (!checkboxMatch) {
      safeLog('warn', `[FileWriter] Task ${taskId} checkbox not found in ${filePath}`);
      return;
    }

    const newMark = success ? 'x' : ' ';
    const currentMark = (checkboxMatch[2] ?? '').toLowerCase();

    // Skip if already in desired state
    if ((success && currentMark === 'x') || (!success && currentMark === ' ')) {
      return;
    }

    // Step 5: Replace the checkbox in the block
    const updatedBlock = block.replace(checkboxPattern, `$1${newMark}$3`);

    // Step 6: Reconstruct the full content
    const updated = content.slice(0, blockStart) + updatedBlock + content.slice(blockEnd);

    await fs.writeFile(filePath, updated, 'utf-8');
    safeLog('log', `[FileWriter] Updated ${taskId} checkbox to [${newMark}]`);
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { fileWriteQueue };
