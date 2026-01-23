<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { useSchedulerStore } from '../stores/scheduler'

const store = useSchedulerStore()

const isVisible = computed(() =>
  store.paused && store.pausedReason === 'apiError' && store.apiError !== null
)

const apiError = computed(() => store.apiError)

// Countdown timer for auto-retry
const remainingSeconds = ref(0)
let countdownTimer: ReturnType<typeof setInterval> | null = null

function updateCountdown() {
  if (!store.apiError?.nextRetryInMs || !store.apiError.receivedAt) {
    remainingSeconds.value = 0
    return
  }

  const elapsedMs = Date.now() - store.apiError.receivedAt
  const remainingMs = Math.max(0, store.apiError.nextRetryInMs - elapsedMs)
  remainingSeconds.value = Math.ceil(remainingMs / 1000)
}

function startCountdown() {
  stopCountdown()
  updateCountdown()
  countdownTimer = setInterval(updateCountdown, 1000)
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

function handleRetryNow() {
  store.retryFromApiError()
}

function handleStop() {
  store.stop()
}

onMounted(() => {
  startCountdown()
})

onUnmounted(() => {
  stopCountdown()
})

// Restart countdown when API error changes
watch(() => store.apiError, (newVal) => {
  if (newVal) {
    startCountdown()
  } else {
    stopCountdown()
  }
})

const isMaxRetriesExceeded = computed(() =>
  apiError.value?.nextRetryInMs === null
)

const formatErrorMessage = computed(() => {
  if (!apiError.value?.errorText) return ''
  const text = apiError.value.errorText
  // Try to extract the message from JSON
  const match = /"message"\s*:\s*"([^"]+)"/.exec(text)
  if (match) return match[1]
  // Fallback to first 200 chars
  return text.slice(0, 200)
})

// Determine the pause reason for display
const pauseReasonDisplay = computed(() => {
  if (apiError.value?.pauseReason) {
    return apiError.value.pauseReason
  }
  if (apiError.value?.taskId && apiError.value?.taskRetryCount !== undefined) {
    const taskMaxRetries = apiError.value.taskMaxRetries ?? 3
    if (apiError.value.taskRetryCount >= taskMaxRetries) {
      return `任务 ${apiError.value.taskId} 达到最大重试次数 (${taskMaxRetries})`
    }
  }
  if (apiError.value?.retryCount !== undefined && apiError.value?.maxRetries !== undefined) {
    if (apiError.value.retryCount > apiError.value.maxRetries) {
      return `全局重试次数已耗尽 (${apiError.value.maxRetries})`
    }
  }
  return '已达到最大重试次数'
})
</script>

<template>
  <div v-if="isVisible" class="api-error-overlay">
    <div class="api-error-modal">
      <div class="modal-header">
        <span class="icon">🔥</span>
        <h3>API 错误：服务暂时不可用</h3>
      </div>

      <div class="modal-body">
        <p class="error-message">
          {{ formatErrorMessage }}
        </p>

        <!-- Task info if available -->
        <div v-if="apiError?.taskId" class="task-info">
          <span class="label">触发任务:</span>
          <span class="task-id">{{ apiError.taskId }}</span>
          <span v-if="apiError.taskRetryCount !== undefined" class="task-retries">
            (任务重试: {{ apiError.taskRetryCount }}/{{ apiError.taskMaxRetries ?? 3 }})
          </span>
        </div>

        <div v-if="isMaxRetriesExceeded" class="max-retries-warning">
          <p class="warning-title">⚠️ 需要人工干预</p>
          <p class="warning-reason">{{ pauseReasonDisplay }}</p>
          <p class="warning-hint">请检查 API 状态和网络连接后再继续。</p>
        </div>

        <div v-else class="retry-info">
          <p>
            全局重试进度: <span class="count">{{ apiError?.retryCount }}</span> / {{ apiError?.maxRetries }}
          </p>
          <p class="countdown">
            将在 <span class="time">{{ remainingSeconds }}</span> 秒后自动重试...
          </p>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn-secondary" @click="handleStop">
          停止调度器
        </button>
        <button class="btn-primary" @click="handleRetryNow">
          {{ isMaxRetriesExceeded ? '手动重试' : '立即重试' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.api-error-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(3px);
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.api-error-modal {
  background: var(--vscode-panel-bg, #252526);
  border: 1px solid #d97706;
  width: 520px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.modal-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px;
  background: rgba(217, 119, 6, 0.15);
  border-bottom: 1px solid #d97706;
}

.modal-header .icon {
  font-size: 20px;
}

.modal-header h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: #fbbf24;
}

.modal-body {
  padding: 16px 20px;
  overflow-y: auto;
  flex: 1;
}

.error-message {
  margin: 0 0 12px 0;
  padding: 12px;
  background: var(--vscode-input-bg, #1e1e1e);
  border: 1px solid var(--vscode-border, #333);
  font-size: 13px;
  color: #fbbf24;
  font-family: monospace;
  word-break: break-word;
}

.task-info {
  margin-bottom: 12px;
  padding: 8px 12px;
  background: rgba(59, 130, 246, 0.1);
  border: 1px solid rgba(59, 130, 246, 0.3);
  font-size: 12px;
  color: var(--vscode-fore-text, #dcdcdc);
}

.task-info .label {
  color: var(--vscode-fore-text-dim, #969696);
}

.task-info .task-id {
  color: #60a5fa;
  font-family: monospace;
  font-weight: 500;
  margin-left: 4px;
}

.task-info .task-retries {
  color: #fbbf24;
  margin-left: 8px;
}

.max-retries-warning {
  padding: 12px;
  background: rgba(220, 38, 38, 0.15);
  border: 1px solid #dc2626;
  margin-bottom: 16px;
}

.max-retries-warning .warning-title {
  margin: 0 0 8px 0;
  font-size: 14px;
  font-weight: 600;
  color: #fca5a5;
}

.max-retries-warning .warning-reason {
  margin: 0 0 8px 0;
  font-size: 13px;
  color: #fbbf24;
  font-weight: 500;
}

.max-retries-warning .warning-hint {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-fore-text-dim, #969696);
}

.retry-info {
  font-size: 13px;
  color: var(--vscode-fore-text, #dcdcdc);
}

.retry-info p {
  margin: 0 0 8px 0;
}

.retry-info .count {
  color: #fbbf24;
  font-weight: bold;
}

.countdown {
  font-size: 14px;
}

.countdown .time {
  color: #fbbf24;
  font-weight: bold;
  font-size: 18px;
}

.modal-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--vscode-border, #333);
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.btn-secondary {
  background: var(--vscode-input-bg, #3c3c3c);
  color: var(--vscode-fore-text, #dcdcdc);
  border: 1px solid var(--vscode-border, #555);
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
}

.btn-secondary:hover {
  background: var(--vscode-input-bg-hover, #4c4c4c);
}

.btn-primary {
  background: #d97706;
  color: white;
  border: none;
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
}

.btn-primary:hover {
  background: #b45309;
}
</style>
