import { defineStore } from 'pinia';

import type {
  Task,
  WorkerState,
  Progress,
  ServerMessage,
  Issue,
  IssueStatus,
  SchedulerPauseReason,
} from '@shared/types';

let ipcUnsubscribers: Array<() => void> = [];

export const useSchedulerStore = defineStore('scheduler', {
  state: () => ({
    // IPC state (always true in Electron)
    ipcReady: true,
    lastError: null as string | null,

    // File state
    filePath: '',
    projectRoot: '',

    // Scheduler state
    running: false,
    paused: false,
    pausedReason: null as SchedulerPauseReason | null,
    tasks: [] as Task[],
    workers: new Map<number, WorkerState>(),
    progress: { completed: 0, total: 0 } as Progress,
    issues: [] as Issue[],

    // UI state
    fontSize: 12
  }),

  getters: {
    sortedTasks: (state) => {
      return [...state.tasks].sort((a, b) => {
        if (a.wave !== b.wave) return a.wave - b.wave;
        return a.id.localeCompare(b.id);
      });
    },

    tasksByWave: (state) => {
      const map = new Map<number, Task[]>();
      for (const task of state.tasks) {
        const list = map.get(task.wave) || [];
        list.push(task);
        map.set(task.wave, list);
      }
      return map;
    },

    activeWorkers: (state) => {
      return [...state.workers.values()].filter((w) => w.active);
    },

    progressPercent: (state) => {
      if (state.progress.total === 0) return 0;
      return Math.round((state.progress.completed / state.progress.total) * 100);
    },

    openIssues: (state) => {
      return state.issues.filter(i => i.status === 'open');
    },

    openIssueCount: (state) => {
      return state.issues.filter(i => i.status === 'open').length;
    },

    blockerCount: (state) => {
      return state.issues.filter(i => i.status === 'open' && i.severity === 'blocker').length;
    }
  },

  actions: {
    // IPC actions
    init() {
      if (ipcUnsubscribers.length > 0) return;

      this.lastError = null;

      // Check electronAPI availability
      if (typeof window === 'undefined' || !window.electronAPI) {
        this.ipcReady = false;
        this.lastError = 'Electron API 不可用（非 Electron 环境）';
        return;
      }

      this.ipcReady = true;
      const api = window.electronAPI;

      ipcUnsubscribers = [
        api.onFileLoaded((payload) => {
          this.handleServerMessage({ type: 'fileLoaded', payload });
        }),
        api.onTaskUpdate((payload) => {
          this.handleServerMessage({ type: 'taskUpdate', payload });
        }),
        api.onWorkerLog((payload) => {
          this.handleServerMessage({ type: 'workerLog', payload });
        }),
        api.onProgress((payload) => {
          this.handleServerMessage({ type: 'progress', payload });
        }),
        api.onSchedulerStateChange((payload) => {
          this.handleServerMessage({ type: 'schedulerState', payload });
        }),
        api.onWorkerStateChange((payload) => {
          this.handleServerMessage({ type: 'workerState', payload });
        }),
        api.onFullState((payload) => {
          this.handleServerMessage({ type: 'fullState', payload });
        }),
        api.onIssueReported((payload) => {
          this.handleServerMessage({ type: 'issueReported', payload });
        }),
        api.onIssueUpdate((payload) => {
          this.handleServerMessage({ type: 'issueUpdate', payload });
        })
      ];

      void api
        .getState()
        .then((state) => {
          if (!state) return;
          this.handleServerMessage({ type: 'fullState', payload: state });
        })
        .catch((err: unknown) => {
          this.lastError = err instanceof Error ? err.message : '获取调度器状态失败';
        });
    },

    cleanup() {
      for (const unsubscribe of ipcUnsubscribers) {
        try {
          unsubscribe();
        } catch {
          // ignore
        }
      }
      ipcUnsubscribers = [];
    },

    handleServerMessage(msg: ServerMessage) {
      switch (msg.type) {
        case 'hello':
        case 'pong':
          break;

        case 'error':
          this.lastError = msg.message;
          break;

        case 'fileLoaded':
          this.filePath = msg.payload.filePath;
          this.projectRoot = msg.payload.projectRoot;
          this.tasks = msg.payload.tasks;
          this.progress = { completed: 0, total: msg.payload.tasks.length };
          break;

        case 'taskUpdate':
          {
            const task = this.tasks.find((t) => t.id === msg.payload.taskId);
            if (task) {
              task.status = msg.payload.status;
              if (msg.payload.duration !== undefined) {
                task.duration = msg.payload.duration;
              }
              if (msg.payload.workerId !== undefined) {
                task.workerId = msg.payload.workerId;
              }
              if (msg.payload.retryCount !== undefined) {
                task.retryCount = msg.payload.retryCount;
              }
              if (msg.payload.nextRetryAt !== undefined) {
                task.nextRetryAt = msg.payload.nextRetryAt ?? undefined;
              }
            }
          }
          break;

        case 'workerLog':
          {
            let worker = this.workers.get(msg.payload.workerId);
            if (!worker) {
              worker = {
                id: msg.payload.workerId,
                active: true,
                logs: []
              };
              this.workers.set(msg.payload.workerId, worker);
            }
            worker.taskId = msg.payload.taskId;
            worker.logs.push(msg.payload.entry);
            // Limit logs to 1000 entries
            if (worker.logs.length > 1000) {
              worker.logs = worker.logs.slice(-1000);
            }
          }
          break;

        case 'workerState':
          {
            let worker = this.workers.get(msg.payload.workerId);
            if (!worker) {
              worker = {
                id: msg.payload.workerId,
                active: msg.payload.active ?? true,
                logs: []
              };
              this.workers.set(msg.payload.workerId, worker);
            }
            worker.active = msg.payload.active ?? worker.active;
            worker.taskId = msg.payload.taskId;
            worker.tokenUsage = msg.payload.tokenUsage;
            worker.currentTool = msg.payload.currentTool;
          }
          break;

        case 'progress':
          this.progress = msg.payload;
          break;

        case 'schedulerState':
          this.running = msg.payload.running;
          this.paused = msg.payload.paused;
          this.pausedReason = msg.payload.pausedReason ?? null;
          break;

        case 'fullState':
          this.running = msg.payload.running;
          this.paused = msg.payload.paused;
          this.pausedReason = msg.payload.pausedReason ?? null;
          this.filePath = msg.payload.filePath;
          this.projectRoot = msg.payload.projectRoot;
          this.tasks = msg.payload.tasks;
          this.progress = msg.payload.progress;
          this.issues = msg.payload.issues || [];
          this.workers.clear();
          for (const ws of msg.payload.workers) {
            this.workers.set(ws.id, ws);
          }
          break;

        case 'issueReported':
          {
            const existingIndex = this.issues.findIndex(i => i.id === msg.payload.issue.id);
            if (existingIndex >= 0) {
              this.issues[existingIndex] = msg.payload.issue;
            } else {
              this.issues.push(msg.payload.issue);
            }
          }
          break;

        case 'issueUpdate':
          {
            const issue = this.issues.find(i => i.id === msg.payload.issueId);
            if (issue) {
              issue.status = msg.payload.status;
            }
          }
          break;

        case 'exportLogsResponse':
          this.downloadLogsContent(msg.payload.content);
          break;
      }
    },

    downloadLogsContent(content: string) {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `auto-dev-scheduler-logs-${new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },

    // Scheduler actions
    async loadFile(path: string) {
      try {
        await window.electronAPI.loadFile(path);
      } catch (err: unknown) {
        this.lastError = err instanceof Error ? err.message : '加载文件失败';
      }
    },

    async start(maxParallel: number) {
      try {
        await window.electronAPI.start(maxParallel);
      } catch (err: unknown) {
        this.lastError = err instanceof Error ? err.message : '启动失败';
      }
    },

    async pause() {
      try {
        await window.electronAPI.pause();
      } catch (err: unknown) {
        this.lastError = err instanceof Error ? err.message : '暂停失败';
      }
    },

    async resume() {
      try {
        await window.electronAPI.resume();
      } catch (err: unknown) {
        this.lastError = err instanceof Error ? err.message : '继续失败';
      }
    },

    async stop() {
      try {
        await window.electronAPI.stop();
      } catch (err: unknown) {
        this.lastError = err instanceof Error ? err.message : '停止失败';
      }
    },

    async retryTask(taskId: string) {
      try {
        await window.electronAPI.retryTask(taskId);
      } catch (err: unknown) {
        this.lastError = err instanceof Error ? err.message : '重试任务失败';
      }
    },

    async sendToWorker(workerId: number, content: string) {
      try {
        await window.electronAPI.sendToWorker(workerId, content);
      } catch (err: unknown) {
        this.lastError = err instanceof Error ? err.message : '发送到 Worker 失败';
      }
    },

    async killWorker(workerId: number) {
      try {
        await window.electronAPI.killWorker(workerId);
      } catch (err: unknown) {
        this.lastError = err instanceof Error ? err.message : '终止 Worker 失败';
      }
    },

    async exportLogs() {
      try {
        const content = await window.electronAPI.exportLogs();
        this.handleServerMessage({ type: 'exportLogsResponse', payload: { content } });
      } catch (err: unknown) {
        this.lastError = err instanceof Error ? err.message : '导出日志失败';
      }
    },

    async updateIssueStatus(issueId: string, status: IssueStatus) {
      try {
        await window.electronAPI.updateIssueStatus(issueId, status);
      } catch (err: unknown) {
        this.lastError = err instanceof Error ? err.message : '更新问题状态失败';
      }
    },

    async ping() {
      try {
        const state = await window.electronAPI.getState();
        if (!state) return;
        this.handleServerMessage({ type: 'fullState', payload: state });
      } catch (err: unknown) {
        this.lastError = err instanceof Error ? err.message : '获取调度器状态失败';
      }
    },

    // UI actions
    setFontSize(size: number) {
      this.fontSize = size;
    }
  }
});
