<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElDialog } from 'element-plus';

import { useSchedulerStore } from '../stores/scheduler';
import type { LogEntry, WorkerState } from '@shared/types';

const ROW_HEIGHT = 20;
const OVERSCAN = 6;
const MAX_INPUT_HEIGHT = 96;
const HISTORY_LIMIT = 50;

const props = defineProps<{
  workerId: number;
}>();

const emit = defineEmits<{
  (e: 'send-to-worker', workerId: number, content: string): void;
  (e: 'kill-worker', workerId: number): void;
}>();

const store = useSchedulerStore();

const worker = computed<WorkerState | null>(() => store.workers.get(props.workerId) ?? null);
const logs = computed<LogEntry[]>(() => worker.value?.logs ?? []);

const fontSize = computed(() => store.fontSize);
const isIpcReady = computed(() => store.ipcReady);

const isActive = computed(() => worker.value?.active ?? false);
const canInteract = computed(() => isIpcReady.value && isActive.value);

const taskId = computed(() => worker.value?.taskId ?? '');
const tokenUsage = computed(() => worker.value?.tokenUsage ?? '');
const currentTool = computed(() => worker.value?.currentTool ?? '');

const viewportRef = ref<HTMLDivElement | null>(null);
const viewportHeight = ref(0);
const scrollTop = ref(0);

const follow = ref(true);
const unreadCount = ref(0);

const totalCount = computed(() => logs.value.length);
const totalHeight = computed(() => totalCount.value * ROW_HEIGHT);

const atBottom = computed(() => {
  const distance = totalHeight.value - (scrollTop.value + viewportHeight.value);
  return distance <= ROW_HEIGHT;
});

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const visibleRange = computed(() => {
  const count = totalCount.value;
  if (count === 0) return { start: 0, end: 0 };

  const start = clamp(Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN, 0, count - 1);
  const end = clamp(
    Math.ceil((scrollTop.value + viewportHeight.value) / ROW_HEIGHT) + OVERSCAN,
    0,
    count
  );

  return { start, end };
});

const translateY = computed(() => visibleRange.value.start * ROW_HEIGHT);

function normalizeInline(content: string): string {
  return content.replace(/\r?\n/g, ' ');
}

const visibleItems = computed(() => {
  const { start, end } = visibleRange.value;
  const slice = logs.value.slice(start, end);
  return slice.map((entry, offset) => ({
    entry,
    key: `${props.workerId}-${start + offset}`,
    inline: normalizeInline(entry.content)
  }));
});

function syncViewportMetrics() {
  const el = viewportRef.value;
  if (!el) return;
  viewportHeight.value = el.clientHeight;
  scrollTop.value = el.scrollTop;
}

let scrollRafId = 0;
function onViewportScroll() {
  const el = viewportRef.value;
  if (!el) return;
  if (scrollRafId) return;

  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = 0;
    syncViewportMetrics();

    if (follow.value && !atBottom.value) {
      follow.value = false;
    }
    if (atBottom.value) {
      unreadCount.value = 0;
    }
  });
}

async function scrollToBottom() {
  await nextTick();
  const el = viewportRef.value;
  if (!el) return;

  const top = Math.max(0, totalHeight.value - el.clientHeight);
  el.scrollTop = top;
  scrollTop.value = top;
  unreadCount.value = 0;
}

function jumpToBottom() {
  void scrollToBottom();
}

function toggleFollow() {
  follow.value = !follow.value;
  if (follow.value) {
    void scrollToBottom();
  }
}

const canKill = computed(() => canInteract.value);

function requestKill() {
  if (!canKill.value) return;
  if (!confirm(`确定要终止工作进程 ${props.workerId} 吗？`)) return;
  emit('kill-worker', props.workerId);
}

const inputRef = ref<HTMLTextAreaElement | null>(null);
const inputValue = ref('');
const history = ref<string[]>([]);
const historyCursor = ref<number>(-1);

const canSend = computed(() => canInteract.value && inputValue.value.trim().length > 0);

function focusInput() {
  inputRef.value?.focus();
}

