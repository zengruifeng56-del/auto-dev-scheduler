<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { Setting } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import type { WatchdogConfigPayload, AutoRetryConfigPayload } from '../../shared/electron-api.d';

const visible = ref(false);
const loading = ref(false);

const config = ref<WatchdogConfigPayload>({
  checkIntervalMs: 5 * 60_000,
  activityTimeoutMs: 10 * 60_000,
  slowToolTimeouts: {
    codex: 60 * 60_000,
    gemini: 60 * 60_000,
    npmInstall: 15 * 60_000,
    npmBuild: 20 * 60_000,
    default: 10 * 60_000
  }
});

const autoRetryConfig = ref<AutoRetryConfigPayload>({
  enabled: true,
  maxRetries: 2,
  baseDelayMs: 5_000
});

// Convert ms to minutes for display
const checkIntervalMinutes = computed({
  get: () => Math.round(config.value.checkIntervalMs / 60_000),
  set: (v: number) => { config.value.checkIntervalMs = v * 60_000; }
});

const activityTimeoutMinutes = computed({
  get: () => Math.round(config.value.activityTimeoutMs / 60_000),
  set: (v: number) => { config.value.activityTimeoutMs = v * 60_000; }
});

const codexTimeoutMinutes = computed({
  get: () => Math.round(config.value.slowToolTimeouts.codex / 60_000),
  set: (v: number) => { config.value.slowToolTimeouts.codex = v * 60_000; }
});

const geminiTimeoutMinutes = computed({
  get: () => Math.round(config.value.slowToolTimeouts.gemini / 60_000),
  set: (v: number) => { config.value.slowToolTimeouts.gemini = v * 60_000; }
});

const npmInstallTimeoutMinutes = computed({
  get: () => Math.round(config.value.slowToolTimeouts.npmInstall / 60_000),
  set: (v: number) => { config.value.slowToolTimeouts.npmInstall = v * 60_000; }
});

const npmBuildTimeoutMinutes = computed({
  get: () => Math.round(config.value.slowToolTimeouts.npmBuild / 60_000),
  set: (v: number) => { config.value.slowToolTimeouts.npmBuild = v * 60_000; }
});

const defaultTimeoutMinutes = computed({
  get: () => Math.round(config.value.slowToolTimeouts.default / 60_000),
  set: (v: number) => { config.value.slowToolTimeouts.default = v * 60_000; }
});

// Auto-retry config: convert ms to seconds for display
const baseDelaySeconds = computed({
  get: () => Math.round(autoRetryConfig.value.baseDelayMs / 1000),
  set: (v: number) => { autoRetryConfig.value.baseDelayMs = v * 1000; }
});

const loadConfig = async () => {
  loading.value = true;
  try {
    const [watchdogLoaded, retryLoaded] = await Promise.all([
      window.electronAPI.getWatchdogConfig(),
      window.electronAPI.getAutoRetryConfig()
    ]);
    config.value = watchdogLoaded;
    autoRetryConfig.value = retryLoaded;
  } catch {
    ElMessage.error('加载配置失败');
  } finally {
    loading.value = false;
  }
};

const saveConfig = async () => {
  loading.value = true;
  try {
    await Promise.all([
      window.electronAPI.setWatchdogConfig(config.value),
      window.electronAPI.setAutoRetryConfig(autoRetryConfig.value)
    ]);
    ElMessage.success('配置已保存');
    visible.value = false;
  } catch {
    ElMessage.error('保存配置失败');
  } finally {
    loading.value = false;
  }
};

const openDialog = () => {
  visible.value = true;
  // loadConfig() will be called by watch(visible) - no need to call twice
};

watch(visible, (v) => {
  if (v) loadConfig();
});
</script>

<template>
  <el-button size="small" @click="openDialog" title="健康监控设置">
    <el-icon><Setting /></el-icon>
  </el-button>

  <el-dialog
    v-model="visible"
    title="健康监控设置"
    width="480px"
    :close-on-click-modal="false"
  >
    <el-form label-width="140px" :disabled="loading" class="settings-form">
      <el-divider content-position="left">自动重试</el-divider>

      <el-form-item label="启用自动重试">
        <el-switch v-model="autoRetryConfig.enabled" />
      </el-form-item>

      <el-form-item label="最大重试次数">
        <el-input-number
          v-model="autoRetryConfig.maxRetries"
          :min="0"
          :max="10"
          :step="1"
          :disabled="!autoRetryConfig.enabled"
        />
        <span class="unit">次</span>
      </el-form-item>

      <el-form-item label="基础延迟">
        <el-input-number
          v-model="baseDelaySeconds"
          :min="1"
          :max="300"
          :step="5"
          :disabled="!autoRetryConfig.enabled"
        />
        <span class="unit">秒</span>
        <el-tooltip content="指数退避：第N次重试延迟 = 基础延迟 × 2^(N-1) + 随机抖动">
          <el-icon class="help-icon"><QuestionFilled /></el-icon>
        </el-tooltip>
      </el-form-item>

      <el-divider content-position="left">基本设置</el-divider>

      <el-form-item label="检查间隔">
        <el-input-number
          v-model="checkIntervalMinutes"
          :min="1"
          :max="60"
          :step="1"
        />
        <span class="unit">分钟</span>
      </el-form-item>

      <el-form-item label="活动超时">
        <el-input-number
          v-model="activityTimeoutMinutes"
          :min="1"
          :max="120"
          :step="1"
        />
        <span class="unit">分钟</span>
        <el-tooltip content="Worker 无活动超过此时间将触发诊断">
          <el-icon class="help-icon"><QuestionFilled /></el-icon>
        </el-tooltip>
      </el-form-item>

      <el-divider content-position="left">慢操作超时阈值</el-divider>

      <el-form-item label="Codex/Gemini">
        <el-input-number
          v-model="codexTimeoutMinutes"
          :min="10"
          :max="180"
          :step="5"
        />
        <span class="unit">分钟</span>
      </el-form-item>

      <el-form-item>
        <template #label>
          <span style="visibility: hidden">Gemini</span>
        </template>
        <el-input-number
          v-model="geminiTimeoutMinutes"
          :min="10"
          :max="180"
          :step="5"
        />
        <span class="unit">分钟 (Gemini)</span>
      </el-form-item>

      <el-form-item label="npm install">
        <el-input-number
          v-model="npmInstallTimeoutMinutes"
          :min="5"
          :max="60"
          :step="5"
        />
        <span class="unit">分钟</span>
      </el-form-item>

      <el-form-item label="npm build">
        <el-input-number
          v-model="npmBuildTimeoutMinutes"
          :min="5"
          :max="60"
          :step="5"
        />
        <span class="unit">分钟</span>
      </el-form-item>

      <el-form-item label="其他工具">
        <el-input-number
          v-model="defaultTimeoutMinutes"
          :min="1"
          :max="60"
          :step="1"
        />
        <span class="unit">分钟</span>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="loading" @click="saveConfig">
        保存
      </el-button>
    </template>
  </el-dialog>
</template>

<script lang="ts">
import { QuestionFilled } from '@element-plus/icons-vue';
export default {
  components: { QuestionFilled }
};
</script>

<style scoped lang="scss">
.settings-form {
  .unit {
    margin-left: 8px;
    color: var(--vscode-fore-text-dim);
    font-size: 13px;
  }

  .help-icon {
    margin-left: 8px;
    color: var(--vscode-fore-text-dim);
    cursor: help;
  }

  :deep(.el-divider__text) {
    font-size: 13px;
    color: var(--vscode-fore-text-dim);
  }
}
</style>
