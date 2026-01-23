<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useSchedulerStore } from '../stores/scheduler'
import type { Issue, IssueStatus, IssueSeverity } from '@shared/types'

const store = useSchedulerStore()
const { issues } = storeToRefs(store)

// Toggle state for collapsed groups
const showFixed = ref(false)
const showIgnored = ref(false)

// Group issues by status
const openIssues = computed(() => issues.value.filter(i => i.status === 'open'))
const fixedIssues = computed(() => issues.value.filter(i => i.status === 'fixed'))
const ignoredIssues = computed(() => issues.value.filter(i => i.status === 'ignored'))

// Sort by severity
const sortedOpenIssues = computed(() => {
  const severityOrder: Record<IssueSeverity, number> = { blocker: 0, error: 1, warning: 2 }
  return [...openIssues.value].sort((a, b) => {
    const aSev = severityOrder[a.severity] ?? 3
    const bSev = severityOrder[b.severity] ?? 3
    return aSev - bSev
  })
})

function getSeverityIcon(severity: IssueSeverity): string {
  switch (severity) {
    case 'blocker': return '🚨'
    case 'error': return '❌'
    case 'warning': return '⚠️'
  }
}

function getSeverityClass(severity: IssueSeverity): string {
  return `severity-${severity}`
}

async function updateStatus(issueId: string, status: IssueStatus) {
  await store.updateIssueStatus(issueId, status)
}

async function clearAllIssues() {
  if (issues.value.length === 0) return
  await store.clearAllIssues()
}

function formatFiles(files: string[]): string {
  if (files.length === 0) return '-'
  if (files.length === 1) return files[0]
  return `${files[0]} (+${files.length - 1})`
}

