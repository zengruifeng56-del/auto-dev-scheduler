<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSchedulerStore } from '../stores/scheduler'
import type { Task, TaskStatus } from '@shared/types'

const store = useSchedulerStore()
const selectedTaskId = ref<string>('')

// Status config: icon and color (with fallback values)
const statusConfig: Record<TaskStatus | 'wave', { icon: string; color: string }> = {
  running: { icon: '●', color: 'var(--vscode-accent-orange, #c88c32)' },
  success: { icon: '✓', color: 'var(--vscode-accent-green, #3c783c)' },
  ready: { icon: '○', color: 'var(--vscode-accent-blue, #007acc)' },
  pending: { icon: '◌', color: 'var(--vscode-fore-text-dim, #969696)' },
  failed: { icon: '✗', color: 'var(--vscode-accent-red, #cd4646)' },
  canceled: { icon: '⊘', color: 'var(--vscode-fore-text-dim, #969696)' },
  wave: { icon: '◈', color: 'var(--vscode-fore-text, #dcdcdc)' }
}

const getStatusConfig = (status: TaskStatus | 'wave') => {
  return statusConfig[status] || { icon: '?', color: 'var(--vscode-fore-text-dim)' }
}

// Format duration: seconds → mm:ss or hh:mm:ss
const formatDuration = (seconds?: number): string => {
  if (seconds === undefined || seconds === null || seconds < 0 || !Number.isFinite(seconds)) return '--:--'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const mStr = m.toString().padStart(2, '0')
  const sStr = s.toString().padStart(2, '0')
  if (h > 0) {
    return `${h.toString().padStart(2, '0')}:${mStr}:${sStr}`
  }
  return `${mStr}:${sStr}`
}

// Table data with wave grouping using el-table tree structure
interface TableRow {
  id: string
  title?: string
  status: TaskStatus | 'wave'
  wave: number
  duration?: number
  dependencies?: string[]
  workerId?: number
  isGroup?: boolean
  children?: Task[]
}

// Calculate wave duration: max(endTime) - min(startTime) for accurate wall-clock time
const calcWaveDuration = (tasks: Task[]): number => {
  const tasksWithTime = tasks.filter(t => t.startTime)
  if (tasksWithTime.length === 0) {
    // Fallback to max(duration) if no startTime available
    return tasks.reduce((max, t) => Math.max(max, t.duration || 0), 0)
  }

  const times = tasksWithTime
    .map(t => {
      const start = new Date(t.startTime!).getTime()
      // If endTime exists, use it; otherwise estimate from startTime + duration
      let end = t.endTime ? new Date(t.endTime).getTime() : NaN
      // Fallback if end is invalid but start is valid
      if (!Number.isFinite(end)) {
        end = start + (t.duration || 0) * 1000
      }
      return { start, end }
    })
    .filter(t => Number.isFinite(t.start) && Number.isFinite(t.end)) // Exclude invalid dates

  if (times.length === 0) {
    // All timestamps invalid, fallback to max(duration)
    return tasks.reduce((max, t) => Math.max(max, t.duration || 0), 0)
  }

  const minStart = Math.min(...times.map(t => t.start))
  const maxEnd = Math.max(...times.map(t => t.end))
  return Math.max(0, Math.floor((maxEnd - minStart) / 1000))
}

const tableData = computed<TableRow[]>(() => {
  const map = store.tasksByWave
  if (!map || map.size === 0) return []

  const groups: TableRow[] = []
  const waves = Array.from(map.keys()).sort((a, b) => a - b)

  for (const wave of waves) {
    const tasks = map.get(wave) || []
    // Sort tasks within wave by id
    const sortedTasks = [...tasks].sort((a, b) => a.id.localeCompare(b.id))
    // Wave duration: wall-clock time from first task start to last task end
    const waveDuration = calcWaveDuration(sortedTasks)
    groups.push({
      id: `wave-${wave}`,
      title: `波次 ${wave}`,
      status: 'wave',
      wave,
      duration: waveDuration > 0 ? waveDuration : undefined,
      isGroup: true,
      children: sortedTasks
    })
  }
  return groups
})