function pushHistory(content: string) {
  const trimmed = content.trim();
  if (!trimmed) return;

  const last = history.value.length > 0 ? history.value[history.value.length - 1] : '';
  if (last !== trimmed) {
    history.value.push(trimmed);
    if (history.value.length > HISTORY_LIMIT) history.value.shift();
  }
  historyCursor.value = -1;
}

function setInputFromHistory(nextCursor: number) {
  if (nextCursor < 0 || nextCursor >= history.value.length) return;
  historyCursor.value = nextCursor;
  inputValue.value = history.value[nextCursor];

  void nextTick(() => {
    const el = inputRef.value;
    if (!el) return;
    const len = el.value.length;
    el.setSelectionRange(len, len);
    syncInputHeight();
  });
}

function historyPrev() {
  if (history.value.length === 0) return;
  if (historyCursor.value === -1) {
    setInputFromHistory(history.value.length - 1);
    return;
  }
  setInputFromHistory(Math.max(0, historyCursor.value - 1));
}

function historyNext() {
  if (history.value.length === 0) return;
  if (historyCursor.value === -1) return;

  const next = historyCursor.value + 1;
  if (next >= history.value.length) {
    historyCursor.value = -1;
    inputValue.value = '';
    void nextTick(syncInputHeight);
    return;
  }
  setInputFromHistory(next);
}

function send() {
  if (!canInteract.value) return;

  const content = inputValue.value.trim();
  if (!content) return;

  emit('send-to-worker', props.workerId, content);

  pushHistory(content);
  inputValue.value = '';
  historyCursor.value = -1;

  void nextTick(() => {
    syncInputHeight();
    focusInput();
  });
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

function onPanelKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    focusInput();
    return;
  }

  if (e.key === 'End' && !isEditableTarget(e.target)) {
    e.preventDefault();
    jumpToBottom();
    return;
  }
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    const shouldSend = e.ctrlKey || e.metaKey || !e.shiftKey;
    if (shouldSend) {
      e.preventDefault();
      send();
      return;
    }
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    (e.target as HTMLTextAreaElement).blur();
    return;
  }

  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    inputValue.value = '';
    historyCursor.value = -1;
    void nextTick(syncInputHeight);
    return;
  }

  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    const el = e.target as HTMLTextAreaElement;
    const isSingleLine = !inputValue.value.includes('\n');

    if (isSingleLine && e.key === 'ArrowUp' && el.selectionStart === 0 && el.selectionEnd === 0) {
      e.preventDefault();
      historyPrev();
      return;
    }

    if (
      isSingleLine &&
      e.key === 'ArrowDown' &&
      el.selectionStart === inputValue.value.length &&
      el.selectionEnd === inputValue.value.length
    ) {
      e.preventDefault();
      historyNext();
      return;
    }
  }
}

function syncInputHeight() {
  const el = inputRef.value;
  if (!el) return;
  el.style.height = '0px';
  const next = Math.min(MAX_INPUT_HEIGHT, el.scrollHeight);
  el.style.height = `${next}px`;
}

const detailDialogOpen = ref(false);
const detailEntry = ref<LogEntry | null>(null);

function openDetail(entry: LogEntry) {
  detailEntry.value = entry;
  detailDialogOpen.value = true;
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  syncViewportMetrics();

  const viewportEl = viewportRef.value;
  if (viewportEl) {
    resizeObserver = new ResizeObserver(() => {
      syncViewportMetrics();
    });
    resizeObserver.observe(viewportEl);
  }

  void nextTick(() => {
    syncViewportMetrics();
    syncInputHeight();
    if (follow.value) void scrollToBottom();
  });
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (scrollRafId) cancelAnimationFrame(scrollRafId);
});

watch(
  () => viewportHeight.value,
  () => {
    if (follow.value) void scrollToBottom();
  }
);

watch(
  () => (logs.value.length ? logs.value[logs.value.length - 1] : null),
  (newLast, oldLast) => {
    if (!newLast || newLast === oldLast) return;
    if (follow.value) {
      void scrollToBottom();
    } else {
      unreadCount.value += 1;
    }
  },
  { flush: 'post' }
);