function exportIssues() {
  const lines: string[] = ['# Issues Report', '']
  lines.push(`Generated at: ${new Date().toLocaleString()}`, '')

  const formatIssue = (i: Issue) => {
    lines.push(`### [${i.severity.toUpperCase()}] ${i.title}`)
    lines.push(`- **ID**: ${i.id}`)
    lines.push(`- **Files**: ${i.files.join(', ') || 'None'}`)
    if (i.ownerTaskId) lines.push(`- **Owner Task**: ${i.ownerTaskId}`)
    if (i.details) {
      lines.push(`- **Details**:`)
      lines.push('```')
      lines.push(i.details)
      lines.push('```')
    }
    lines.push('')
  }

  if (openIssues.value.length > 0) {
    lines.push('## Open Issues', '')
    openIssues.value.forEach(formatIssue)
  }

  if (fixedIssues.value.length > 0) {
    lines.push('## Fixed Issues', '')
    fixedIssues.value.forEach(i => lines.push(`- [Fixed] ${i.title}`))
    lines.push('')
  }

  if (ignoredIssues.value.length > 0) {
    lines.push('## Ignored Issues', '')
    ignoredIssues.value.forEach(i => lines.push(`- [Ignored] ${i.title}`))
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `issues-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="issues-panel">
    <div class="panel-header">
      <div class="header-left-group">
        <span class="panel-title">问题列表</span>
        <span class="issue-count">
          {{ openIssues.length }} 待处理
          <span v-if="fixedIssues.length > 0" class="fixed-count">/ {{ fixedIssues.length }} 已修复</span>
        </span>
      </div>
      <div class="header-actions">
        <button
          class="header-btn header-clear-btn"
          @click="clearAllIssues"
          title="清除所有问题"
          :disabled="issues.length === 0"
        >
          🗑 清除
        </button>
        <button class="header-btn header-export-btn" @click="exportIssues" title="导出为 Markdown">
          ⬇ 导出
        </button>
      </div>
    </div>

    <div v-if="issues.length === 0" class="empty-state">
      暂无问题报告
    </div>

    <div v-else class="issues-list">
      <!-- Open Issues -->
      <div v-if="sortedOpenIssues.length > 0" class="issue-group">
        <div class="group-header">待处理</div>
        <div
          v-for="issue in sortedOpenIssues"
          :key="issue.id"
          class="issue-item"
          :class="getSeverityClass(issue.severity)"
        >
          <div class="issue-main">
            <span class="issue-icon">{{ getSeverityIcon(issue.severity) }}</span>
            <div class="issue-content">
              <div class="issue-title">{{ issue.title }}</div>
              <div class="issue-meta">
                <span class="issue-files" :title="issue.files.join(', ')">
                  {{ formatFiles(issue.files) }}
                </span>
                <span v-if="issue.ownerTaskId" class="issue-owner">
                  → {{ issue.ownerTaskId }}
                </span>
                <span v-if="issue.occurrences > 1" class="issue-occurrences">
                  ×{{ issue.occurrences }}
                </span>
              </div>
              <div v-if="issue.details" class="issue-details">
                {{ issue.details }}
              </div>
            </div>
          </div>
          <div class="issue-actions">
            <button class="action-btn fix-btn" @click="updateStatus(issue.id, 'fixed')" title="标记为已修复" aria-label="标记为已修复">
              ✓
            </button>
            <button class="action-btn ignore-btn" @click="updateStatus(issue.id, 'ignored')" title="忽略此问题" aria-label="忽略此问题">
              ✕
            </button>
          </div>
        </div>
      </div>

      <!-- Fixed Issues (collapsible) -->
      <div v-if="fixedIssues.length > 0" class="issue-group" :class="{ collapsed: !showFixed }">
        <div class="group-header clickable" @click="showFixed = !showFixed">
          <span class="toggle-icon">{{ showFixed ? '▼' : '▶' }}</span>
          已修复 ({{ fixedIssues.length }})
        </div>
        <div
          v-for="issue in fixedIssues"
          :key="issue.id"
          class="issue-item resolved"
        >
          <div class="issue-main">
            <span class="issue-icon">✓</span>
            <div class="issue-content">
              <div class="issue-title">{{ issue.title }}</div>
            </div>
          </div>
          <div class="issue-actions">
            <button class="action-btn reopen-btn" @click="updateStatus(issue.id, 'open')" title="重新打开" aria-label="重新打开此问题">
              ↺
            </button>
          </div>
        </div>
      </div>

      <!-- Ignored Issues (collapsible) -->
      <div v-if="ignoredIssues.length > 0" class="issue-group" :class="{ collapsed: !showIgnored }">
        <div class="group-header clickable" @click="showIgnored = !showIgnored">
          <span class="toggle-icon">{{ showIgnored ? '▼' : '▶' }}</span>
          已忽略 ({{ ignoredIssues.length }})
        </div>
        <div
          v-for="issue in ignoredIssues"
          :key="issue.id"
          class="issue-item resolved"
        >
          <div class="issue-main">
            <span class="issue-icon">—</span>
            <div class="issue-content">
              <div class="issue-title">{{ issue.title }}</div>
            </div>
          </div>
          <div class="issue-actions">
            <button class="action-btn reopen-btn" @click="updateStatus(issue.id, 'open')" title="重新打开" aria-label="重新打开此问题">
              ↺
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.issues-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: var(--vscode-panel-bg, #252526);
  color: var(--vscode-fore-text, #dcdcdc);
  font-size: 12px;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-border, #333);
  background-color: var(--vscode-bg, #2d2d30);
}

.panel-title {
  font-weight: 600;
  text-transform: uppercase;
  font-size: 11px;
  color: var(--vscode-fore-text-dim, #969696);
}

.header-left-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-actions {
  display: flex;
  gap: 6px;
}

.header-btn {
  background: transparent;
  border: 1px solid var(--vscode-border, #333);
  color: var(--vscode-fore-text, #dcdcdc);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 2px;
}

.header-btn:hover:not(:disabled) {
  background-color: rgba(255, 255, 255, 0.1);
}

.header-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.header-clear-btn:hover:not(:disabled) {
  border-color: var(--vscode-accent-red, #cd4646);
  color: var(--vscode-accent-red, #cd4646);
}

.issue-count {
  font-size: 11px;
  color: var(--vscode-accent-orange, #c88c32);
}

.fixed-count {
  color: var(--vscode-accent-green, #3c783c);
}

.empty-state {
  padding: 20px;
  text-align: center;
  color: var(--vscode-fore-text-dim, #969696);
}

.issues-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.issue-group {
  margin-bottom: 12px;
}

.group-header {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--vscode-fore-text-dim, #969696);
  padding: 4px 0;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.group-header.clickable {
  cursor: pointer;
  user-select: none;
}

.group-header.clickable:hover {
  color: var(--vscode-fore-text, #dcdcdc);
}

.toggle-icon {
  font-size: 8px;
  width: 10px;
}

.issue-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 8px;
  margin-bottom: 4px;
  background-color: var(--vscode-input-bg, #1e1e1e);
  border-radius: 4px;
  border-left: 3px solid transparent;
}

.issue-item.severity-blocker {
  border-left-color: var(--vscode-accent-red, #cd4646);
}

.issue-item.severity-error {
  border-left-color: var(--vscode-accent-orange, #c88c32);
}

.issue-item.severity-warning {
  border-left-color: var(--vscode-accent-yellow, #ddb700);
}

.issue-item.resolved {
  opacity: 0.6;
  border-left-color: var(--vscode-accent-green, #3c783c);
}

.issue-main {
  display: flex;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.issue-icon {
  flex-shrink: 0;
  font-size: 14px;
}

.issue-content {
  flex: 1;
  min-width: 0;
}

.issue-title {
  font-weight: 500;
  margin-bottom: 2px;
  word-break: break-word;
}

.issue-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 10px;
  color: var(--vscode-fore-text-dim, #969696);
}

.issue-files {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.issue-owner {
  color: var(--vscode-accent-blue, #007acc);
}

.issue-occurrences {
  color: var(--vscode-accent-orange, #c88c32);
}

.issue-details {
  margin-top: 4px;
  padding: 4px 6px;
  font-size: 10px;
  background-color: rgba(0, 0, 0, 0.2);
  border-radius: 2px;
  color: var(--vscode-fore-text-dim, #969696);
  white-space: pre-wrap;
  word-break: break-word;
}

.issue-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.action-btn {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background-color: transparent;
  color: var(--vscode-fore-text-dim, #969696);
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.action-btn:hover {
  background-color: rgba(255, 255, 255, 0.1);
}

.fix-btn:hover {
  color: var(--vscode-accent-green, #3c783c);
}

.ignore-btn:hover {
  color: var(--vscode-accent-red, #cd4646);
}

.reopen-btn:hover {
  color: var(--vscode-accent-blue, #007acc);
}

.issue-group.collapsed .issue-item {
  display: none;
}
</style>
