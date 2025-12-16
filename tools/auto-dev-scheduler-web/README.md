# Auto-Dev Scheduler

Electron 桌面应用，用于并发调度多个 Claude Code 实例执行 AUTO-DEV.md 任务。

## 功能

- **任务调度**：解析 AUTO-DEV.md 并按依赖顺序执行任务
- **多实例并发**：支持同时运行多个 Worker
- **Worker 健康监控**：
  - 进程存活检测
  - 活动超时检测（可配置）
  - 分层诊断（规则 + AI）
  - 自动恢复机制
- **断点续传**：
  - 任务日志持久化
  - 中断恢复上下文注入
  - 日志自动清理

## 技术栈

- **Electron 28** + vite-plugin-electron
- **Vue 3** + Element Plus + Pinia
- **TypeScript**（全栈）
- **electron-builder**（打包）

## 开发

```bash
cd tools/auto-dev-scheduler-web
npm install
npm run dev
```

## 打包

```bash
npm run build:win
```

生成 `release/Auto-Dev-Scheduler-Setup-1.0.0.exe`

## 目录结构

```
auto-dev-scheduler-web/
├── src/
│   ├── main/              # 主进程
│   │   ├── index.ts       # 入口
│   │   ├── scheduler-service.ts
│   │   ├── claude-worker.ts
│   │   ├── parser.ts
│   │   ├── watchdog.ts    # 健康监控
│   │   ├── log-manager.ts # 日志管理
│   │   └── ipc-handlers.ts
│   ├── preload/           # 预加载脚本
│   │   └── index.ts
│   ├── renderer/          # 渲染进程
│   │   ├── App.vue
│   │   ├── main.ts
│   │   ├── components/
│   │   └── stores/
│   └── shared/            # 共享类型
│       ├── types.ts
│       └── electron-api.d.ts
├── resources/
│   └── icon.ico
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## 配置项

通过设置对话框可配置：
- Codex/Gemini 等待上限（默认 60 分钟）
- 普通操作等待上限
- 日志保留天数
