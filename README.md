# OpenSpec + Auto-Dev Scheduler

基于 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 的多 Claude 并发开发扩展。

## 这是什么？

```
你的需求 → AI 理解项目 → AI 分析方案 → 多个 Claude 同时开发 → 你验收
```

**OpenSpec** 是规格驱动开发框架，让 AI 先理解、再动手：
- 先写提案（proposal）说清楚要做什么
- 拆解任务、分析依赖
- 确认后再开始编码

**Auto-Dev Scheduler** 是我们添加的并发执行能力：
- 多个 Claude 实例同时工作
- 自动分配任务、避免冲突
- 可视化监控进度

## 为什么需要先让 AI 理解项目？

**这一步非常重要**。在开始任何开发前，你需要告诉 AI：

| 信息 | 为什么重要 |
|------|-----------|
| **项目用途** | AI 知道这是做什么的，才能给出合理方案 |
| **技术栈** | 用 React 还是 Vue？用 PostgreSQL 还是 MongoDB？ |
| **代码规范** | 命名风格、文件组织、最佳实践 |
| **领域知识** | 业务术语、流程、专业概念 |
| **约束条件** | 性能要求、兼容性、禁止事项 |

这些信息填写在 `openspec/project.md` 中，AI 会在每次工作前阅读它。

## 核心功能

### Auto-Dev Scheduler（调度器）

- 可视化 GUI，实时显示任务状态和日志
- 支持 1-4 个 Claude 并行执行
- 内存状态管理，AUTO-DEV.md 只读
- 自动管理任务依赖和执行顺序

### OpenSpec（规格驱动）

- `/openspec:proposal` - 创建变更提案
- `/openspec:apply` - 执行提案（启动调度器）
- `/openspec:archive` - 归档已完成的变更

