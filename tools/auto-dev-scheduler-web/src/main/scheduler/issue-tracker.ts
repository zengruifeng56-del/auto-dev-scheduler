/**
 * Issue Tracker
 *
 * Manages issue deduplication, severity tracking, and formatting.
 * Extracted from scheduler-service.ts for modularity.
 */

import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Issue, IssueSeverity, IssueStatus } from '../../shared/types';
import type { SchedulerContext } from './scheduler-context';

// ============================================================================
// Types
// ============================================================================

/**
 * Raw issue report from workers (before deduplication)
 */
export interface RawIssueReport {
  title: string;
  severity: IssueSeverity;
  files: string[];
  signature?: string;
  details?: string;
  ownerTaskId?: string | null;
}

/**
 * Callbacks for IssueTracker to notify parent
 */
export interface IssueTrackerCallbacks {
  onIssueReported: (issue: Issue) => void;
  onIssueUpdated: (issueId: string, status: IssueStatus) => void;
  requestPersist: (reason: string) => void;
  onBlockerDetected: () => void;
}

// ============================================================================
// IssueTracker Class
// ============================================================================

export class IssueTracker {
  private readonly ctx: SchedulerContext;
  private readonly callbacks: IssueTrackerCallbacks;

  constructor(ctx: SchedulerContext, callbacks: IssueTrackerCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Add or merge an issue report.
   * Uses deduplication based on signature or title+files.
   */
  addIssue(raw: RawIssueReport, reporterTaskId: string, reporterWorkerId: number): Issue {
    const dedupKey = this.computeDedupKey(raw);
    const existing = this.ctx.issues.get(dedupKey);

    if (existing) {
      return this.mergeIssue(existing, raw);
    }

    return this.createIssue(dedupKey, raw, reporterTaskId, reporterWorkerId);
  }

  /**
   * Update issue status (open/fixed/ignored)
   */
  updateStatus(issueId: string, status: IssueStatus): boolean {
    const issue = this.ctx.issues.get(issueId);
    if (!issue) return false;

    issue.status = status;
    this.callbacks.onIssueUpdated(issueId, status);
    this.callbacks.requestPersist('issueUpdate');
    return true;
  }

  /**
   * Get all issues sorted by severity then createdAt
   */
  getAll(): Issue[] {
    return [...this.ctx.issues.values()].sort((a, b) => {
      const severityOrder = { blocker: 0, error: 1, warning: 2 };
      const aSev = severityOrder[a.severity] ?? 3;
      const bSev = severityOrder[b.severity] ?? 3;
      if (aSev !== bSev) return aSev - bSev;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  /**
   * Get open issues only
   */
  getOpen(): Issue[] {
    return [...this.ctx.issues.values()].filter(i => i.status === 'open');
  }

  /**
   * Get open blockers only
   */
  getOpenBlockers(): Issue[] {
    return this.getOpen().filter(i => i.severity === 'blocker');
  }

  /**
   * Clear all issues (used when loading new file)
   */
  clear(): void {
    this.ctx.issues.clear();
  }

  /**
   * Restore issues from session snapshot
   */
  restore(issues: Issue[]): void {
    this.ctx.issues.clear();
    for (const issue of issues) {
      if (issue && typeof issue.id === 'string') {
        this.ctx.issues.set(issue.id, issue);
      }
    }
  }

  /**
   * Get raw issues map for snapshot
   */
  getIssuesForSnapshot(): Issue[] {
    return [...this.ctx.issues.values()];
  }

  // --------------------------------------------------------------------------
  // Formatting Helpers
  // --------------------------------------------------------------------------

  /**
   * Check if a task is an integration task (receives issue injection)
   */
  isIntegrationTask(taskId: string): boolean {
    const id = taskId.toUpperCase();
    return (
      id.startsWith('INT-') ||
      id.startsWith('INTEGRATION') ||
      id.startsWith('FIX-WAVE') ||
      id === 'INTEGRATION'
    );
  }

  /**
   * Format issues for injection into integration task prompt
   */
  formatForInjection(issues: Issue[]): string {
    const lines: string[] = [
      '---',
      '## 📋 Collected Issues Report (Auto-injected)',
      '',
      `Total: ${issues.length} open issue(s) to address.`,
      ''
    ];

    const blockers = issues.filter(i => i.severity === 'blocker');
    const errors = issues.filter(i => i.severity === 'error');
    const warnings = issues.filter(i => i.severity === 'warning');

    if (blockers.length > 0) {
      lines.push('### 🚨 Blockers (Must Fix)');
      for (const issue of blockers) {
        lines.push(this.formatSingle(issue));
      }
      lines.push('');
    }

    if (errors.length > 0) {
      lines.push('### ❌ Errors');
      for (const issue of errors) {
        lines.push(this.formatSingle(issue));
      }
      lines.push('');
    }

    if (warnings.length > 0) {
      lines.push('### ⚠️ Warnings');
      for (const issue of warnings) {
        lines.push(this.formatSingle(issue));
      }
      lines.push('');
    }

    lines.push('---');
    return lines.join('\n');
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private computeDedupKey(raw: RawIssueReport): string {
    if (raw.signature) {
      return createHash('sha1')
        .update(JSON.stringify(['sig', raw.signature.trim()]))
        .digest('hex')
        .slice(0, 12);
    }

    const normalizedFiles = Array.from(
      new Set(raw.files.map(f => f.trim()).filter(f => f.length > 0))
    ).sort();

    return createHash('sha1')
      .update(JSON.stringify(['titleFiles', raw.title.trim(), normalizedFiles]))
      .digest('hex')
      .slice(0, 12);
  }

  private mergeIssue(existing: Issue, raw: RawIssueReport): Issue {
    existing.occurrences++;
    const prevSeverity = existing.severity;

    // Keep highest severity
    const severityOrder = { warning: 0, error: 1, blocker: 2 };
    if (severityOrder[raw.severity] > severityOrder[existing.severity]) {
      existing.severity = raw.severity;
    }

    // Re-open if previously fixed
    if (existing.status === 'fixed') {
      existing.status = 'open';
    }

    // Merge missing optional fields
    if (!existing.ownerTaskId && raw.ownerTaskId) {
      existing.ownerTaskId = raw.ownerTaskId || undefined;
    }
    if (!existing.signature && raw.signature) {
      existing.signature = raw.signature;
    }
    if (!existing.details && raw.details) {
      existing.details = raw.details;
    }

    // Union file lists
    const fileSet = new Set(existing.files.map(f => f.trim()).filter(f => f.length > 0));
    for (const f of raw.files) {
      const trimmed = f.trim();
      if (trimmed) fileSet.add(trimmed);
    }
    existing.files = [...fileSet];

    this.callbacks.onIssueReported(existing);
    this.callbacks.requestPersist('issueMerged');

    // Check for blocker upgrade
    if (prevSeverity !== 'blocker' && existing.severity === 'blocker') {
      this.callbacks.onBlockerDetected();
    }

    return existing;
  }

  private createIssue(
    dedupKey: string,
    raw: RawIssueReport,
    reporterTaskId: string,
    reporterWorkerId: number
  ): Issue {
    const normalizedFiles = Array.from(
      new Set(raw.files.map(f => f.trim()).filter(f => f.length > 0))
    );

    const issue: Issue = {
      id: dedupKey,
      createdAt: new Date().toISOString(),
      reporterTaskId,
      reporterWorkerId,
      ownerTaskId: raw.ownerTaskId || undefined,
      severity: raw.severity,
      title: raw.title.trim(),
      details: raw.details?.trim() || undefined,
      files: normalizedFiles,
      signature: raw.signature?.trim() || undefined,
      status: 'open',
      occurrences: 1
    };

    this.ctx.issues.set(dedupKey, issue);
    this.callbacks.onIssueReported(issue);
    this.callbacks.requestPersist('issueReported');

    // Check for blocker auto-pause
    if (issue.severity === 'blocker') {
      this.callbacks.onBlockerDetected();
    }

    return issue;
  }

  private formatSingle(issue: Issue): string {
    const files = issue.files.length > 0 ? ` (${issue.files.join(', ')})` : '';
    const owner = issue.ownerTaskId ? ` [Owner: ${issue.ownerTaskId}]` : '';
    const details = issue.details ? `\n  Details: ${issue.details}` : '';
    return `- **${issue.title}**${files}${owner}${details}`;
  }

  // --------------------------------------------------------------------------
  // File Output
  // --------------------------------------------------------------------------

  /**
   * Write all issues to a centralized markdown file.
   * Creates the directory if it doesn't exist.
   */
  async writeToFile(outputPath: string): Promise<void> {
    const issues = this.getAll();
    const content = this.formatFullReport(issues);

    // Ensure directory exists
    const dir = path.dirname(outputPath);
    await mkdir(dir, { recursive: true });

    await writeFile(outputPath, content, 'utf-8');
  }

  /**
   * Format a full report of all issues for file output
   */
  private formatFullReport(issues: Issue[]): string {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const lines: string[] = [
      '# Auto-Dev Issues Report',
      '',
      `Generated: ${now}`,
      '',
      '---',
      '',
      `## Summary`,
      '',
      `- **Total Issues**: ${issues.length}`,
      `- **Open**: ${issues.filter(i => i.status === 'open').length}`,
      `- **Fixed**: ${issues.filter(i => i.status === 'fixed').length}`,
      `- **Ignored**: ${issues.filter(i => i.status === 'ignored').length}`,
      ''
    ];

    const blockers = issues.filter(i => i.severity === 'blocker' && i.status === 'open');
    const errors = issues.filter(i => i.severity === 'error' && i.status === 'open');
    const warnings = issues.filter(i => i.severity === 'warning' && i.status === 'open');
    const resolved = issues.filter(i => i.status !== 'open');

    if (blockers.length > 0) {
      lines.push('## 🚨 Blockers (Must Fix)', '');
      for (const issue of blockers) {
        lines.push(this.formatDetailed(issue));
      }
      lines.push('');
    }

    if (errors.length > 0) {
      lines.push('## ❌ Errors', '');
      for (const issue of errors) {
        lines.push(this.formatDetailed(issue));
      }
      lines.push('');
    }

    if (warnings.length > 0) {
      lines.push('## ⚠️ Warnings', '');
      for (const issue of warnings) {
        lines.push(this.formatDetailed(issue));
      }
      lines.push('');
    }

    if (resolved.length > 0) {
      lines.push('## ✅ Resolved', '');
      for (const issue of resolved) {
        lines.push(this.formatDetailed(issue));
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Format a single issue with full details for file output
   */
  private formatDetailed(issue: Issue): string {
    const lines = [
      `### ${issue.title}`,
      '',
      `- **ID**: \`${issue.id}\``,
      `- **Severity**: ${issue.severity}`,
      `- **Status**: ${issue.status}`,
      `- **Reported by**: ${issue.reporterTaskId} (worker ${issue.reporterWorkerId})`,
      `- **Created**: ${issue.createdAt}`,
      `- **Occurrences**: ${issue.occurrences}`
    ];

    if (issue.ownerTaskId) {
      lines.push(`- **Owner Task**: ${issue.ownerTaskId}`);
    }

    if (issue.files.length > 0) {
      lines.push(`- **Files**: ${issue.files.join(', ')}`);
    }

    if (issue.signature) {
      lines.push(`- **Signature**: \`${issue.signature}\``);
    }

    if (issue.details) {
      lines.push('', '**Details**:', '', '```', issue.details, '```');
    }

    lines.push('');
    return lines.join('\n');
  }
}
