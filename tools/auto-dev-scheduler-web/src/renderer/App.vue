<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { ElDialog } from 'element-plus';
import { ArrowDown, ArrowUp } from '@element-plus/icons-vue';
import { useSchedulerStore } from './stores/scheduler';

import ControlCard from './components/ControlCard.vue';
import ProgressCard from './components/ProgressCard.vue';
import WavesCard from './components/WavesCard.vue';
import TaskCards from './components/TaskCards.vue';
import LogPanel from './components/LogPanel.vue';
import IssuesPanel from './components/IssuesPanel.vue';
import BlockerOverlay from './components/BlockerOverlay.vue';
import ApiErrorOverlay from './components/ApiErrorOverlay.vue';
import SettingsDialog from './components/SettingsDialog.vue';

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

const showIssuesDialog = ref(false);
const bottomExpanded = ref(true);

onMounted(() => {
  const saved = localStorage.getItem('dashboard-bottom-expanded');
  if (saved !== null) {
    bottomExpanded.value = saved === 'true';
  }
  store.init();
});

onUnmounted(() => {
  store.cleanup();
});

function toggleBottom() {
  bottomExpanded.value = !bottomExpanded.value;
  localStorage.setItem('dashboard-bottom-expanded', String(bottomExpanded.value));
}

function handleWaveClick(wave: number) {
  console.log('Wave clicked:', wave);
}

function openIssuesDialog() {
  showIssuesDialog.value = true;
}

function handleSendToWorker(workerId: number, content: string) {
  store.sendToWorker(workerId, content);
}

function handleKillWorker(workerId: number) {
  store.killWorker(workerId);
}
</script>

<template>
  <div class="dashboard-layout">
    <!-- Top Bar -->
    <header class="dashboard-header">
      <div class="header-left">
        <span class="app-title">Auto-Dev Scheduler</span>
        <div class="connection-status">
          <span class="status-dot" :class="connectionStatusClass" />
          <span class="status-text">{{ connectionStatusDisplay }}</span>
        </div>
      </div>
      <div class="header-right">
        <el-button
          size="small"
          @click="openIssuesDialog"
          :type="store.openIssueCount > 0 ? 'warning' : 'default'"
          v-if="store.openIssueCount > 0"
        >
          ⚠ {{ store.openIssueCount }} 问题
        </el-button>
        <SettingsDialog />
      </div>
    </header>

    <!-- Top Cards Row -->
    <section class="top-cards">
      <ControlCard @open-issues="openIssuesDialog" />
      <ProgressCard />
    </section>

    <!-- Main Content: Sidebar + Terminals -->
    <main class="main-content">
      <!-- Left Sidebar: Waves -->
      <aside class="sidebar">
        <WavesCard @wave-click="handleWaveClick" />
      </aside>

      <!-- Center: Log Panels (Primary Area) -->
      <section class="terminals-area">
        <div class="terminals-grid" :class="`grid-${visibleCount}`">
          <LogPanel
            v-for="i in 4"
            v-show="busyWorkerIds.length === 0 || busyWorkerIds.includes(i)"
            :key="i"
            :worker-id="i"
            class="terminal-panel"
            @send-to-worker="handleSendToWorker"
            @kill-worker="handleKillWorker"
          />
        </div>
      </section>
    </main>

    <!-- Bottom: Task Cards (Collapsible) -->
    <section class="bottom-section" :class="{ collapsed: !bottomExpanded }">
      <div class="bottom-header" @click="toggleBottom">
        <div class="bottom-header-left">
          <el-icon class="toggle-icon">
            <ArrowUp v-if="bottomExpanded" />
            <ArrowDown v-else />
          </el-icon>
          <span class="bottom-title">任务列表</span>
          <span class="task-count">{{ store.progress.completed }}/{{ store.progress.total }}</span>
        </div>
      </div>
      <div v-show="bottomExpanded" class="bottom-content">
        <TaskCards />
      </div>
    </section>

    <!-- Overlays -->
    <BlockerOverlay />
    <ApiErrorOverlay />

    <!-- Issues Dialog -->
    <ElDialog v-model="showIssuesDialog" title="问题列表" width="80%" :append-to-body="true">
      <div class="issues-dialog-content">
        <IssuesPanel />
      </div>
    </ElDialog>
  </div>
</template>

<style scoped lang="scss">
.dashboard-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background-color: var(--vscode-bg);
  color: var(--vscode-fore-text);
  overflow: hidden;
}

.dashboard-header {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: var(--vscode-panel-bg);
  border-bottom: 1px solid var(--vscode-border);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.app-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-fore-text);
}

.connection-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--vscode-fore-text-dim);
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--vscode-fore-text-dim);

  &.open { background: var(--vscode-accent-green); }
  &.closed { background: var(--vscode-accent-red); }
}

.top-cards {
  flex-shrink: 0;
  display: flex;
  gap: 12px;
  padding: 12px 16px;
  background: var(--vscode-bg);
}

.main-content {
  flex: 1;
  display: flex;
  gap: 12px;
  padding: 0 16px;
  min-height: 0;
  overflow: hidden;
}

.sidebar {
  flex: 0 0 180px;
  min-height: 0;
  background: var(--card-bg);
  border-radius: var(--card-radius);
  border: 1px solid var(--card-border);
  box-shadow: var(--card-shadow);
}

.terminals-area {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--card-bg);
  border-radius: var(--card-radius);
  border: 1px solid var(--card-border);
  box-shadow: var(--card-shadow);
  padding: 8px;
}

.terminals-grid {
  flex: 1;
  display: grid;
  gap: 1px;
  background: var(--vscode-border);
  border-radius: 8px;
  overflow: hidden;
  min-height: 0;
}

.terminals-grid.grid-1 {
  grid-template-columns: 1fr;
  grid-template-rows: 1fr;
}

.terminals-grid.grid-2 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr;
}

.terminals-grid.grid-3,
.terminals-grid.grid-4 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
}

.terminal-panel {
  min-width: 0;
  min-height: 0;
}

.bottom-section {
  flex: 0 0 140px;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--vscode-border);
  background: var(--vscode-bg);
  transition: flex-basis 0.2s ease;
}

.bottom-section.collapsed {
  flex-basis: 32px;
}

.bottom-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 16px;
  background: var(--card-bg);
  cursor: pointer;
  user-select: none;

  &:hover {
    background: var(--vscode-panel-bg-hover);
  }
}

.bottom-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toggle-icon {
  font-size: 12px;
  color: var(--vscode-fore-text-dim);
}

.bottom-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--card-title-color);
}

.task-count {
  font-size: 11px;
  color: var(--vscode-fore-text-dim);
}

.bottom-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.issues-dialog-content {
  height: 60vh;
  overflow: hidden;
}
</style>