watch(
  () => inputValue.value,
  () => {
    void nextTick(syncInputHeight);
  }
);
</script>

<template>
  <div
    class="log-panel"
    :style="{ '--log-font-size': `${fontSize}px` }"
    tabindex="0"
    @keydown="onPanelKeydown"
  >
    <div class="log-header">
      <div class="header-left">
        <span class="worker-dot" :class="{ active: isActive }" />
        <span class="header-title">{{ taskId || `工作进程 ${workerId}` }}</span>
        <span v-if="tokenUsage" class="header-meta">[{{ tokenUsage }}]</span>
        <span v-if="currentTool" class="header-meta tool">{{ currentTool }}</span>
      </div>

      <div class="header-right">
        <button
          class="header-btn"
          :class="{ active: follow }"
          type="button"
          @click="toggleFollow"
          :title="follow ? '自动滚动: 开' : '自动滚动: 关'"
        >
          AUTO
        </button>

        <button
          v-if="!atBottom"
          class="header-btn jump"
          type="button"
          @click="jumpToBottom"
          :title="unreadCount > 0 ? `跳转到底部 (${unreadCount} 条新消息)` : '跳转到底部'"
        >
          ↓<span v-if="unreadCount > 0" class="unread">{{ unreadCount }}</span>
        </button>

        <button
          class="kill-btn"
          type="button"
          :disabled="!canKill"
          @click="requestKill"
          title="终止进程"
        >✕</button>
      </div>
    </div>

    <div ref="viewportRef" class="log-viewport" @scroll.passive="onViewportScroll">
      <div class="log-spacer" :style="{ height: `${totalHeight}px` }">
        <div class="log-list" :style="{ transform: `translateY(${translateY}px)` }">
          <div
            v-for="item in visibleItems"
            :key="item.key"
            class="log-row"
            :class="`type-${item.entry.type}`"
            @dblclick="openDetail(item.entry)"
          >
            <span class="log-time">[{{ item.entry.ts }}]</span>
            <span class="log-type">[{{ item.entry.type }}]</span>
            <span class="log-content" :title="item.entry.content">{{ item.inline }}</span>
          </div>
        </div>
      </div>

      <div v-if="totalCount === 0" class="log-empty">
        <div class="log-empty-title">等待任务...</div>
        <div class="log-empty-hint">Ctrl+K 聚焦 | Enter 发送 | Shift+Enter 换行</div>
      </div>
    </div>

    <div class="log-input">
      <textarea
        ref="inputRef"
        v-model="inputValue"
        class="input-field"
        rows="1"
        :disabled="!canInteract"
        :placeholder="canInteract ? '发送消息...' : '进程未激活'"
        @keydown="onInputKeydown"
      />
      <button class="send-btn" type="button" :disabled="!canSend" @click="send">发送</button>
    </div>

    <ElDialog v-model="detailDialogOpen" title="日志详情" width="70%" :append-to-body="true">
      <div v-if="detailEntry" class="detail-meta">[{{ detailEntry.ts }}] [{{ detailEntry.type }}]</div>
      <pre class="detail-content">{{ detailEntry ? detailEntry.content : '' }}</pre>
    </ElDialog>
  </div>
</template>

<style scoped>
.log-panel {
  --log-font-size: 12px;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--vscode-input-bg, #1e1e1e);
  overflow: hidden;
}

