<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
  Search,
  FolderOpened,
  VideoPlay,
  VideoPause,
  CircleCloseFilled,
  Warning,
  Download
} from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { useSchedulerStore } from '../stores/scheduler';

const emit = defineEmits<{ (e: 'open-issues'): void }>();

const store = useSchedulerStore();
const concurrency = ref(2);
const fileInput = ref('');
const browseLoading = ref(false);

const openSystemFileDialog = async () => {
  if (browseLoading.value || store.running) return;
  browseLoading.value = true;
  try {
    const filePath = await window.electronAPI.openFileDialog();
    if (filePath) {
      fileInput.value = filePath;
      await store.loadFile(filePath);
    }
  } catch {
    ElMessage.error('打开文件对话框失败');
  } finally {
    browseLoading.value = false;
  }
};

watch(
  () => store.filePath,
  (newPath, oldPath) => {
    if (fileInput.value.trim() === '' || fileInput.value === oldPath) {
      fileInput.value = newPath;
    }
  },
  { immediate: true }
);

const isIpcReady = computed(() => store.ipcReady);
const canLoadFile = computed(
  () => isIpcReady.value && !store.running && fileInput.value.trim().length > 0
);
const canStart = computed(
  () => isIpcReady.value && Boolean(store.filePath) && !store.running
);
const canPauseResume = computed(() => isIpcReady.value && store.running);
const canStop = computed(() => isIpcReady.value && store.running);

const handleLoadFile = () => {
  if (!isIpcReady.value || store.running) return;
  const path = fileInput.value.trim();
  if (!path) return;
  store.loadFile(path);
};

const handleStart = () => {
  if (!canStart.value) return;
  const maxParallel = Math.min(4, Math.max(1, Math.floor(concurrency.value)));
  store.start(maxParallel);
};

const togglePause = () => {
  if (!canPauseResume.value) return;
  if (store.paused) store.resume();
  else store.pause();
};

const handleStop = () => {
  if (!canStop.value) return;
  store.stop();
};

const handleExportLogs = () => {
  store.exportLogs();
  ElMessage.success('日志导出中...');
};
</script>

<template>
  <div class="control-card card">
    <div class="card-title">控制面板</div>
    <div class="card-content">
      <!-- File Input -->
      <div class="file-group">
        <el-input
          v-model="fileInput"
          placeholder="AUTO-DEV.md"
          size="small"
          :disabled="store.running"
          @keyup.enter="handleLoadFile"
        >
          <template #prepend>
            <el-button
              :disabled="store.running || browseLoading"
              :loading="browseLoading"
              @click="openSystemFileDialog"
              title="浏览"
            >
              <el-icon v-if="!browseLoading"><Search /></el-icon>
            </el-button>
          </template>
          <template #append>
            <el-button :disabled="!canLoadFile" @click="handleLoadFile" title="加载">
              <el-icon><FolderOpened /></el-icon>
            </el-button>
          </template>
        </el-input>
      </div>

      <!-- Action Buttons -->
      <div class="action-group">
        <el-button
          type="primary"
          size="default"
          :disabled="!canStart"
          @click="handleStart"
          title="开始"
        >
          <el-icon><VideoPlay /></el-icon>
          <span>开始</span>
        </el-button>

        <el-button
          :type="store.paused ? 'success' : 'warning'"
          size="default"
          :disabled="!canPauseResume"
          @click="togglePause"
          :title="store.paused ? '继续' : '暂停'"
        >
          <el-icon v-if="store.paused"><VideoPlay /></el-icon>
          <el-icon v-else><VideoPause /></el-icon>
          <span>{{ store.paused ? '继续' : '暂停' }}</span>
        </el-button>

        <el-button
          type="danger"
          size="default"
          :disabled="!canStop"
          @click="handleStop"
          title="停止"
        >
          <el-icon><CircleCloseFilled /></el-icon>
          <span>停止</span>
        </el-button>
      </div>

      <!-- Issues Button -->
      <el-button
        size="default"
        @click="emit('open-issues')"
        :type="store.openIssueCount > 0 ? 'warning' : 'default'"
      >
        <el-icon><Warning /></el-icon>
        <span>问题</span>
        <el-badge v-if="store.openIssueCount > 0" :value="store.openIssueCount" class="issue-badge" />
      </el-button>

      <!-- Export Logs Button -->
      <el-button
        size="default"
        @click="handleExportLogs"
        title="导出日志"
      >
        <el-icon><Download /></el-icon>
        <span>导出</span>
      </el-button>

      <!-- Concurrency -->
      <div class="concurrency-group">
        <span class="concurrency-label">并发:</span>
        <el-select
          v-model="concurrency"
          size="default"
          :disabled="store.running"
          class="concurrency-select"
        >
          <el-option v-for="n in 4" :key="n" :label="`${n} 线程`" :value="n" />
        </el-select>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.control-card {
  flex: 1;
  min-width: 0;
}

.card-content {
  display: flex;
  align-items: center;
  gap: 12px;
}

.file-group {
  flex: 1;
  min-width: 120px;
  max-width: 280px;
}

.action-group {
  display: flex;
  gap: 8px;

  .el-button {
    min-width: 70px;
    padding: 8px 16px;
  }
}

.concurrency-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.concurrency-label {
  font-size: 12px;
  color: var(--vscode-fore-text-dim);
  white-space: nowrap;
}

.concurrency-select {
  width: 90px;
}

.issue-badge {
  margin-left: 4px;
}
</style>
