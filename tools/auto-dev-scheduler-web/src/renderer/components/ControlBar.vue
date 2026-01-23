<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
  FolderOpened,
  VideoPlay,
  VideoPause,
  CircleCloseFilled,
  Document,
  Warning,
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

const emit = defineEmits<{ (e: 'open-issues'): void }>();

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
    <!-- Single Row: All Controls -->
    <div class="control-row">
      <!-- File Path Input -->
      <div class="file-group">
        <el-input
          v-model="fileInput"
          placeholder="AUTO-DEV.md 路径..."
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
            <el-button :disabled="!canLoadFile" @click="handleLoadFile" title="加载任务文件">
              <el-icon><FolderOpened /></el-icon>
            </el-button>
          </template>
        </el-input>
      </div>

      <!-- Concurrency -->
      <div class="control-group compact">
        <el-select
          v-model="concurrency"
          size="small"
          style="width: 58px"
          :disabled="store.running"
          placeholder="并发"
        >
          <el-option v-for="n in 4" :key="n" :label="`${n}线程`" :value="n" />
        </el-select>
      </div>

      <!-- Action Buttons -->
      <div class="control-group actions">
        <el-button
          type="primary"
          size="small"
          :disabled="!canStart"
          @click="handleStart"
          title="开始执行"
        >
          <el-icon><VideoPlay /></el-icon>
        </el-button>

        <el-button
          :type="store.paused ? 'success' : 'warning'"
          size="small"
          :disabled="!canPauseResume"
          @click="togglePause"
          :title="store.paused ? '继续' : '暂停'"
        >
          <el-icon v-if="store.paused"><VideoPlay /></el-icon>
          <el-icon v-else><VideoPause /></el-icon>
        </el-button>

        <el-button
          type="danger"
          size="small"
          :disabled="!canStop"
          @click="handleStop"
          title="全部停止"
        >
          <el-icon><CircleCloseFilled /></el-icon>
        </el-button>
      </div>

      <!-- Progress -->
      <div class="progress-group">
        <span class="progress-text">{{ store.progress.completed }}/{{ store.progress.total }}</span>
        <el-progress
          :percentage="store.progressPercent"
          :stroke-width="8"
          :show-text="false"
          class="progress-bar"
        />
        <span class="percentage">{{ store.progressPercent }}%</span>
      </div>

      <!-- Issues Button -->
      <el-button
        size="small"
        @click="emit('open-issues')"
        title="查看问题列表"
        :type="store.openIssueCount > 0 ? 'warning' : 'default'"
        :class="{ 'has-issues': store.openIssueCount > 0 }"
      >
        <el-icon><Warning /></el-icon>
        <span v-if="store.openIssueCount > 0" class="issue-badge">{{ store.openIssueCount }}</span>
      </el-button>

      <!-- Export & Settings -->
      <el-button size="small" :disabled="!canExportLogs" @click="handleExportLogs" title="导出日志">
        <el-icon><Document /></el-icon>
      </el-button>

      <SettingsDialog />

      <!-- Font Size (Compact) -->
      <div class="font-control">
        <el-button size="small" :disabled="!canDecreaseFontSize" @click="adjustFontSize(-1)" title="缩小字体">
          <el-icon><Minus /></el-icon>
        </el-button>
        <el-button size="small" :disabled="!canIncreaseFontSize" @click="adjustFontSize(1)" title="放大字体">
          <el-icon><Plus /></el-icon>
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.control-bar {
  display: flex;
  flex-direction: column;
  padding: 0;
}

.control-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.control-group {
  display: flex;
  align-items: center;
  gap: 4px;
}

.control-group.compact {
  gap: 0;
}

.file-group {
  display: flex;
  align-items: center;
  flex: 0 1 320px;
  min-width: 180px;
}

.actions {
  gap: 4px;
}

.issue-badge {
  margin-left: 2px;
  padding: 0 5px;
  min-width: 16px;
  height: 16px;
  line-height: 16px;
  border-radius: 8px;
  background-color: #fff;
  color: var(--vscode-accent-orange, #c88c32);
  font-size: 10px;
  font-weight: 700;
}

.has-issues {
  animation: pulse-warning 2s infinite;
}

@keyframes pulse-warning {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

.font-control {
  display: flex;
  gap: 2px;
  margin-left: 4px;
}

.progress-group {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 1 160px;
  min-width: 100px;

  .progress-text {
    font-size: 11px;
    color: var(--vscode-fore-text-dim);
    white-space: nowrap;
  }

  .progress-bar {
    flex: 1;
    min-width: 60px;
  }

  .percentage {
    min-width: 32px;
    text-align: right;
    font-size: 11px;
    color: var(--vscode-fore-text);
  }
}
</style>
