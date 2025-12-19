import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { TASK_ID_PATTERN } from '../shared/task-id';
import type { Task, TaskStatus } from '../shared/types';

export interface ParseResult {
  tasks: Map<string, Task>;
  waveMap: Map<string, number>;
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
      const taskId = tid[1];
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
      const taskId = tid[1];
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
    const id = m[0];
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
    const taskId = header[1]?.trim();
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
    if (!statusRaw) {
      const checkboxMatch = block.match(/^[-*]\s*\[([ x~!])\]/m);
      if (checkboxMatch) {
        const mark = checkboxMatch[1];
        if (mark === 'x') statusRaw = '已完成';
        else if (mark === '~') statusRaw = '执行中';
        else if (mark === '!') statusRaw = '阻塞';
        else statusRaw = '未认领';
      }
    }

    const depsRaw = extractField(block, '依赖');

    tasks.set(taskId, {
      id: taskId,
      title,
      status: mapStatus(statusRaw),
      wave: waveMap.get(taskId) ?? 99,
      dependencies: parseDependencies(depsRaw),
      estimatedTokens: parseEstimatedTokens(block)
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
  const waveMap = parseWaveMap(normalized);
  const tasks = parseTasks(normalized, waveMap);
  return { tasks, waveMap };
}
