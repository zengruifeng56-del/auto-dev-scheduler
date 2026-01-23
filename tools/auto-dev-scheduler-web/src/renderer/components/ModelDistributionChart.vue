<script setup lang="ts">
import { computed } from 'vue';
import { useSchedulerStore } from '../stores/scheduler';

const store = useSchedulerStore();

// Task status counts
const stats = computed(() => {
  let success = 0;
  let failed = 0;
  let running = 0;
  let pending = 0;
  let totalRetries = 0;

  for (const task of store.tasks) {
    if (task.status === 'success') success++;
    else if (task.status === 'failed') failed++;
    else if (task.status === 'running') running++;
    else if (task.status === 'pending' || task.status === 'ready') pending++;

    // Count retries
    if (task.retryCount && task.retryCount > 0) {
      totalRetries += task.retryCount;
    }
  }

  // Count open issues
  const issues = store.issues.filter(i => i.status === 'open').length;

  return { success, failed, running, pending, totalRetries, issues };
});

const hasApiError = computed(() => store.apiError !== null);
</script>

<template>
  <div class="task-stats">
    <div class="stats-header">任务状态</div>
    <div class="stats-list">
      <div class="stat-item">
        <span class="stat-dot success"></span>
        <span class="stat-label">成功</span>
        <span class="stat-value">{{ stats.success }}</span>
      </div>
      <div class="stat-item" :class="{ alert: stats.failed > 0 }">
        <span class="stat-dot failed"></span>
        <span class="stat-label">失败</span>
        <span class="stat-value">{{ stats.failed }}</span>
      </div>
      <div class="stat-item" v-if="stats.running > 0">
        <span class="stat-dot running"></span>
        <span class="stat-label">运行中</span>
        <span class="stat-value">{{ stats.running }}</span>
      </div>
      <div class="stat-item" v-if="stats.pending > 0">
        <span class="stat-dot pending"></span>
        <span class="stat-label">等待</span>
        <span class="stat-value">{{ stats.pending }}</span>
      </div>
      <div class="stat-item" :class="{ warn: stats.totalRetries > 0 }">
        <span class="stat-dot retry"></span>
        <span class="stat-label">重试</span>
        <span class="stat-value">{{ stats.totalRetries }}</span>
      </div>
      <div class="stat-item" v-if="stats.issues > 0" :class="{ warn: true }">
        <span class="stat-dot issue"></span>
        <span class="stat-label">问题</span>
        <span class="stat-value">{{ stats.issues }}</span>
      </div>
      <div class="stat-item api-error" v-if="hasApiError">
        <span class="stat-dot error"></span>
        <span class="stat-label">API错误</span>
        <span class="stat-value">!</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-stats {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--vscode-panel-bg, #252526);
  border-radius: 4px;
  padding: 8px 12px;
  box-sizing: border-box;
}

.stats-header {
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-fore-text-dim, #969696);
  margin-bottom: 8px;
}

.stats-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 2px 0;
}

.stat-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.stat-dot.success { background-color: #4ec9b0; }
.stat-dot.failed { background-color: #f14c4c; }
.stat-dot.running { background-color: #ce9178; }
.stat-dot.pending { background-color: #666; }
.stat-dot.retry { background-color: #dcdcaa; }
.stat-dot.issue { background-color: #cca700; }
.stat-dot.error { background-color: #f14c4c; animation: blink 1s infinite; }

.stat-label {
  color: var(--vscode-fore-text-dim, #969696);
  flex: 1;
}

.stat-value {
  font-family: 'SF Mono', Consolas, monospace;
  color: var(--vscode-fore-text, #dcdcdc);
  min-width: 24px;
  text-align: right;
}

.stat-item.alert .stat-value {
  color: #f14c4c;
  font-weight: 600;
}

.stat-item.warn .stat-value {
  color: #cca700;
  font-weight: 600;
}

.stat-item.api-error {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--vscode-border, #333);
}

.stat-item.api-error .stat-label {
  color: #f14c4c;
}

.stat-item.api-error .stat-value {
  color: #f14c4c;
  font-weight: bold;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
