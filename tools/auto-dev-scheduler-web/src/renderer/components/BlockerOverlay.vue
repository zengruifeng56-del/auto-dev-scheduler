<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSchedulerStore } from '../stores/scheduler'

const store = useSchedulerStore()

const dismissed = ref(false)

const shouldShow = computed(() =>
  store.paused && store.pausedReason === 'blocker'
)

const isVisible = computed(() =>
  shouldShow.value && !dismissed.value
)

watch(shouldShow, (visible) => {
  if (!visible) dismissed.value = false
})

const blockers = computed(() =>
  store.issues.filter(i => i.status === 'open' && i.severity === 'blocker')
)

function handleClose() {
  dismissed.value = true
}

function handlePause() {
  store.pause()
}

function handleAcknowledge() {
  store.resume()
  store.$patch({
    paused: false,
    pausedReason: null
  })
}
</script>

<template>
  <div v-if="isVisible" class="blocker-overlay">
    <div class="blocker-modal">
      <div class="modal-header">
        <span class="icon">⚠️</span>
        <h3>自动暂停：检测到阻塞级问题</h3>
        <button
          type="button"
          class="btn-close"
          aria-label="关闭"
          @click="handleClose"
        >
          ✕
        </button>
      </div>

      <div class="modal-body">
        <p class="summary">
          发现 <span class="count">{{ blockers.length }}</span> 个阻塞问题，调度器已自动暂停。
          请处理以下问题后再继续。
        </p>

        <div class="issue-list">
          <div v-for="issue in blockers" :key="issue.id" class="issue-card">
            <div class="issue-header">
              <span class="badge">Blocker</span>
              <span class="issue-title">{{ issue.title }}</span>
            </div>
            <div v-if="issue.files.length > 0" class="issue-files">
              {{ issue.files.join(', ') }}
            </div>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button
          type="button"
          class="btn-secondary btn-pause"
          @click="handlePause"
        >
          暂停
        </button>
        <button type="button" class="btn-primary" @click="handleAcknowledge">
          确认并尝试继续
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.blocker-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(2px);
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.blocker-modal {
  background: var(--vscode-panel-bg, #252526);
  border: 1px solid var(--vscode-accent-red, #cd4646);
  width: 560px;
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
  background: rgba(205, 70, 70, 0.15);
  border-bottom: 1px solid var(--vscode-accent-red, #cd4646);
}

.modal-header .icon {
  font-size: 20px;
}

.modal-header h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--vscode-accent-red, #cd4646);
}

.btn-close {
  margin-left: auto;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid transparent;
  background: transparent;
  color: var(--vscode-fore-text-dim, #969696);
  font-size: 14px;
  cursor: pointer;
}

.btn-close:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--vscode-fore-text, #dcdcdc);
}

.btn-close:focus-visible {
  outline: 2px solid var(--vscode-focus-border, #007fd4);
  outline-offset: 2px;
}

.modal-body {
  padding: 16px 20px;
  overflow-y: auto;
  flex: 1;
}

.summary {
  margin: 0 0 16px 0;
  font-size: 13px;
  color: var(--vscode-fore-text, #dcdcdc);
}

.summary .count {
  color: var(--vscode-accent-red, #cd4646);
  font-weight: bold;
}

.issue-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.issue-card {
  background: var(--vscode-input-bg, #1e1e1e);
  border: 1px solid var(--vscode-border, #333);
  padding: 10px 12px;
}

.issue-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.badge {
  background: var(--vscode-accent-red, #cd4646);
  color: white;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 2px;
  text-transform: uppercase;
}

.issue-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-fore-text, #dcdcdc);
}

.issue-files {
  margin-top: 6px;
  font-size: 11px;
  color: var(--vscode-fore-text-dim, #969696);
  font-family: monospace;
}

.modal-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--vscode-border, #333);
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
}

.btn-pause {
  margin-right: auto;
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
  background: var(--vscode-accent-red, #cd4646);
  color: white;
  border: none;
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
}
</style>
