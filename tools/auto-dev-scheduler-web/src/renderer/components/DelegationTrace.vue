<script setup lang="ts">
import { computed } from 'vue';
import type { LogEntry, TaskStatus } from '@shared/types';

type WorkerKind = 'claude' | 'codex' | 'gemini';
type TraceTone = 'routing' | 'delegating' | 'working' | 'reviewing' | 'complete';

interface TraceState {
  label: string;
  tone: TraceTone;
}

const props = defineProps<{
  taskId: string;
  workerKind?: WorkerKind;
  taskStatus?: TaskStatus;
  logs?: LogEntry[];
}>();

const workerKindIcons: Record<WorkerKind, string> = {
  claude: '🟣',
  codex: '🔵',
  gemini: '🟢'
};

const workerKindLabels: Record<WorkerKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini'
};

const ROUTING_PREFIXES: Record<string, WorkerKind> = {
  'FE-': 'gemini',
  'BE-': 'codex'
};

const logEntries = computed(() => props.logs ?? []);

const expectedWorkerKind = computed<WorkerKind>(() => {
  const match = Object.entries(ROUTING_PREFIXES).find(([prefix]) => props.taskId.startsWith(prefix));
  return match ? match[1] : 'claude';
});

function parseDelegationKind(content: string): WorkerKind | null {
  const normalized = content.trimStart();
  if (normalized.startsWith('codex:') || normalized.startsWith('mcp__codex__')) return 'codex';
  if (normalized.startsWith('gemini:') || normalized.startsWith('mcp__gemini__')) return 'gemini';
  return null;
}

const delegationInfo = computed(() => {
  const entries = logEntries.value;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== 'tool') continue;
    const kind = parseDelegationKind(entry.content);
    if (kind) return { kind, index: i };
  }
  return null;
});

const delegationKind = computed<WorkerKind | null>(() => {
  if (delegationInfo.value?.kind) return delegationInfo.value.kind;
  if (props.workerKind && props.workerKind !== 'claude') return props.workerKind;
  return null;
});

const delegationObserved = computed(() => delegationKind.value !== null && delegationKind.value !== 'claude');

const delegationResultSeen = computed(() => {
  if (!delegationInfo.value) return false;
  const entries = logEntries.value;
  for (let i = delegationInfo.value.index + 1; i < entries.length; i += 1) {
    if (entries[i].type === 'result') return true;
  }
  return false;
});

const isTerminal = computed(() => {
  return props.taskStatus === 'success' || props.taskStatus === 'failed' || props.taskStatus === 'canceled';
});

const isRunning = computed(() => props.taskStatus === 'running');

const workerKindResolved = computed<WorkerKind>(() => {
  if (delegationKind.value) return delegationKind.value;
  if (props.workerKind && props.workerKind !== 'claude') return props.workerKind;
  return expectedWorkerKind.value;
});

const supervisorState = computed<TraceState>(() => {
  if (isTerminal.value) return { label: 'Complete', tone: 'complete' };
  if (delegationObserved.value) {
    if (!delegationResultSeen.value) return { label: 'Delegating', tone: 'delegating' };
    return { label: 'Reviewing', tone: 'reviewing' };
  }
  if (expectedWorkerKind.value !== 'claude') return { label: 'Routing...', tone: 'routing' };
  return isRunning.value ? { label: 'Working', tone: 'working' } : { label: 'Routing...', tone: 'routing' };
});

const workerState = computed<TraceState>(() => {
  if (isTerminal.value) return { label: 'Complete', tone: 'complete' };
  if (delegationObserved.value) {
    if (!delegationResultSeen.value) return { label: 'Working', tone: 'working' };
    return { label: 'Complete', tone: 'complete' };
  }
  if (expectedWorkerKind.value !== 'claude') return { label: 'Routing...', tone: 'routing' };
  return isRunning.value ? { label: 'Working', tone: 'working' } : { label: 'Routing...', tone: 'routing' };
});

const supervisorLabel = computed(() => workerKindLabels.claude);
const workerLabel = computed(() => workerKindLabels[workerKindResolved.value]);
const supervisorIcon = computed(() => workerKindIcons.claude);
const workerIcon = computed(() => workerKindIcons[workerKindResolved.value]);
</script>

<template>
  <div class="delegation-trace">
    <div class="trace-row">
      <div class="trace-cell">
        <span class="trace-icon">{{ supervisorIcon }}</span>
        <span class="trace-role">Supervisor</span>
      </div>
      <span class="trace-arrow">→</span>
      <div class="trace-cell right">
        <span class="trace-icon">{{ workerIcon }}</span>
        <span class="trace-role">Worker</span>
      </div>
    </div>
    <div class="trace-row">
      <div class="trace-cell">
        <span class="trace-label">[{{ supervisorLabel }}]</span>
      </div>
      <span class="trace-arrow"></span>
      <div class="trace-cell right">
        <span class="trace-label">[{{ workerLabel }}]</span>
      </div>
    </div>
    <div class="trace-row">
      <div class="trace-cell">
        <span class="trace-state" :class="`state-${supervisorState.tone}`">{{ supervisorState.label }}</span>
      </div>
      <span class="trace-arrow"></span>
      <div class="trace-cell right">
        <span class="trace-state" :class="`state-${workerState.tone}`">{{ workerState.label }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.delegation-trace {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  background: var(--vscode-input-bg);
  border-bottom: 1px solid var(--vscode-border);
  font-size: 11px;
  color: var(--vscode-fore-text, #dcdcdc);
}

.trace-row {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 6px;
}

.trace-cell {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.trace-cell.right {
  justify-content: flex-end;
}

.trace-icon {
  font-size: 13px;
  line-height: 1;
}

.trace-role {
  text-transform: uppercase;
  font-size: 9px;
  letter-spacing: 0.5px;
  color: var(--vscode-fore-text-dim, #949494);
}

.trace-arrow {
  color: var(--vscode-fore-text-dim, #949494);
  font-weight: 600;
  justify-self: center;
}

.trace-label {
  font-weight: 600;
  color: var(--vscode-fore-text, #dcdcdc);
}

.trace-state {
  font-size: 9px;
  letter-spacing: 0.4px;
  text-transform: uppercase;
}

.state-routing { color: var(--vscode-fore-text-dim, #949494); }
.state-delegating { color: var(--vscode-accent-orange, #ce9178); }
.state-working { color: var(--vscode-accent-blue-text, #3794ff); }
.state-reviewing { color: var(--vscode-accent-blue-light, #1177bb); }
.state-complete { color: var(--vscode-accent-green, #4ec9b0); }
</style>
