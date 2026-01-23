<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useSchedulerStore } from '../stores/scheduler';
import type { TaskStatus } from '@shared/types';

const store = useSchedulerStore();
const scrollContainer = ref<HTMLDivElement | null>(null);

// 拖拽滑动状态
const isDragging = ref(false);
const startX = ref(0);
const scrollLeft = ref(0);

function onMouseDown(e: MouseEvent) {
  if (!scrollContainer.value) return;
  isDragging.value = true;
  startX.value = e.pageX - scrollContainer.value.offsetLeft;
  scrollLeft.value = scrollContainer.value.scrollLeft;
  scrollContainer.value.style.cursor = 'grabbing';
}

function onMouseMove(e: MouseEvent) {
  if (!isDragging.value || !scrollContainer.value) return;
  e.preventDefault();
  const x = e.pageX - scrollContainer.value.offsetLeft;
  const walk = (x - startX.value) * 1.5;
  scrollContainer.value.scrollLeft = scrollLeft.value - walk;
}

function onMouseUp() {
  isDragging.value = false;
  if (scrollContainer.value) {
    scrollContainer.value.style.cursor = 'grab';
  }
}

function onMouseLeave() {
  if (isDragging.value) {
    isDragging.value = false;
    if (scrollContainer.value) {
      scrollContainer.value.style.cursor = 'grab';
    }
  }
}

onMounted(() => {
  if (scrollContainer.value) {
    scrollContainer.value.style.cursor = 'grab';
  }
});

onUnmounted(() => {
  isDragging.value = false;
});

const tasks = computed(() => store.sortedTasks);

const statusConfig: Record<TaskStatus, { icon: string; color: string }> = {
  running: { icon: '●', color: 'var(--vscode-accent-orange)' },
  success: { icon: '✓', color: 'var(--vscode-accent-green)' },
  ready: { icon: '○', color: 'var(--vscode-accent-blue)' },
  pending: { icon: '·', color: 'var(--vscode-fore-text-dim)' },
  failed: { icon: '✗', color: 'var(--vscode-accent-red)' },
  canceled: { icon: '⊘', color: 'var(--vscode-fore-text-dim)' }
};

function getStatusConfig(status: TaskStatus) {
  return statusConfig[status] || { icon: '?', color: 'var(--vscode-fore-text-dim)' };
}

function formatDuration(seconds?: number): string {
  if (seconds === undefined || seconds < 0 || !Number.isFinite(seconds)) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// Auto-scroll to running task
const runningTaskIds = computed(() =>
  tasks.value.filter(t => t.status === 'running').map(t => t.id)
);

watch(runningTaskIds, async (newIds, oldIds) => {
  const newlyStarted = newIds.filter(id => !oldIds?.includes(id));
  if (newlyStarted.length > 0 && scrollContainer.value) {
    await nextTick();
    const card = scrollContainer.value.querySelector(`[data-task-id="${newlyStarted[0]}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }
}, { flush: 'post' });

function handleRetry(taskId: string) {
  store.retryTask(taskId);
}
</script>

<template>
  <div
    ref="scrollContainer"
    class="task-cards-container"
    @mousedown="onMouseDown"
    @mousemove="onMouseMove"
    @mouseup="onMouseUp"
    @mouseleave="onMouseLeave"
  >
    <div
      v-for="task in tasks"
      :key="task.id"
      :data-task-id="task.id"
      class="task-card"
      :class="'status-' + task.status"
    >
      <div class="task-header">
        <span
          class="status-icon"
          :style="{ color: getStatusConfig(task.status).color }"
        >{{ getStatusConfig(task.status).icon }}</span>
        <span class="task-id">{{ task.id }}</span>
        <span class="wave-badge">W{{ task.wave }}</span>
      </div>
      <div v-if="task.title" class="task-title">{{ task.title }}</div>
      <div class="task-meta">
        <span class="duration">{{ formatDuration(task.duration) }}</span>
        <span v-if="task.dependencies?.length" class="deps" :title="task.dependencies.join(', ')">
          ← {{ task.dependencies.length }}
        </span>
      </div>
      <button
        v-if="task.status === 'failed'"
        class="retry-btn"
        @click.stop="handleRetry(task.id)"
      >↻ 重试</button>
    </div>
    <div v-if="tasks.length === 0" class="empty-state">
      <span>加载任务文件以查看任务</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.task-cards-container {
  display: flex;
  gap: 8px;
  padding: 8px;
  overflow-x: auto;
  overflow-y: hidden;
  height: 100%;
  align-items: flex-start;
}

.task-card {
  flex: 0 0 auto;
  width: 160px;
  padding: 10px 12px;
  background: var(--card-bg);
  border-radius: var(--card-radius);
  border: 1px solid var(--card-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: all 0.2s ease;

  &:hover {
    border-color: var(--vscode-fore-text-dim);
  }

  &.status-running {
    border-color: var(--vscode-accent-blue);
    box-shadow: 0 0 12px var(--vscode-glow-blue);
  }

  &.status-success {
    opacity: 0.7;
  }

  &.status-failed {
    border-color: var(--vscode-accent-red);
  }

  &.status-pending {
    opacity: 0.5;
  }
}

.task-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.status-icon {
  font-size: 14px;
  line-height: 1;
}

.task-id {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-fore-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wave-badge {
  font-size: 10px;
  padding: 1px 4px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  color: var(--vscode-fore-text-dim);
}

.task-title {
  font-size: 11px;
  color: var(--vscode-fore-text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10px;
  color: var(--vscode-fore-text-dim);
}

.duration {
  font-family: 'SF Mono', Consolas, monospace;
}

.deps {
  color: var(--vscode-accent-orange);
}

.retry-btn {
  margin-top: 4px;
  padding: 4px 8px;
  font-size: 10px;
  background: transparent;
  border: 1px solid var(--vscode-accent-blue);
  border-radius: 4px;
  color: var(--vscode-accent-blue);
  cursor: pointer;

  &:hover {
    background: var(--vscode-accent-blue);
    color: #fff;
  }
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-fore-text-dim);
  font-size: 12px;
  min-width: 200px;
}
</style>