.log-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  background: var(--vscode-panel-bg, #252526);
  border-bottom: 1px solid var(--vscode-border, #3c3c3c);
  font-size: 12px;
  color: var(--vscode-fore-text, #dcdcdc);
  user-select: none;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
}

.worker-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--vscode-fore-text-dim, #666);
  flex-shrink: 0;
}

.worker-dot.active {
  background: var(--vscode-accent-green, #3c783c);
}

.header-title {
  font-weight: 600;
  flex-shrink: 0;
  color: var(--vscode-accent-blue, #007acc);
}

.header-meta {
  color: var(--vscode-fore-text-dim, #969696);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-meta.tool {
  color: var(--vscode-accent-orange, #c88c32);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.header-btn {
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--vscode-border, #3c3c3c);
  background: transparent;
  color: var(--vscode-fore-text-dim, #969696);
  cursor: pointer;
  font-size: 11px;
  line-height: 18px;
}

.header-btn.active {
  border-color: var(--vscode-accent-blue, #007acc);
  color: var(--vscode-fore-text, #dcdcdc);
  background: rgba(0, 122, 204, 0.15);
}

.header-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.unread {
  margin-left: 4px;
  font-size: 10px;
  color: var(--vscode-accent-orange, #c88c32);
}

.kill-btn {
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--vscode-accent-red, #cd4646);
  cursor: pointer;
  font-size: 14px;
  opacity: 0.85;
  padding: 0;
}

.kill-btn:hover {
  opacity: 1;
}

.kill-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.log-viewport {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: var(--log-font-size);
  background: var(--vscode-input-bg, #1e1e1e);
}

.log-spacer {
  position: relative;
  width: 100%;
}

.log-list {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  will-change: transform;
}

.log-row {
  height: 20px;
  line-height: 20px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  white-space: nowrap;
  cursor: default;
}

.log-row:hover {
  background: var(--vscode-selection, #333334);
}

.log-time {
  color: var(--vscode-fore-text-dim, #808080);
  flex-shrink: 0;
}

.log-type {
  flex-shrink: 0;
  color: var(--vscode-accent-blue, #007acc);
}

.log-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--vscode-fore-text, #dcdcdc);
}

.type-start .log-type { color: var(--vscode-accent-green, #3c783c); }
.type-start .log-content { color: var(--vscode-accent-green, #3c783c); }

.type-tool .log-type { color: var(--vscode-accent-blue, #007acc); }
.type-tool .log-content { color: var(--vscode-accent-blue, #007acc); }

.type-result .log-type { color: var(--vscode-accent-orange, #c88c32); }
.type-result .log-content { color: var(--vscode-accent-orange, #c88c32); }

.type-output .log-type { color: var(--vscode-fore-text, #dcdcdc); }
.type-output .log-content { color: var(--vscode-fore-text, #dcdcdc); }

.type-error .log-type { color: var(--vscode-accent-red, #cd4646); }
.type-error .log-content { color: var(--vscode-accent-red, #cd4646); }

.type-system .log-type { color: var(--vscode-fore-text-dim, #969696); }
.type-system .log-content { color: var(--vscode-fore-text-dim, #969696); }

.log-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--vscode-fore-text-dim, #969696);
  pointer-events: none;
}

.log-empty-title {
  font-size: 13px;
  font-weight: 600;
  opacity: 0.8;
}

.log-empty-hint {
  font-size: 12px;
  opacity: 0.7;
}

.log-input {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  padding: 6px 8px;
  background: var(--vscode-panel-bg, #252526);
  border-top: 1px solid var(--vscode-border, #3c3c3c);
}

.input-field {
  flex: 1;
  min-height: 26px;
  max-height: 96px;
  padding: 4px 8px;
  resize: none;
  background: var(--vscode-input-bg, #1e1e1e);
  border: 1px solid var(--vscode-border, #3c3c3c);
  color: var(--vscode-fore-text, #dcdcdc);
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: var(--log-font-size);
  line-height: 18px;
  outline: none;
}

.input-field:focus {
  border-color: var(--vscode-accent-blue, #007acc);
}

.input-field:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.send-btn {
  height: 26px;
  padding: 0 12px;
  background: var(--vscode-accent-blue, #007acc);
  border: none;
  color: #fff;
  cursor: pointer;
  font-size: 12px;
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.detail-meta {
  margin-bottom: 8px;
  color: var(--vscode-fore-text-dim, #969696);
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
}

.detail-content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
  background: var(--vscode-input-bg, #1e1e1e);
  padding: 12px;
  max-height: 60vh;
  overflow-y: auto;
}
</style>
