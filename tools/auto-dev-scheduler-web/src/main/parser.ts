import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { TASK_ID_PATTERN } from '../shared/task-id';
import type { Task, TaskKind, TaskScope, TaskStatus } from '../shared/types';

export interface ParseResult {
  tasks: Map<string, Task>;
  waveMap: Map<string, number>;
}

// ============================================================================
// Fenced Code Block Masking
// ============================================================================

type FenceChar = '`' | '~';

/**
 * Mask fenced code blocks (``` or ~~~) by replacing content with spaces.
 * Preserves string length and line structure so regex match indices remain valid.
 * This prevents false positives from parsing task-like patterns inside code examples.
 */
function maskFencedCodeBlocks(markdown: string): string {
  const lines = markdown.match(/[^\n]*\n|[^\n]+$/g);
  if (!lines) return markdown;

  let inFence = false;
  let fenceChar: FenceChar | null = null;
  let fenceLen = 0;

  const out: string[] = [];

  for (const line of lines) {
    const eolMatch = line.match(/\r?\n$/);
    const eol = eolMatch ? eolMatch[0] : '';
    const body = eol ? line.slice(0, -eol.length) : line;

    if (!inFence) {
      // CommonMark: up to 3 leading spaces allowed before fence
      const open = body.match(/^[ \t]{0,3}([`~]{3,})(.*)$/);
      if (open) {
        const seq = open[1];
        const ch = seq[0] as FenceChar;
        const isUniform = seq.split('').every((c) => c === ch);
        if (isUniform && (ch === '`' || ch === '~')) {
          inFence = true;
          fenceChar = ch;
          fenceLen = seq.length;
        }
      }
      out.push(line);
      continue;
    }

    // Inside fence - check for closing
    const closeRe = new RegExp('^[ \\t]{0,3}' + fenceChar + '{' + fenceLen + ',}[ \\t]*$');
    if (fenceChar && closeRe.test(body)) {
      inFence = false;
      fenceChar = null;
      fenceLen = 0;
      out.push(line);
      continue;
    }

    // Mask content: replace with spaces, keep EOL
    out.push(' '.repeat(body.length) + eol);
  }

  return out.join('');
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

export function inferProjectRoot(filePath: string): string {
  // AUTO-DEV.md is at openspec/execution/{project}/AUTO-DEV.md
  // Go up 3 levels to reach project root
  return path.resolve(path.dirname(filePath), '..', '..', '..');
}

function parseWaveMap(content: string): Map<string, number> {
  const waveMap = new Map<string, number>();

  // Pattern 1: "Wave X: [TASKID] [TASKID]" inline format
  const inlineWavePattern = /^Wave\s+(\d+)\s*[：:]\s*(.*)$/gim;
  for (const match of content.matchAll(inlineWavePattern)) {
    const waveNum = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isFinite(waveNum)) continue;
    const waveLine = match[2] ?? '';
    // Unified Task ID pattern (supports W1-T2, GMT-E-01, BE.API.01, task_001)
    const taskIdRegex = new RegExp(`\\[?(${TASK_ID_PATTERN})\\]?`, 'gi');
    for (const tid of waveLine.matchAll(taskIdRegex)) {
      const taskId = tid[1]?.toUpperCase();
      if (taskId) waveMap.set(taskId, waveNum);
    }
  }

  // Pattern 2: "## Wave X: ..." section headers - scan tasks until next wave
  // Fix: Use [\s\S]*? instead of [^#]*? to properly match across lines including ### task headers
  const sectionWavePattern = /^##\s+Wave\s+(\d+)\b[\s\S]*?(?=^##\s+Wave\s+\d+|$)/gim;
  for (const match of content.matchAll(sectionWavePattern)) {
    const waveNum = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isFinite(waveNum)) continue;
    const section = match[0] ?? '';
    // Unified Task ID pattern - match "### Task: ID" or "### ID:" formats
    const taskIdRegex = new RegExp(`###\\s+(?:Task[：:\\s]+)?(${TASK_ID_PATTERN})(?=[：:\\s])`, 'gi');
    for (const tid of section.matchAll(taskIdRegex)) {
      const taskId = tid[1]?.toUpperCase();
      if (taskId && !waveMap.has(taskId)) waveMap.set(taskId, waveNum);
    }
  }

  return waveMap;
}

