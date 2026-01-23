/**
 * IPC Channel Constants
 * 定义主进程与渲染进程之间的 IPC 通道名称
 */

export const IPC_CHANNELS = {
  // Dialog
  DIALOG_OPEN_FILE: 'dialog:openFile',

  // Scheduler Commands (Renderer → Main)
  SCHEDULER_LOAD_FILE: 'scheduler:loadFile',
  SCHEDULER_START: 'scheduler:start',
  SCHEDULER_PAUSE: 'scheduler:pause',
  SCHEDULER_RESUME: 'scheduler:resume',
  SCHEDULER_STOP: 'scheduler:stop',
  SCHEDULER_GET_STATE: 'scheduler:getState',

  // Task Commands (Renderer → Main)
  TASK_RETRY: 'task:retry',

  // Worker Commands (Renderer → Main)
  WORKER_SEND: 'worker:send',
  WORKER_KILL: 'worker:kill',

  // Logs
  LOGS_EXPORT: 'logs:export',
  LOGS_CLEAR_TASK_LOGS: 'logs:clearTaskLogs',

  // Watchdog Config (Renderer → Main)
  WATCHDOG_GET_CONFIG: 'watchdog:getConfig',
  WATCHDOG_SET_CONFIG: 'watchdog:setConfig',

  // Auto-Retry Config (Renderer → Main)
  AUTO_RETRY_GET_CONFIG: 'autoRetry:getConfig',
  AUTO_RETRY_SET_CONFIG: 'autoRetry:setConfig',

  // Scheduler Config (Renderer → Main)
  SCHEDULER_GET_BLOCKER_CONFIG: 'scheduler:getBlockerConfig',
  SCHEDULER_SET_BLOCKER_CONFIG: 'scheduler:setBlockerConfig',

  // Issue Commands (Renderer → Main)
  ISSUE_UPDATE_STATUS: 'issue:updateStatus',
  ISSUE_CLEAR_ALL: 'issue:clearAll',

  // API Error Commands (Renderer → Main)
  API_ERROR_RETRY: 'apiError:retry',

  // Events (Main → Renderer)
  EVENT_FILE_LOADED: 'scheduler:fileLoaded',
  EVENT_TASK_UPDATE: 'scheduler:taskUpdate',
  EVENT_WORKER_LOG: 'scheduler:workerLog',
  EVENT_PROGRESS: 'scheduler:progress',
  EVENT_SCHEDULER_STATE: 'scheduler:stateChange',
  EVENT_WORKER_STATE: 'worker:stateChange',
  EVENT_FULL_STATE: 'scheduler:fullState',
  EVENT_WORKER_HEALTH_WARNING: 'worker:healthWarning',
  EVENT_ISSUE_REPORTED: 'issue:reported',
  EVENT_ISSUE_UPDATE: 'issue:update',
  EVENT_API_ERROR: 'apiError:event',
} as const;

export type IpcChannels = typeof IPC_CHANNELS;