详细文档：[OpenSpec GitHub](https://github.com/Fission-AI/OpenSpec)

## 目录结构

```
your-project/
├── CLAUDE.md                         # Claude 指令（自动添加 OpenSpec 引用）
├── openspec/
│   ├── AGENTS.md                     # AI 代理指南（创建提案流程）
│   ├── project.md                    # 项目配置（技术栈、规范）
│   ├── specs/                        # 规格文档（当前真相）
│   │   └── {capability}/
│   │       └── spec.md
│   ├── changes/                      # 变更提案
│   │   ├── {change-id}/
│   │   │   ├── proposal.md           # 为什么、改什么
│   │   │   ├── design.md             # 技术决策（可选）
│   │   │   ├── tasks.md              # 实现清单
│   │   │   └── specs/                # 规格增量
│   │   └── archive/                  # 已完成的变更
│   └── execution/
│       ├── README.md                 # 任务文档规范
│       └── {project}/
│           └── AUTO-DEV.md           # 并发任务文件
├── .claude/
│   └── commands/
│       └── auto-dev.md               # /auto-dev 命令定义
└── tools/
    └── auto-dev-scheduler-web/       # Electron 调度器应用
        ├── src/
        │   ├── main/                 # 主进程（调度核心、Worker管理）
        │   ├── renderer/             # 渲染进程（Vue 3 UI）
        │   └── shared/               # 共享类型定义
        ├── package.json
        └── 自动调度器使用说明.md
```

## 快速安装（Windows）

在目标项目根目录运行 PowerShell：

```powershell
# 方式1：在线安装（推荐）
irm https://raw.githubusercontent.com/zengruifeng56-del/auto-dev-scheduler/master/install.ps1 | iex

# 方式2：本地安装（如果已下载仓库）
.\path\to\auto-dev-scheduler\install.ps1
```

安装脚本会：

1. 下载 OpenSpec 核心文件（AGENTS.md、project.md 模板）
2. 下载 OpenSpec 命令（`/openspec:proposal`、`/openspec:apply`、`/openspec:archive`）
3. 下载 Auto-Dev 调度器和 `/auto-dev` 命令
4. 创建/更新 CLAUDE.md，添加 OpenSpec 引用

## 调度器打包

调度器是 Electron 桌面应用，你可以选择**开发模式运行**或**打包成安装程序**。

### 开发模式运行（推荐开发者）

```bash
cd tools/auto-dev-scheduler-web
npm install
npm run dev
```

### 打包成安装程序（推荐分发）

```bash
cd tools/auto-dev-scheduler-web

# 1. 安装依赖
npm install

# 2. 打包 Windows 安装程序
npm run build:win
```

打包完成后，安装程序生成在：

```
tools/auto-dev-scheduler-web/release/Auto-Dev-Scheduler-Setup-1.0.0.exe
```

### 打包命令说明

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式，热重载 |
| `npm run build` | 仅构建，不打包 |
| `npm run build:win` | 构建并打包 Windows 安装程序 |
| `npm run typecheck` | TypeScript 类型检查 |

### 技术栈

- **Electron 28** - 桌面应用框架
- **Vue 3.4** - 前端框架
- **TypeScript** - 类型安全
- **Element Plus** - UI 组件库
- **Pinia** - 状态管理
- **electron-builder** - 打包工具

## 使用流程

```
┌──────────────────────────────────────────────────────────────┐
│  1. 安装           运行 install.ps1                          │
│       ↓                                                      │
│  2. 配置项目       让 Claude 阅读 openspec 并填写项目信息      │
│       ↓                                                      │
│  3. 说需求         /openspec:proposal my-feature             │
│       ↓            告诉 Claude 你要做什么                     │
│       ↓                                                      │
│  4. 讨论确认       Claude 提问 ←→ 你回答                      │
│       ↓            直到双方理解一致                           │
│       ↓                                                      │
│  5. 生成任务       Claude 自动生成 AUTO-DEV.md               │
│       ↓                                                      │
│  6. 并发执行       /openspec:apply my-feature                │
│       ↓            调度器启动，多 Claude 并行开发             │
│       ↓                                                      │
│  7. 测试验收       你测试功能，确认没问题                      │
│       ↓                                                      │
│  8. 归档           /openspec:archive my-feature              │
└──────────────────────────────────────────────────────────────┘
```

### 第一步：安装

```powershell
irm https://raw.githubusercontent.com/zengruifeng56-del/auto-dev-scheduler/master/install.ps1 | iex
```

### 第二步：配置项目（关键！）

告诉 Claude：

```
请阅读 openspec 目录，帮我填写项目配置信息
```

Claude 会帮你填写 `openspec/project.md`，包含：

| 配置项 | 说明 | 示例 |
|--------|------|------|
| **项目用途** | 这个项目是做什么的 | "电商平台后台管理系统" |
| **技术栈** | 使用的语言、框架、数据库 | TypeScript + React + PostgreSQL |
| **代码规范** | 命名规则、文件组织 | "使用 ESLint，函数用 camelCase" |
| **领域知识** | 业务术语和概念 | "订单状态：待支付→已支付→已发货" |
| **约束条件** | 限制和要求 | "必须支持移动端，API < 200ms" |

**为什么这步很重要？** 填写越详细，AI 给出的方案越贴合你的项目。

### 第三步：告诉 Claude 你的需求

```
/openspec:proposal my-feature
```

然后用自然语言描述你要做什么，比如：
- "我要给系统加一个用户登录功能"
- "帮我重构订单模块，支持多种支付方式"

### 第四步：和 Claude 讨论确认

Claude 会：
1. 提问澄清不明确的地方
2. 分析技术方案
3. 拆解任务和依赖关系

**你需要**：回答问题，确认方案，直到双方理解一致。

### 第五步：Claude 生成执行文件

确认后，Claude 会自动生成：
- `openspec/changes/my-feature/` - 方案文档
- `openspec/execution/{项目}/AUTO-DEV.md` - **调度器执行文件（核心）**

### 第六步：启动并发执行

```
/openspec:apply my-feature
```

调度器 GUI 启动后：
1. 点击「Start」开始执行
2. 多个 Claude 实例并行工作
3. 实时查看各任务进度和日志

### 第七步：测试验收

所有任务完成后，**你自己测试**：
- 功能是否正常
- 是否符合预期

### 第八步：归档（可选）

测试通过后，归档这次变更：

```
/openspec:archive my-feature
```

### 异常处理

| 情况        | 处理方式            |
| --------- | --------------- |
| Worker 卡住 | 点击对应面板的「Kill」按钮 |
| 需要人工干预    | 在输入框输入指令，按回车发送  |
| 任务冲突      | 调度器自动重试，无需干预    |
| 全部暂停      | 点击「Pause」，再点恢复  |

## 任务ID格式

调度器支持通用格式 `XX-YYY`，示例：

| 前缀      | 用途   | 示例                  |
| ------- | ---- | ------------------- |
| `FE-`   | 前端任务 | FE-01, FE-AUTH-01   |
| `BE-`   | 后端任务 | BE-API-01, BE-DB-02 |
| `GM-`   | 游戏管理 | GM-00, GM-TOOL-01   |
| `TASK-` | 通用任务 | TASK-001, TASK-002  |
| `TEST-` | 测试任务 | TEST-UNIT-01        |

## 依赖声明格式

依赖字段支持多种写法：

```markdown
**依赖**：无
**依赖**：None
**依赖**：BE-01
**依赖**：BE-01, FE-01
**依赖**：BE-01（可与 FE-01 并行）   # 括号内为注释，不计入依赖
```

> 括号内的内容会被自动忽略，仅提取实际的任务 ID 作为依赖。

## 任务状态流转

```
🟦 空闲 ──────────────────────────────────────┐
    │                                         │
    ▼ (调度器分配)                             │
🟠 执行中（Worker-1, 时间）                    │
    │                                         │
    ├──▶ ✅ 已完成（时间）                     │
    │                                         │
    └──▶ ⚠️ 阻塞（需人工处理）─────────────────┘
              │
              ▼ (问题解决后 / 重试)
           🟦 空闲
```

## 核心约束（/auto-dev 强制执行）

执行过程中 Claude 必须遵守：

- ❌ 禁止跳过测试失败/编译错误
- ❌ 禁止使用 TODO/FIXME 占位符
- ❌ 禁止 `git restore .` / `git reset --hard`
- ❌ 禁止自动接管下一个任务（一次只做一个）
- ✅ 遇到问题必须立即修复
- ✅ 100% 测试通过
- ✅ 类型检查 0 错误

## 系统要求

- **操作系统**：Windows（需要 Node.js 18+）
- **Node.js**：18.x 或更高版本
- **Claude Code**：已安装并配置 CLI
- **Git**：用于版本控制
- **网络**：在线安装需要访问 GitHub

## 常见问题

### Q: 调度器无法启动 Claude？

确保 `claude` 命令在 PATH 中可用，运行 `claude --version` 验证。

### Q: 任务一直显示「执行中」但实际已完成？

在调度器 GUI 中点击该任务的「完成」按钮，或重启调度器重新加载状态。

### Q: 如何添加新任务？

1. 停止调度器
2. 在 AUTO-DEV.md 中添加 `### Task: XX-YY 任务名` 块
3. 重启调度器加载新任务

> 注：v1.1.0 起 AUTO-DEV.md 为初始任务定义文件（启动时只读加载），运行时状态由调度器内存管理。

### Q: 支持 Mac/Linux 吗？

Electron 版本理论上支持跨平台，但目前仅在 Windows 上测试。/auto-dev 命令本身跨平台可用。

### Q: 为什么 v1.1.0 移除了 Git 分布式锁？

旧版使用 git pull/push 实现多 Worker 同步，存在以下问题：

1. **合并冲突频繁**：多个 Claude 同时修改代码，git 冲突难以自动解决
2. **状态不一致**：网络延迟导致 AUTO-DEV.md 状态同步滞后
3. **复杂度过高**：锁获取、释放、超时处理逻辑难以维护

新架构改为**内存状态管理**：调度器在内存中维护任务状态，AUTO-DEV.md 仅作为初始任务定义文件（只读）。Worker 完成任务后通过 IPC 通知调度器更新状态，避免文件级冲突。

## 更新日志

### v1.2.0 (2024-12) - 状态持久化增强

**新功能**

- **任务状态持久化**：调度器启动时尊重文件中已完成（success/failed）的任务状态，避免重复执行
- **Worker 日志归档**：stop 时保留已完成 Worker 的历史日志，支持导出完整执行记录
- **文件路径传递**：`/auto-dev` 命令自动传递 `--file` 参数，Worker 可获取任务文件路径

**OpenSpec 增强**

- **Milestone 集成**：AGENTS.md 新增版本里程碑集成指南，支持 ROADMAP.md 跟踪

**Bug 修复**

- 修复 checkbox 状态解析：支持缩进列表、`+` 标记、大写 `[X]`

**改进**

- 日志导出包含已完成和已停止的 Worker 记录
- 统一换行符格式（LF）

### v1.1.0 (2024-12) - 简化架构

**架构变更**

- **移除 Git 同步**：不再执行 git pull/push，避免多人协作冲突
- **移除分布式锁**：改为内存状态管理，AUTO-DEV.md 变为只读
- **移除交付检查**：简化流程，由 REVIEW-SYNC 任务替代

**新功能**

- **任务重试**：失败任务支持一键重试，自动级联重置依赖任务
- **REVIEW-SYNC 规范**：调度器完成后人工审核，同步勾选 tasks.md
- **慢工具超时**：codex/gemini 60分钟，npm install 15分钟，npm build 20分钟

**改进**

- 统一任务ID模式 (`XX-YYY`)
- 简化 Watchdog 健康检测逻辑
- 精简代码约 1500 行

### v1.0.0 (2024-12) - Electron 版本

**重大升级**

- 从 PowerShell 迁移到 Electron + Vue 3 架构
- 技术栈：Electron 28 + Vue 3.4 + TypeScript + Element Plus + Pinia

**新功能**

- **Watchdog 健康监控**：双层诊断机制（规则诊断 + AI 诊断）
  - 进程存活检测
  - 活动超时检测（可配置）
  - 慢操作工具超时（codex/gemini/npm 等）
  - 自动恢复机制
- **断点续传**：任务日志持久化，中断后可恢复上下文
- **交付检查**：任务完成后自动对比 tasks.md 检查清单
- **设置对话框**：可配置各类超时阈值和日志保留天数

**改进**

- VS Code Dark 风格深色主题
- 更流畅的实时日志显示
- 改进的任务状态可视化

### v0.6.1 (旧版 PowerShell)

- 命令行参数支持
- 耗时统计
- 依赖解析改进

### v0.6.0 (旧版 PowerShell)

- 初始版本
- 深色主题 GUI
- 多 Worker 并发调度
- 实时日志面板

## 相关链接

- [Claude Code 官方文档](https://docs.anthropic.com/claude-code)
- [OpenSpec GitHub](https://github.com/Fission-AI/OpenSpec)
- [OpenSpec 规范说明](./openspec/AGENTS.md)

## 致谢

- **[OpenSpec](https://github.com/Fission-AI/OpenSpec)** - 规格驱动开发框架
- **佬友 @Me** - AUTO-DEV 并发执行方案的原创设计
- **大米林** 与 **隐** - OpenSpec 使用建议