function extractField(block: string, fieldName: '状态' | '依赖'): string | undefined {
  // Pattern 1: **字段**：值 or **字段**: 值
  const re1 = new RegExp(`\\*\\*${fieldName}\\*\\*\\s*[：:]\\s*([^\\r\\n]*)`, 'm');
  const m1 = re1.exec(block);
  if (m1?.[1]?.trim()) return m1[1].trim();

  // Pattern 2: - **字段**：值 (with list marker)
  const re2 = new RegExp(`^\\s*[-*]\\s*\\*\\*${fieldName}\\*\\*\\s*[：:]\\s*([^\\r\\n]*)`, 'm');
  const m2 = re2.exec(block);
  if (m2?.[1]?.trim()) return m2[1].trim();

  // Pattern 3: 字段：值 or 字段: 值 (without bold)
  const re3 = new RegExp(`^\\s*${fieldName}\\s*[：:]\\s*([^\\r\\n]*)`, 'm');
  const m3 = re3.exec(block);
  if (m3?.[1]?.trim()) return m3[1].trim();

  return undefined;
}

/**
 * Generic metadata field extractor for **Key**: value or **Key**：value patterns
 * Used for Persona, Scope, 输出, and other metadata fields
 */
export function extractMetadataField(block: string, fieldName: string): string | undefined {
  const re = new RegExp(`\\*\\*${fieldName}\\*\\*\\s*[：:]\\s*([^\\r\\n]*)`, 'im');
  const m = re.exec(block);
  return m?.[1]?.trim() || undefined;
}

/**
 * Derive TaskKind from TaskId prefix
 */
export function deriveTaskKind(taskId: string): TaskKind {
  const upper = taskId.toUpperCase();
  if (upper.startsWith('PROTO-')) return 'prototype';
  if (upper.startsWith('AUDIT-')) return 'audit';
  if (upper.startsWith('FE-')) return 'frontend';
  if (upper.startsWith('BE-')) return 'backend';
  if (upper.startsWith('INT-')) return 'integration';
  if (upper.startsWith('REVIEW-')) return 'review';
  return 'general';
}

/**
 * Parse Scope field value to TaskScope type
 */
function parseScope(raw: string | undefined): TaskScope | undefined {
  if (!raw) return undefined;
  const upper = raw.toUpperCase().trim();
  if (upper === 'FE' || upper === 'FRONTEND') return 'FE';
  if (upper === 'BE' || upper === 'BACKEND') return 'BE';
  if (upper === 'FULL' || upper === 'FULLSTACK') return 'FULL';
  return undefined;
}

function mapStatus(raw: string | undefined): TaskStatus {
  if (!raw) return 'pending';
  const s = raw.toLowerCase();
  // Success patterns
  if (s.includes('已完成') || s.includes('完成') || s.includes('[x]') || s.includes('success') || s.includes('done')) {
    return 'success';
  }
  // Running patterns
  if (s.includes('执行中') || s.includes('进行中') || s.includes('[~]') || s.includes('running') || s.includes('in progress')) {
    return 'running';
  }
  // Ready patterns
  if (s.includes('空闲') || s.includes('待开始') || s.includes('未认领') || s.includes('ready') || s.includes('[ ]')) {
    return 'ready';
  }
  // Failed patterns - map to 'failed' status, not 'pending'
  if (s.includes('失败') || s.includes('failed')) {
    return 'failed';
  }
  // Blocked patterns
  if (s.includes('阻塞') || s.includes('[!]') || s.includes('blocked')) {
    return 'pending';
  }
  return 'pending';
}

function parseDependencies(raw: string | undefined): string[] {
  if (!raw) return [];

  const trimmed = raw.trim();
  if (!trimmed || trimmed === '无') return [];

  // Remove parenthetical notes
  const withoutNotes = trimmed.replace(/[（(][^）)]*[）)]/g, '');
  // Unified Task ID pattern (case-insensitive)
  const matches = withoutNotes.matchAll(new RegExp(TASK_ID_PATTERN, 'gi'));

  const deps: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    // Normalize to uppercase for consistent matching
    const id = m[0]?.toUpperCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deps.push(id);
  }

  return deps;
}

function parseEstimatedTokens(block: string): number | undefined {
  // Match patterns like "~15k tokens", "15000 tokens", "~1.5k tokens"
  const re = /\*\*预估上下文\*\*\s*[：:]\s*~?([\d.]+)(k)?\s*tokens?/i;
  const m = re.exec(block);
  if (!m?.[1]) return undefined;
  const num = Number.parseFloat(m[1]);
  if (!Number.isFinite(num)) return undefined;
  // Only multiply by 1000 if 'k' suffix is present
  const hasKSuffix = !!m[2];
  return hasKSuffix ? Math.round(num * 1000) : Math.round(num);
}

