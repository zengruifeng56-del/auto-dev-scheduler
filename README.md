# OpenSpec + Auto-Dev Scheduler

多 Claude 并发开发框架。

## 功能特性

- **OpenSpec** - 规格驱动开发工作流
- **Auto-Dev Scheduler** - 多 Claude 并发执行的 GUI 任务调度器
- **/auto-dev 命令** - Claude Code 并发执行协议

## 快速安装（Windows）

在目标项目根目录运行 PowerShell：

```powershell
# 本地安装（如果已下载）
.\path\to\auto-dev-scheduler\install.ps1
```

## 安装后配置

1. 编辑 `openspec/project.md`，填写项目信息
2. 创建 `openspec/execution/{项目名}/AUTO-DEV.md`（参考模板）
3. 运行 `tools/auto-dev-scheduler/run.bat` 启动调度器

## 目录结构

```
your-project/
├── openspec/
│   ├── AGENTS.md                 # OpenSpec AI 代理指南
│   ├── project.md                # 项目配置
│   └── execution/
│       ├── README.md             # AUTO-DEV.md 格式规范
│       └── {project}/
│           └── AUTO-DEV.md       # 并发任务文件
├── .claude/
│   └── commands/
│       └── auto-dev.md           # /auto-dev 命令规范
└── tools/
    └── auto-dev-scheduler/
        ├── auto-dev-scheduler.ps1
        └── run.bat
```

## 工作流程

```
用户需求
    ↓
OpenSpec 创建提案 (/openspec:proposal)
    ↓
openspec/changes/{change-id}/
├── proposal.md   ← 为什么、改什么
├── design.md     ← 技术决策
├── tasks.md      ← 细粒度清单（单 Claude 用）
└── specs/        ← 规格变更
    ↓
批准后 → 转为并发任务
    ↓
openspec/execution/{project}/AUTO-DEV.md  ← 粗粒度任务（多 Claude 用）
    ↓
/auto-dev 并发执行
    ↓
完成后 → OpenSpec 归档 (/openspec:archive)
```

## 任务ID格式

调度器支持通用任务ID格式：`XX-YYY`

示例：
- `GM-00`, `GM-01`（游戏管理）
- `FE-01`, `FE-AUTH-01`（前端）
- `BE-API-01`（后端）
- `TASK-001`（通用）

## 使用方法

1. **启动调度器**：运行 `tools/auto-dev-scheduler/run.bat`
2. **选择任务文件**：浏览到 `openspec/execution/{project}/AUTO-DEV.md`
3. **设置并发数**：选择 1-4 个并发 worker
4. **点击开始**：调度器自动启动 Claude 实例

## 任务状态

| 状态 | 含义 |
|------|------|
| 🟦 空闲 | 待认领 |
| ⏳ 待开始 | 依赖未满足 |
| 🟠 执行中 | 正在执行 |
| ✅ 已完成 | 完成 |
| ⚠️ 阻塞 | 需人工处理 |

## 系统要求

- Windows（PowerShell 5.1+）
- 已安装并配置 Claude Code CLI
- Git（用于分布式锁）
