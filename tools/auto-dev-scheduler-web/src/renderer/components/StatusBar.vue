<script setup lang="ts">
import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useSchedulerStore } from '../stores/scheduler'

const store = useSchedulerStore()
const { running, paused, lastError, progress, activeWorkers } = storeToRefs(store)

// Derived: all tasks completed
const isAllComplete = computed(() => {
  return progress.value.total > 0 && progress.value.completed === progress.value.total
})

// Status text
const statusText = computed(() => {
  if (lastError.value) return `错误: ${lastError.value}`
  if (isAllComplete.value) return '全部任务完成！'
  if (paused.value) return '已暂停'
  if (running.value) return '正在运行'
  return '就绪'
})

// Status color (using theme variables with fallbacks)
const statusColor = computed(() => {
  if (lastError.value) return 'var(--vscode-accent-red, #cd4646)'
  if (isAllComplete.value) return 'var(--vscode-accent-green, #3c783c)'
  if (paused.value) return 'var(--vscode-accent-orange, #c88c32)'
  if (running.value) return 'var(--vscode-accent-blue, #007acc)'
  return 'var(--vscode-fore-text-dim, #969696)'
})

// Running task IDs with type guard
const runningTaskIds = computed(() => {
  const ids = activeWorkers.value
    .map(w => w.taskId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  return ids.length > 0 ? ids.join(', ') : '-'
})

// Play notification sound with proper cleanup
function playNotificationSound() {
  try {
    const AudioContextCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

    if (!AudioContextCtor) return

    const ctx = new AudioContextCtor()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, ctx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.15)

    gain.gain.setValueAtTime(0.3, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15)

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.onended = () => {
      ctx.close().catch(() => {})
    }

    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {})
    }

    osc.start()
    osc.stop(ctx.currentTime + 0.15)
  } catch {
    // Silently ignore audio errors
  }
}

// Watch completion state (not deep watch on object)
watch(isAllComplete, (newVal, oldVal) => {
  if (newVal && !oldVal) {
    playNotificationSound()
  }
})
</script>

<template>
  <div class="status-bar">
    <div class="status-indicator">
      <span class="status-dot" :style="{ backgroundColor: statusColor }"></span>
      <span class="status-value" :style="{ color: statusColor }">{{ statusText }}</span>
    </div>
    <span class="separator">|</span>
    <div class="running-section">
      <span class="running-label">运行中:</span>
      <span class="running-value">{{ runningTaskIds }}</span>
    </div>
  </div>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  font-family: 'Consolas', 'Monaco', monospace;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-value {
  font-weight: 600;
  white-space: nowrap;
}

.separator {
  color: var(--vscode-border, #434346);
}

.running-section {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
}

.running-label {
  color: var(--vscode-fore-text-dim, #969696);
  flex-shrink: 0;
}

.running-value {
  color: var(--vscode-fore-text, #dcdcdc);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
