/**
 * Delivery Check
 * 交付检查：当 AUTO-DEV.md 全部任务完成后，检查对应 OpenSpec tasks.md 的 checklist 覆盖度
 */
import { readFile } from 'node:fs/promises';

import type { ChecklistItem, DeliveryReport, Task } from '../shared/types';

function stripBom(input: string): string {
  return input.replace(/^\uFEFF/, '');
}

function normalizeText(input: string): string {
  let text = input.toLowerCase();
  // Remove markdown links: [text](url) -> text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Remove inline code, bold, italic markers
  text = text.replace(/[`*_~]/g, '');
  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

/**
 * Extract change-id from AUTO-DEV.md OpenSpec reference
 * Format: > 源自 OpenSpec: [change-id](../../changes/change-id/)
 * Supports both English colon `:` and Chinese colon `：`
 */
export function parseOpenSpecLink(content: string): string | null {
  const normalized = stripBom(content);

  // Try to extract from href path first (support both : and ：)
  const linkRe = /(?:^|\n)\s*>?\s*(?:源自|来自)\s*OpenSpec\s*[:：]\s*\[[^\]]+\]\(([^)]+)\)/i;
  const m = linkRe.exec(normalized);
  const href = m?.[1]?.trim();

  if (href) {
    const hrefNormalized = href.replace(/\\/g, '/');
    const idFromHref = /(?:^|\/)changes\/([^/]+)(?:\/|$)/i.exec(hrefNormalized)?.[1]?.trim();
    if (idFromHref && isValidChangeId(idFromHref)) return idFromHref;
  }

  // Fallback: extract from link text
  const textRe = /(?:^|\n)\s*>?\s*(?:源自|来自)\s*OpenSpec\s*[:：]\s*\[([^\]]+)\]/i;
  const m2 = textRe.exec(normalized);
  const idFromText = m2?.[1]?.trim();
  return idFromText && isValidChangeId(idFromText) ? idFromText : null;
}

/**
 * Validate change-id to prevent path traversal attacks
 * Only allow lowercase letters, numbers, and hyphens
 */
export function isValidChangeId(changeId: string): boolean {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(changeId);
}

/**
 * Parse checklist items from tasks.md
 * Supports: - [ ] item, - [x] item, * [ ] item, + [ ] item
 */
export async function parseTasksChecklist(tasksPath: string): Promise<ChecklistItem[]> {
  const raw = await readFile(tasksPath, 'utf8');
  const content = stripBom(raw);
  const lines = content.split(/\r?\n/);

  const items: ChecklistItem[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Skip code blocks
    if (/^\s*```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Match checklist: - [ ] text or - [x] text
    const m = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    if (!m) continue;

    const checked = (m[1] ?? '').toLowerCase() === 'x';
    const text = (m[2] ?? '').trim();
    if (!text) continue;

    items.push({ checked, text, line: i + 1 });
  }

  return items;
}

/**
 * Extract task IDs from AUTO-DEV.md tasks
 */
function extractTaskIds(tasks: Task[]): Set<string> {
  const ids = new Set<string>();
  for (const t of tasks) {
    const id = t.id?.trim();
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Extract task IDs from text (e.g., "ADSW-E-01", "FE-AUTH-02")
 */
function extractIdsFromText(text: string): string[] {
  const matches = text.matchAll(/[A-Z]+-[A-Z0-9-]+/g);
  return [...matches].map(m => m[0]).filter(Boolean);
}

/**
 * Check if a checklist item is covered by AUTO-DEV tasks
 * Heuristic matching:
 * 1. If checklist text contains a task ID that exists in AUTO-DEV → covered
 * 2. If normalized text appears in task titles → covered
 * 3. If all significant tokens appear in corpus → covered
 */
function isItemCovered(item: ChecklistItem, taskIds: Set<string>, corpus: string): boolean {
  const rawText = item.text.trim();
  if (!rawText) return true; // Empty items are "covered"

  // Check if item references a known task ID
  const idsInItem = extractIdsFromText(rawText);
  if (idsInItem.some(id => taskIds.has(id))) {
    return true;
  }

  // Check normalized text match
  const normalized = normalizeText(rawText);
  if (normalized && corpus.includes(normalized)) {
    return true;
  }

  // Check token-based match (all significant tokens present)
  if (normalized) {
    const tokens = normalized.split(' ').filter(t => t.length >= 2);
    if (tokens.length >= 2 && tokens.every(t => corpus.includes(t))) {
      return true;
    }
  }

  return false;
}

/**
 * Generate delivery check report comparing AUTO-DEV tasks with tasks.md checklist
 */
export function generateDeliveryReport(
  autoDevTasks: Task[],
  autoDevContent: string,
  checklist: ChecklistItem[]
): DeliveryReport {
  const notes: string[] = [];

  if (checklist.length === 0) {
    notes.push('tasks.md 未发现任何 checklist 项（格式：- [ ] ... 或 - [x] ...）');
  }

  const taskIds = extractTaskIds(autoDevTasks);

  // Build corpus from task IDs, titles, and full AUTO-DEV content
  const corpusParts = [
    ...autoDevTasks.map(t => `${t.id} ${t.title}`),
    autoDevContent
  ];
  const corpus = normalizeText(corpusParts.join('\n'));

  const uncovered: ChecklistItem[] = [];
  let coveredCount = 0;

  for (const item of checklist) {
    if (isItemCovered(item, taskIds, corpus)) {
      coveredCount++;
    } else {
      uncovered.push(item);
    }
  }

  const status: DeliveryReport['status'] =
    checklist.length === 0 ? 'warning' : uncovered.length === 0 ? 'pass' : 'warning';

  return {
    status,
    total: checklist.length,
    covered: coveredCount,
    uncovered,
    generatedAt: new Date().toISOString(),
    notes: notes.length > 0 ? notes : undefined
  };
}