const hasData = computed(() => tableData.value.length > 0)

const handleRowClick = (row: TableRow) => {
  if (!row.isGroup) {
    selectedTaskId.value = row.id
  }
}

const rowClassName = ({ row }: { row: TableRow }) => {
  const classes: string[] = []
  if (row.id === selectedTaskId.value) {
    classes.push('selected-row')
  }
  if (row.isGroup) {
    classes.push('wave-group-row')
  } else {
    classes.push('task-row')
  }
  return classes.join(' ')
}
</script>

<template>
  <div class="task-table-container">
    <el-table
      v-if="hasData"
      :data="tableData"
      row-key="id"
      :tree-props="{ children: 'children' }"
      default-expand-all
      :row-class-name="rowClassName"
      height="100%"
      @row-click="handleRowClick"
    >
      <!-- Status Column -->
      <el-table-column label="状态" width="80" align="center">
        <template #default="{ row }">
          <span class="status-icon" :style="{ color: getStatusConfig(row.status).color }">
            {{ getStatusConfig(row.status).icon }}
          </span>
        </template>
      </el-table-column>

      <!-- Task ID Column -->
      <el-table-column prop="id" label="任务 ID" show-overflow-tooltip>
        <template #default="{ row }">
          <span :class="{ 'group-title': row.isGroup, 'task-id': !row.isGroup }">
            {{ row.isGroup ? row.title : row.id }}
          </span>
          <span v-if="!row.isGroup && row.title" class="task-title">
            {{ row.title }}
          </span>
        </template>
      </el-table-column>

      <!-- Wave Column -->
      <el-table-column prop="wave" label="波次" width="70" align="center">
        <template #default="{ row }">
          <span v-if="!row.isGroup" class="wave-badge">W{{ row.wave }}</span>
        </template>
      </el-table-column>

      <!-- Duration Column -->
      <el-table-column prop="duration" label="耗时" width="90" align="right">
        <template #default="{ row }">
          <span :class="{ 'duration-text': true, 'duration-active': row.status === 'running' }">
            {{ formatDuration(row.duration) }}
          </span>
        </template>
      </el-table-column>
    </el-table>

    <!-- Empty state -->
    <div v-else class="empty-state">
      <div class="empty-icon">◌</div>
      <div class="empty-text">加载 AUTO-DEV.md 文件以查看任务</div>
    </div>
  </div>
</template>

<style scoped>
.task-table-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--vscode-panel-bg);
  overflow: hidden;
}

/* Status icon */
.status-icon {
  font-size: 16px;
  font-weight: bold;
  line-height: 1;
}

/* Task ID and title */
.group-title {
  font-weight: 600;
  color: var(--vscode-fore-text);
}

.task-id {
  font-family: 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 13px;
}

.task-title {
  margin-left: 8px;
  color: var(--vscode-fore-text-dim);
  font-size: 12px;
}

/* Wave badge */
.wave-badge {
  font-size: 12px;
  color: var(--vscode-fore-text-dim);
}

/* Duration */
.duration-text {
  font-family: 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  color: var(--vscode-fore-text-dim);
}

.duration-active {
  color: var(--vscode-accent-orange);
}

/* Empty state */
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--vscode-fore-text-dim);
}

.empty-icon {
  font-size: 48px;
  opacity: 0.3;
}

.empty-text {
  font-size: 14px;
  font-style: italic;
}

/* Table row overrides */
:deep(.wave-group-row) {
  background-color: var(--vscode-bg) !important;
}

:deep(.wave-group-row:hover) {
  background-color: var(--vscode-bg) !important;
}

:deep(.selected-row) {
  background-color: var(--vscode-selection) !important;
}

:deep(.selected-row:hover) {
  background-color: var(--vscode-selection) !important;
}

/* Task row cursor */
:deep(.task-row) {
  cursor: pointer;
}

/* Tree expand icon */
:deep(.el-table__expand-icon) {
  color: var(--vscode-fore-text-dim);
}

:deep(.el-table__expand-icon .el-icon) {
  font-size: 14px;
}
</style>
