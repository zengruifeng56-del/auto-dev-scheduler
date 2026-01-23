<script setup lang="ts">
import { computed } from 'vue';
import { useSchedulerStore } from '../stores/scheduler';

const store = useSchedulerStore();

const emit = defineEmits<{
  'wave-click': [wave: number];
}>();

interface WaveInfo {
  wave: number;
  total: number;
  completed: number;
  failed: number;
  running: number;
}

const waves = computed(() => {
  const map = new Map<number, WaveInfo>();
  for (const task of store.tasks) {
    if (!map.has(task.wave)) {
      map.set(task.wave, { wave: task.wave, total: 0, completed: 0, failed: 0, running: 0 });
    }
    const w = map.get(task.wave)!;
    w.total++;
    if (task.status === 'success') w.completed++;
    if (task.status === 'failed') w.failed++;
    if (task.status === 'running') w.running++;
  }
  return Array.from(map.values()).sort((a, b) => a.wave - b.wave);
});

const currentWave = computed(() => {
  for (const w of waves.value) {
    if (w.running > 0) return w.wave;
    if (w.completed < w.total) return w.wave;
  }
  return waves.value.length > 0 ? waves.value[waves.value.length - 1]!.wave : 0;
});

function getWaveStatus(w: WaveInfo): 'running' | 'completed' | 'failed' | 'partial' | 'pending' {
  if (w.running > 0) return 'running';
  if (w.completed === w.total && w.total > 0) return 'completed';
  if (w.failed > 0) return 'failed';
  if (w.completed > 0) return 'partial';
  return 'pending';
}

function getProgressWidth(w: WaveInfo): number {
  if (w.total === 0) return 0;
  return (w.completed / w.total) * 100;
}

function handleClick(wave: number) {
  emit('wave-click', wave);
}
</script>

<template>
  <div class="waves-card card">
    <div class="card-title">波次</div>
    <div v-if="waves.length > 0" class="waves-list">
      <div
        v-for="w in waves"
        :key="w.wave"
        class="wave-item"
        :class="[getWaveStatus(w), { current: w.wave === currentWave }]"
        @click="handleClick(w.wave)"
        :title="`Wave ${w.wave}: ${w.completed}/${w.total}`"
      >
        <span class="wave-label">W{{ w.wave }}</span>
        <div class="wave-progress">
          <div class="wave-progress-fill" :style="{ width: `${getProgressWidth(w)}%` }" />
        </div>
        <span class="wave-count">{{ w.completed }}/{{ w.total }}</span>
      </div>
    </div>
    <div v-else class="empty-state">
      <span>无波次</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.waves-card {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.waves-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wave-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--vscode-input-bg);
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    background: var(--vscode-selection);
  }

  &.current {
    border-left: 3px solid var(--vscode-accent-blue);
    padding-left: 5px;
  }

  &.running {
    .wave-label { color: var(--vscode-accent-blue); }
    .wave-progress-fill { background: var(--vscode-accent-blue); }
  }

  &.completed {
    .wave-label { color: var(--vscode-accent-green); }
    .wave-progress-fill { background: var(--vscode-accent-green); }
  }

  &.failed {
    .wave-label { color: var(--vscode-accent-red); }
    .wave-progress-fill { background: var(--vscode-accent-red); }
  }

  &.partial {
    .wave-progress-fill { background: var(--vscode-accent-orange); }
  }

  &.pending {
    opacity: 0.5;
  }
}

.wave-label {
  font-size: 12px;
  font-weight: 600;
  min-width: 28px;
  color: var(--vscode-fore-text);
}

.wave-progress {
  flex: 1;
  height: 4px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
  overflow: hidden;
}

.wave-progress-fill {
  height: 100%;
  background: var(--vscode-fore-text-dim);
  transition: width 0.3s ease;
}

.wave-count {
  font-size: 10px;
  color: var(--vscode-fore-text-dim);
  min-width: 28px;
  text-align: right;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-fore-text-dim);
  font-size: 12px;
}
</style>