function parseTasks(content: string, waveMap: Map<string, number>): Map<string, Task> {
  const tasks = new Map<string, Task>();
  // Flexible task header patterns:
  // - ### Task: GMT-E-01 标题
  // - ### Task GMT-E-01: 标题
  // - ### GMT-E-01: 标题
  // - ### W1-T2: 标题
  // - ### BE.API.01: 标题
  // Unified Task ID pattern (case-insensitive)
  const taskHeaderPattern = new RegExp(`^###\\s+(?:Task[：:\\s]+)?(${TASK_ID_PATTERN})[：:\\s]+(.+)$`, 'gim');
  const headers = [...content.matchAll(taskHeaderPattern)];

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const startIdx = header.index;
    // Normalize task ID to uppercase for consistent matching
    const taskId = header[1]?.trim().toUpperCase();
    const title = header[2]?.trim();

    if (startIdx === undefined || !taskId || !title) continue;

    const endIdx =
      i < headers.length - 1 && headers[i + 1].index !== undefined
        ? headers[i + 1].index
        : content.length;
    if (endIdx <= startIdx) continue;

    const block = content.slice(startIdx, endIdx);
    let statusRaw = extractField(block, '状态');

    // Fallback: extract status from checkbox patterns like "- [ ]", "- [x]", "- [~]"
    // Also support indented lists, '+' markers, and uppercase X
    if (!statusRaw) {
      const checkboxMatch = block.match(/^\s*[-*+]\s*\[([ xX~!])\]/m);
      if (checkboxMatch) {
        const mark = (checkboxMatch[1] ?? ' ').toLowerCase();
        if (mark === 'x') statusRaw = '已完成';
        else if (mark === '~') statusRaw = '执行中';
        else if (mark === '!') statusRaw = '阻塞';
        else statusRaw = '未认领';
      }
    }

    const depsRaw = extractField(block, '依赖');

    // Phase 2: Parse new metadata fields
    const personaRaw = extractMetadataField(block, 'Persona');
    const scopeRaw = extractMetadataField(block, 'Scope');
    const outputRaw = extractMetadataField(block, '输出');

    // Build optional metadata map for extra fields
    const metadata: Record<string, string> = {};
    if (outputRaw) metadata['输出'] = outputRaw;

    tasks.set(taskId, {
      id: taskId,
      title,
      status: mapStatus(statusRaw),
      wave: waveMap.get(taskId) ?? 99,
      dependencies: parseDependencies(depsRaw),
      estimatedTokens: parseEstimatedTokens(block),
      // Phase 2 fields
      persona: personaRaw,
      scope: parseScope(scopeRaw),
      taskKind: deriveTaskKind(taskId),
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined
    });
  }

  return tasks;
}

export async function parseAutoDevFile(filePath: string): Promise<ParseResult> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return { tasks: new Map<string, Task>(), waveMap: new Map<string, number>() };
    }
    throw err;
  }

  // Remove BOM if present
  const normalized = content.replace(/^\uFEFF/, '');
  // Mask fenced code blocks to avoid parsing example/template content as tasks
  // This preserves string length so match indices remain valid for slicing original content
  const masked = maskFencedCodeBlocks(normalized);
  const waveMap = parseWaveMap(masked);
  const tasks = parseTasks(masked, waveMap);
  return { tasks, waveMap };
}

/**
 * Extract the full content block for a specific task from AUTO-DEV.md
 * Used for Codex/Gemini workers that need task description
 *
 * @param filePath - Path to AUTO-DEV.md
 * @param taskId - Task ID to extract
 * @returns Full task content block or null if not found
 */
export async function extractTaskContent(filePath: string, taskId: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  const normalized = content.replace(/^\uFEFF/, '');
  const upperTaskId = taskId.toUpperCase();

  // Mask fenced code blocks to avoid matching "### ..." examples/templates as real tasks
  // maskFencedCodeBlocks preserves string length, so match indices remain valid for slicing `normalized`
  const masked = maskFencedCodeBlocks(normalized);

  // Find task header
  const taskHeaderPattern = new RegExp(
    `^###\\s+(?:Task[：:\\s]+)?(${TASK_ID_PATTERN})[：:\\s]+(.+)$`,
    'gim'
  );
  const headers = [...masked.matchAll(taskHeaderPattern)];

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const headerId = header[1]?.trim().toUpperCase();

    if (headerId !== upperTaskId) continue;

    const startIdx = header.index;
    if (startIdx === undefined) continue;

    // Find end of this task block (next ### or end of file)
    const endIdx =
      i < headers.length - 1 && headers[i + 1].index !== undefined
        ? headers[i + 1].index
        : normalized.length;

    return normalized.slice(startIdx, endIdx).trim();
  }

  return null;
}
