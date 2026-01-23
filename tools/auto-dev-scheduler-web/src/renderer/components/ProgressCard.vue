<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useSchedulerStore } from '../stores/scheduler';

const store = useSchedulerStore();
const { progress, running, paused, lastError } = storeToRefs(store);

const progressPercent = computed(() => store.progressPercent);

const isComplete = computed(
  () => progress.value.total > 0 && progress.value.completed === progress.value.total
);

const statusClass = computed(() => {
  if (lastError.value) return 'error';
  if (isComplete.value) return 'complete';
  if (paused.value) return 'paused';
  if (running.value) return 'running';
  return 'idle';
});
</script>

<template>
  <div class="progress-card card">
    <div class="card-title">进度</div>
    <div class="card-content">
      <div class="progress-numbers">
        <span class="completed" :class="statusClass">{{ progress.completed }}</span>
        <span class="separator">/</span>
        <span class="total">{{ progress.total }}</span>
      </div>
      <span class="percentage" :class="statusClass">{{ progressPercent }}%</span>
      <div class="progress-bar-container">
        <div
          class="progress-bar-fill"
          :class="statusClass"
          :style="{ width: `${progressPercent}%` }"
        />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.progress-card {
  flex: 0 0 auto;
  min-width: 180px;
}

.card-content {
  display: flex;
  align-items: center;
  gap: 12px;
}

.progress-numbers {
  display: flex;
  align-items: baseline;
  gap: 2px;
  font-family: 'SF Mono', Consolas, monospace;
}

.completed {
  font-size: 24px;
  font-weight: 700;
  line-height: 1;
  color: var(--vscode-fore-text);

  &.running { color: var(--vscode-accent-blue); }
  &.paused { color: var(--vscode-accent-orange); }
  &.complete { color: var(--vscode-accent-green); }
  &.error { color: var(--vscode-accent-red); }
}

.separator {
  color: var(--vscode-fore-text-dim);
  font-size: 14px;
}

.total {
  color: var(--vscode-fore-text-dim);
  font-size: 14px;
}

.percentage {
  font-size: 14px;
  font-weight: 600;
  color: var(--vscode-fore-text-dim);
  min-width: 36px;
  text-align: right;

  &.running { color: var(--vscode-accent-blue); }
  &.paused { color: var(--vscode-accent-orange); }
  &.complete { color: var(--vscode-accent-green); }
  &.error { color: var(--vscode-accent-red); }
}

.progress-bar-container {
  flex: 1;
  height: 4px;
  background: var(--vscode-input-bg);
  border-radius: 2px;
  overflow: hidden;
  min-width: 60px;
}

.progress-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s ease;
  background: var(--vscode-fore-text-dim);

  &.running { background: var(--vscode-accent-blue); }
  &.paused { background: var(--vscode-accent-orange); }
  &.complete { background: var(--vscode-accent-green); }
  &.error { background: var(--vscode-accent-red); }
}
</style>
