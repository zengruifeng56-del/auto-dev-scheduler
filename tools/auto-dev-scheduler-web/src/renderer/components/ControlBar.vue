<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
  FolderOpened,
  VideoPlay,
  VideoPause,
  CircleCloseFilled,
  Document,
  Plus,
  Minus,
  Search
} from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { useSchedulerStore } from '../stores/scheduler';
import SettingsDialog from './SettingsDialog.vue';

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

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 24;

// Sync fileInput with store.filePath when loaded
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
const canExportLogs = computed(() => isIpcReady.value);
const canDecreaseFontSize = computed(() => store.fontSize > MIN_FONT_SIZE);
const canIncreaseFontSize = computed(() => store.fontSize < MAX_FONT_SIZE);

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
  if (!canExportLogs.value) return;
  store.exportLogs();
};

const adjustFontSize = (delta: number) => {
  const newSize = store.fontSize + delta;
  if (newSize >= MIN_FONT_SIZE && newSize <= MAX_FONT_SIZE) {
    store.setFontSize(newSize);
  }
};
</script>

<template>
  <div class="control-bar">
    <!-- Row 1: File Selection & Concurrency & Actions -->
    <div class="control-row">
      <!-- File Path Input -->
      <div class="file-group">
        <span class="label">任务文件:</span>
        <el-input
          v-model="fileInput"
          placeholder="输入 AUTO-DEV.md 路径..."
          size="small"
          :disabled="store.running"
          @keyup.enter="handleLoadFile"
        >
          <template #prepend>
            <el-button
              :disabled="store.running || browseLoading"
              :loading="browseLoading"
              @click="openSystemFileDialog"
              title="浏览文件"
            >
              <el-icon v-if="!browseLoading"><Search /></el-icon>
            </el-button>
          </template>
          <template #append>
            <el-button :disabled="!canLoadFile" @click="handleLoadFile">
              <el-icon><FolderOpened /></el-icon>
              <span style="margin-left: 4px">加载</span>
            </el-button>
          </template>
        </el-input>
      </div>

      <!-- Concurrency -->
      <div class="control-group">
        <span class="label">并发:</span>
        <el-select
          v-model="concurrency"
          size="small"
          style="width: 70px"
          :disabled="store.running"
        >
          <el-option v-for="n in 4" :key="n" :label="n" :value="n" />
        </el-select>
      </div>

      <!-- Action Buttons -->
      <div class="control-group actions">
        <el-button
          type="primary"
          size="small"
          :disabled="!canStart"
          @click="handleStart"
        >
          <el-icon><VideoPlay /></el-icon>
          开始
        </el-button>

        <el-button
          :type="store.paused ? 'success' : 'warning'"
          size="small"
          :disabled="!canPauseResume"
          @click="togglePause"
        >
          <el-icon v-if="store.paused"><VideoPlay /></el-icon>
          <el-icon v-else><VideoPause /></el-icon>
          {{ store.paused ? '继续' : '暂停' }}
        </el-button>

        <el-button
          type="danger"
          size="small"
          :disabled="!canStop"
          @click="handleStop"
        >
          <el-icon><CircleCloseFilled /></el-icon>
          全部停止
        </el-button>
      </div>

      <!-- Export Logs -->
      <el-button size="small" :disabled="!canExportLogs" @click="handleExportLogs">
        <el-icon><Document /></el-icon>
        <span style="margin-left: 4px">导出日志</span>
      </el-button>

      <!-- Settings -->
      <SettingsDialog />
    </div>

    <!-- Row 2: Progress & Font Control -->
    <div class="control-row status-row">
      <!-- Font Size -->
      <div class="control-group font-control">
        <span class="label">字体:</span>
        <el-button-group>
          <el-button
            size="small"
            :disabled="!canDecreaseFontSize"
            @click="adjustFontSize(-1)"
          >
            <el-icon><Minus /></el-icon>
          </el-button>
          <div class="font-display">{{ store.fontSize }}</div>
          <el-button
            size="small"
            :disabled="!canIncreaseFontSize"
            @click="adjustFontSize(1)"
          >
            <el-icon><Plus /></el-icon>
          </el-button>
        </el-button-group>
      </div>

      <!-- Progress -->
      <div class="progress-group">
        <span class="label">进度: {{ store.progress.completed }}/{{ store.progress.total }}</span>
        <el-progress
          :percentage="store.progressPercent"
          :stroke-width="12"
          :show-text="false"
          class="progress-bar"
        />
        <span class="percentage">{{ store.progressPercent }}%</span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.control-bar {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.control-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.status-row {
  justify-content: space-between;
}

.control-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.label {
  color: var(--vscode-fore-text-dim);
  font-size: 13px;
  white-space: nowrap;
}

.file-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 280px;
  max-width: 500px;
}

.actions {
  gap: 6px;
}

// Font control styling
.font-control {
  .el-button-group {
    display: flex;
    align-items: center;
  }

  .font-display {
    padding: 0 10px;
    min-width: 28px;
    text-align: center;
    font-size: 12px;
    line-height: 24px;
    background-color: var(--vscode-input-bg);
    border-top: 1px solid var(--vscode-border);
    border-bottom: 1px solid var(--vscode-border);
  }
}

// Progress styling
.progress-group {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  justify-content: flex-end;

  .progress-bar {
    width: 200px;
    max-width: 300px;
  }

  .percentage {
    min-width: 40px;
    text-align: right;
    font-size: 12px;
  }
}
</style>
