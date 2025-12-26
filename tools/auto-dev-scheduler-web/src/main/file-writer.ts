/**
 * File Writer with Queue
 *
 * Ensures sequential file writes to prevent race conditions
 * when multiple workers complete tasks simultaneously.
 */

import { promises as fs } from 'node:fs';

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
   * Queue a write operation for a specific file.
   * Operations on the same file are serialized.
   */
  async enqueue(filePath: string, operation: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const task: WriteTask = { filePath, operation, resolve, reject };

      if (!this.queues.has(filePath)) {
        this.queues.set(filePath, []);
      }
      this.queues.get(filePath)!.push(task);

      this.processQueue(filePath);
    });
  }

  private async processQueue(filePath: string): Promise<void> {
    if (this.processing.has(filePath)) return;

    const queue = this.queues.get(filePath);
    if (!queue || queue.length === 0) return;

    this.processing.add(filePath);

    while (queue.length > 0) {
      const task = queue.shift()!;
      try {
        await task.operation();
        task.resolve();
      } catch (err) {
        task.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    this.processing.delete(filePath);
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

    // Pattern: ### TASK-ID: Title\n\n- [ ] or - [x]
    // Match the task header and its checkbox on the next non-empty line
    const taskHeaderPattern = new RegExp(
      `(###\\s+${escapeRegex(taskId)}[^\\n]*\\n\\n?)([-*+]\\s*\\[)([xX\\s])(\\])`,
      'm'
    );

    const match = content.match(taskHeaderPattern);
    if (!match) {
      console.warn(`[FileWriter] Task ${taskId} checkbox not found in ${filePath}`);
      return;
    }

    const newMark = success ? 'x' : ' ';
    const currentMark = match[3].toLowerCase();

    // Skip if already in desired state
    if ((success && currentMark === 'x') || (!success && currentMark === ' ')) {
      return;
    }

    const updated = content.replace(
      taskHeaderPattern,
      `$1$2${newMark}$4`
    );

    await fs.writeFile(filePath, updated, 'utf-8');
    console.log(`[FileWriter] Updated ${taskId} checkbox to [${newMark}]`);
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { fileWriteQueue };
