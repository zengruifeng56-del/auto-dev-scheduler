<script setup lang="ts">
import { computed } from 'vue'
import { useSchedulerStore } from '../stores/scheduler'

const store = useSchedulerStore()

const emit = defineEmits<{
  'wave-click': [wave: number]
}>()

interface WaveInfo {
  wave: number
  total: number
  completed: number
  failed: number
  running: number
}

const waves = computed(() => {
  const map = new Map<number, WaveInfo>()

  for (const task of store.tasks) {
    if (!map.has(task.wave)) {
      map.set(task.wave, { wave: task.wave, total: 0, completed: 0, failed: 0, running: 0 })
    }
    const w = map.get(task.wave)!
    w.total++
    if (task.status === 'success') w.completed++
    if (task.status === 'failed') w.failed++
    if (task.status === 'running') w.running++
  }

  return Array.from(map.values()).sort((a, b) => a.wave - b.wave)
})

const currentWave = computed(() => {
  for (const w of waves.value) {
    if (w.running > 0) return w.wave
    if (w.completed < w.total) return w.wave
  }
  return waves.value.length > 0 ? waves.value[waves.value.length - 1]!.wave : 0
})

function getWaveClass(w: WaveInfo) {
  if (w.running > 0) return 'running'
  if (w.completed === w.total && w.total > 0) return 'completed'
  if (w.failed > 0) return 'failed'
  if (w.completed > 0) return 'partial'
  return 'pending'
}

function handleWaveClick(wave: number) {
  emit('wave-click', wave)
}
</script>

<template>
  <div v-if="waves.length > 0" class="phase-timeline">
    <div class="timeline-label">波次进度</div>
    <div class="timeline-track">
      <div
        v-for="w in waves"
        :key="w.wave"
        class="wave-segment"
        :class="[getWaveClass(w), { current: w.wave === currentWave }]"
        :title="`Wave ${w.wave}: ${w.completed}/${w.total} - 点击跳转`"
        @click="handleWaveClick(w.wave)"
      >
        <span class="wave-num">{{ w.wave }}</span>
      </div>
    </div>
    <div class="timeline-summary">
      {{ store.progress.completed }}/{{ store.progress.total }}
    </div>
  </div>
</template>

<style scoped>
.phase-timeline {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
}

.timeline-label {
  font-size: 11px;
  color: var(--vscode-fore-text-dim, #969696);
  white-space: nowrap;
}

.timeline-track {
  display: flex;
  gap: 2px;
  flex: 1;
}

.wave-segment {
  flex: 1;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vscode-input-bg, #1e1e1e);
  border: 1px solid var(--vscode-border, #333);
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s ease, border-color 0.2s ease, transform 0.2s ease, opacity 0.2s ease;
}

.wave-segment:hover {
  border-color: var(--vscode-accent-blue, #007acc);
}

.wave-segment.pending {
  opacity: 0.5;
}

.wave-segment.partial {
  background: linear-gradient(90deg, var(--vscode-accent-green, #3c783c) 50%, var(--vscode-input-bg, #1e1e1e) 50%);
}

.wave-segment.completed {
  background: var(--vscode-accent-green, #4ec9b0);
  border-color: rgba(78, 201, 176, 0.8);
}

.wave-segment.running {
  background: var(--vscode-accent-blue, #0e639c);
  border-color: rgba(14, 99, 156, 0.8);
  box-shadow: 0 0 8px var(--vscode-glow-blue, rgba(14, 99, 156, 0.4));
  animation: phase-timeline-pulse 1.5s ease-in-out infinite;
}

.wave-segment.failed {
  background: var(--vscode-accent-red, #cd4646);
  border-color: var(--vscode-accent-red, #cd4646);
}

.wave-segment.current {
  transform: scale(1.05);
  z-index: 1;
}

.wave-num {
  font-size: 10px;
  font-weight: bold;
  color: var(--vscode-fore-text, #dcdcdc);
}

.wave-segment.completed .wave-num,
.wave-segment.running .wave-num,
.wave-segment.failed .wave-num {
  color: white;
}

.timeline-summary {
  font-size: 11px;
  color: var(--vscode-fore-text-dim, #969696);
  white-space: nowrap;
  min-width: 50px;
  text-align: right;
}

@media (prefers-reduced-motion: reduce) {
  .wave-segment {
    transition: none;
  }

  .wave-segment.running {
    animation: none;
  }

  .wave-segment.current {
    transform: none;
  }
}

@keyframes phase-timeline-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}
</style>
