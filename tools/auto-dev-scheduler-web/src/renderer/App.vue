<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useSchedulerStore } from './stores/scheduler';

import ControlBar from './components/ControlBar.vue';
import StatusBar from './components/StatusBar.vue';
import TaskTable from './components/TaskTable.vue';
import LogPanel from './components/LogPanel.vue';
import IssuesPanel from './components/IssuesPanel.vue';

const store = useSchedulerStore();
const ipcReady = computed(() => store.ipcReady);
const connectionStatusClass = computed(() => (ipcReady.value ? 'open' : 'closed'));
const connectionStatusDisplay = computed(() => (ipcReady.value ? 'IPC 就绪' : 'IPC 未就绪'));

const hasWorkerContent = (id: number) => {
  const w = store.workers.get(id);
  return w && (w.taskId || w.logs.length > 0);
};

const busyWorkerIds = computed(() => {
  const ids: number[] = [];
  for (let i = 1; i <= 4; i++) {
    if (hasWorkerContent(i)) ids.push(i);
  }
  return ids;
});

const visibleCount = computed(() => {
  const busy = busyWorkerIds.value.length;
  return busy > 0 ? busy : 4;
});

const hasIssues = computed(() => store.issues.length > 0);

function handleSendToWorker(workerId: number, content: string) {
  store.sendToWorker(workerId, content);
}

function handleKillWorker(workerId: number) {
  store.killWorker(workerId);
}

onMounted(() => {
  store.init();
});

onUnmounted(() => {
  store.cleanup();
});
</script>

<template>
  <div class="app-layout">
    <!-- Header: Slim VS Code Style Title Bar -->
    <header class="app-header">
      <div class="header-left">
        <span class="app-title">自动开发调度器</span>
      </div>
      <div class="header-right">
        <div class="connection-status">
          <span class="status-dot" :class="connectionStatusClass" />
          <span class="status-text">{{ connectionStatusDisplay }}</span>
        </div>
      </div>
    </header>

    <!-- Main Content Area -->
    <main class="app-content">
      <!-- 1. Control Bar -->
      <section class="section-control">
        <ControlBar />
      </section>

      <!-- 2. Status Bar -->
      <section class="section-status">
        <StatusBar />
      </section>

      <!-- 3. Task Table (Flexible Height) -->
      <section class="section-table">
        <TaskTable />
      </section>

      <!-- 3.5 Issues Panel (Conditional) -->
      <section v-if="hasIssues" class="section-issues">
        <IssuesPanel />
      </section>

      <!-- 4. Log Panels (Flexible Bottom) -->
      <section class="section-logs">
        <div class="logs-header">
          <span>工作终端</span>
          <span v-if="busyWorkerIds.length > 0" class="active-count">{{ busyWorkerIds.length }} 活跃</span>
        </div>
        <div class="logs-container" :class="`grid-${visibleCount}`">
          <LogPanel
            v-for="i in 4"
            v-show="busyWorkerIds.length === 0 || busyWorkerIds.includes(i)"
            :key="i"
            :worker-id="i"
            class="log-panel-item"
            @send-to-worker="handleSendToWorker"
            @kill-worker="handleKillWorker"
          />
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background-color: var(--vscode-bg, #1e1e1e);
  color: var(--vscode-fore-text, #dcdcdc);
  overflow: hidden;
}

/* Header - Slim Title Bar */
.app-header {
  height: 35px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background-color: var(--vscode-bg, #2d2d30);
  border-bottom: 1px solid var(--vscode-border, #333);
  user-select: none;
}

.app-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--vscode-fore-text-dim, #969696);
}

.connection-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--vscode-fore-text-dim, #969696);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: var(--vscode-fore-text-dim, #666);
}

.status-dot.open {
  background-color: var(--vscode-accent-green, #3c783c);
}
.status-dot.connecting {
  background-color: var(--vscode-accent-orange, #c88c32);
}
.status-dot.closed,
.status-dot.error {
  background-color: var(--vscode-accent-red, #cd4646);
}

/* Main Content */
.app-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
  min-height: 0;
}

.section-control {
  flex-shrink: 0;
  padding: 10px 16px;
  background-color: var(--vscode-bg, #2d2d30);
  border-bottom: 1px solid var(--vscode-border, #333);
}

.section-status {
  flex-shrink: 0;
  padding: 4px 16px;
  background-color: var(--vscode-panel-bg, #252526);
  border-bottom: 1px solid var(--vscode-border, #333);
}

.section-table {
  flex: 0 1 auto;
  max-height: 30%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 0;
  min-height: 120px;
}

.section-issues {
  flex: 0 0 auto;
  max-height: 25%;
  min-height: 100px;
  overflow: hidden;
  border-top: 1px solid var(--vscode-border, #333);
}

/* Logs Section */
.section-logs {
  flex: 1;
  min-height: 200px;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--vscode-border, #333);
  background-color: var(--vscode-panel-bg, #252526);
}

.logs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 16px;
  font-size: 11px;
  font-weight: bold;
  color: var(--vscode-fore-text-dim, #969696);
  border-bottom: 1px solid var(--vscode-border, #333);
  text-transform: uppercase;
}

.active-count {
  color: var(--vscode-accent-green, #3c783c);
  font-weight: normal;
}

.logs-container {
  flex: 1;
  display: grid;
  gap: 1px;
  background-color: var(--vscode-border, #333);
  overflow: hidden;
  min-height: 0;
}

/* Dynamic grid layouts */
.logs-container.grid-1 {
  grid-template-columns: 1fr;
  grid-template-rows: 1fr;
}

.logs-container.grid-2 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr;
}

.logs-container.grid-3 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
}

.logs-container.grid-4 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
}

.log-panel-item {
  min-width: 0;
  min-height: 0;
  background-color: var(--vscode-input-bg, #1e1e1e);
}
</style>
