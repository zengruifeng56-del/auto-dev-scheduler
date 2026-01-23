# Auto-Dev Scheduler

基于 OpenSpec 的 Claude 多实例并发开发调度器。

> ⚠️ **Token 成本提醒**
>
> 每个 Worker 是独立的 Claude 进程，上下文无法共享：
> - 每个任务启动时都要重新读取项目配置（CLAUDE.md、openspec/）
> - 每个 Worker 需要独立理解代码库结构
> - **10 个任务 = 10 次项目理解开销**（与并发数无关）
>
> 权衡：用更多 Token 换取更快的开发速度。建议合理控制任务粒度，避免拆分过细。

## 核心功能

- **并发执行**：1-4 个 Claude Worker 同时工作
- **可视化监控**：实时查看任务状态、Worker 日志、Token 消耗
- **智能调度**：Wave 波次执行 + 依赖管理，自动分配任务
- **健康监控**：Watchdog 检测卡死进程，支持慢工具超时（codex/gemini/npm）
- **状态持久化**：任务完成自动更新 AUTO-DEV.md checkbox

## 工作流程

```
用户需求 → /openspec:proposal → tasks.md → 转换为 AUTO-DEV.md → /openspec:apply → 调度器执行 → 验收 → /openspec:archive
```

**关键步骤说明**：
1. **Proposal 阶段**: 使用 `/openspec:proposal` 创建 `openspec/changes/{change-id}/tasks.md`（细粒度任务清单）
2. **转换阶段**: 将 `tasks.md` 按可并行维度重组为 `openspec/execution/{project}/AUTO-DEV.md`（粗粒度并发任务）
3. **执行阶段**: 使用 `/openspec:apply` 启动调度器并发执行
4. **归档阶段**: 使用 `/openspec:archive` 归档完成的变更

### 1. 创建提案

```bash
/openspec:proposal my-feature
```

与 Claude 讨论需求，生成方案文档：
- `openspec/changes/my-feature/proposal.md` - 需求和目标
- `openspec/changes/my-feature/tasks.md` - 细粒度任务清单（单人用）
- `openspec/changes/my-feature/design.md` - 技术决策（可选）

### 1.5. 转换为并发任务（重要步骤）

**方式 A: 手动创建**（推荐）

根据 `tasks.md` 创建 `openspec/execution/my-feature/AUTO-DEV.md`：

1. 按可并行维度（前端/后端/模块）将任务分组到 Wave
2. 每个 Wave 内的任务可并发执行
3. 设置任务间的依赖关系

**格式要求**：
```markdown
## 并行波次图

Wave 1: TASK-01, TASK-02, TASK-03
Wave 2: TASK-04, TASK-05
Wave 3: TASK-06

---

## Wave 1: 描述

### TASK-01: 任务标题

- [ ] 任务描述

**依赖**: 无
**Persona**: codex/backend （可选，指定使用的模型）

**执行步骤**:
1. 步骤 1
2. 步骤 2

**验收标准**:
- 标准 1
- 标准 2
```

**方式 B: 使用模板**

复制 `openspec/execution/README.md` 中的模板并填充内容。

**关键区别**：
- `tasks.md` = 细粒度串行任务（适合单人执行）
- `AUTO-DEV.md` = 粗粒度并发任务（适合多 Claude 并发）

### 2. 启动调度

```bash
/openspec:apply my-feature
```

调度器 GUI 启动后：
1. 选择并发数（1-4）
2. 点击 **Start** 开始执行
3. 实时监控各 Worker 进度

### 3. 验收归档

所有任务完成后测试功能，确认无误后归档：

```bash
/openspec:archive my-feature
```

## 安装

### 方式一：在线安装（推荐）

**Windows (PowerShell)**：
```powershell
irm https://raw.githubusercontent.com/zengruifeng56-del/auto-dev-scheduler/master/install.ps1 | iex
```

**macOS/Linux (Bash)**：
```bash
curl -fsSL https://raw.githubusercontent.com/zengruifeng56-del/auto-dev-scheduler/master/install.sh | bash
```

### 方式二：源码运行

```bash
cd tools/auto-dev-scheduler-web
npm install
npm run dev
```

### 方式三：打包安装程序

```bash
cd tools/auto-dev-scheduler-web
npm install
npm run build:win
# 生成 release/Auto-Dev-Scheduler-Setup-1.0.0.exe
```

## 更新

已安装旧版本的用户，重新运行安装命令即可更新：

```powershell
irm https://raw.githubusercontent.com/zengruifeng56-del/auto-dev-scheduler/master/install.ps1 | iex
```

安装脚本会自动覆盖更新以下文件：
- `.claude/commands/` - OpenSpec 命令
- `openspec/AGENTS.md` - 代理指南
- `tools/auto-dev-scheduler-web/` - 调度器应用

> 不会覆盖：`openspec/project.md`（项目配置）、`openspec/changes/`（变更提案）、`openspec/execution/`（执行文件）

## AUTO-DEV.md 格式

```markdown
## 并行波次图

Wave 1: BE-01, BE-02
Wave 2: FE-01, FE-02
Wave 3: REVIEW-SYNC

---

## Wave 1: 后端基础

### BE-01: 数据库设计

- [ ] 创建数据表

**依赖**: 无

### BE-02: API 接口

- [ ] 实现 CRUD 接口

**依赖**: BE-01
```

**格式要求**：
- 并行波次图必须在文件顶部，格式 `Wave N: ID1, ID2, ...`
- 任务标题：`### {ID}: {标题}`
- 必须包含 `- [ ]` checkbox 或 `**依赖**` 字段
- 依赖声明：`**依赖**: ID1, ID2` 或 `**依赖**: 无`

## 任务 ID 格式

支持 `XX-YY` 或 `XX.YY` 格式：

| 前缀 | 用途 | 示例 |
|------|------|------|
| `BE-` | 后端任务 | BE-01, BE-API-01 |
| `FE-` | 前端任务 | FE-01, FE-AUTH-01 |
| `TASK-` | 通用任务 | TASK-001 |
| `TEST-` | 测试任务 | TEST-UNIT-01 |

## 技术栈

- **Electron 28** + **Vue 3.4** + **TypeScript**
- **Element Plus** UI 组件库
- **Pinia** 状态管理

## 系统要求

- **操作系统**: Windows / macOS / Linux
- **Node.js**: >= 20
- **Git**: 已安装
- **Claude CLI**: 已安装并配置（必需）
- **OpenSpec CLI**: 已安装（必需，用于 proposal/archive 命令）

### Mac 用户注意事项

- 使用 `bash` 脚本安装: `curl -fsSL ... | bash`
- 确保已安装 Command Line Tools: `xcode-select --install`
- 如使用 M1/M2 芯片，Node.js 需要 arm64 版本

### Linux 用户注意事项

- Electron 版调度器仅提供 Windows 二进制，Linux 用户请使用开发模式：`npm run dev`
- 或编译本地版本：`npm run build`

## 常见问题

### Q: 调度器无法启动 Claude？

确保 `claude` 命令可用：

```bash
claude --version
```

### Q: Worker 卡住怎么办？

点击 Worker 日志面板右上角的 **✕** 按钮终止进程，任务会重置为待执行状态。

### Q: 如何调整超时时间？

点击调度器界面的 **Settings** 按钮，可配置：
- 空闲超时（默认 5 分钟）
- 慢工具超时（codex/gemini 60分钟，npm install 15分钟）

### Q: 失败任务如何重试？

失败任务行会显示 **↻** 重试按钮，点击后会级联重置依赖该任务的后续任务。

## 注意事项

- 调度器使用 `--dangerously-skip-permissions` 启动 Claude，请仅在可信项目中使用
- 任务依赖设计合理可避免代码冲突，调度器不检测文件级冲突
- 失败状态仅保存在内存中，只有成功状态会写入 AUTO-DEV.md

## 相关链接

- [OpenSpec GitHub](https://github.com/Fission-AI/OpenSpec)
- [Claude Code 官方文档](https://docs.anthropic.com/claude-code)

## 架构演进

### Phase 4: Claude-First Architecture (2026-01)

**核心变更**：所有任务统一由 Claude 执行，通过 MCP 工具智能委派

- **统一入口**：所有任务类型（前端/后端/测试）都由 Claude Worker 处理
- **智能委派**：Claude 根据任务特征决定是否调用：
  - `mcp__codex__codex`: 后端逻辑、算法、Debug 任务
  - `mcp__gemini__gemini`: 前端 UI、样式、组件任务
- **路由规则**：`routing-registry.ts` 提供委派提示，但最终决策权在 Claude
- **废弃特性**：直接实例化 Codex/Gemini Worker 的方式已移除

**新增模块**：
- `worker-factory.ts`: 工厂模式 + 路由预览
- `routing-registry.ts`: 任务到模型的路由规则库
- `scheduler/` 子系统：
  - `compile-checker.ts`: TypeScript 编译检查
  - `issue-tracker.ts`: 跨任务问题追踪
  - `resilience-manager.ts`: API 错误恢复
  - `session-persistence.ts`: 会话暂停/恢复
  - `task-manager.ts`: 任务生命周期管理
  - `worker-pool.ts`: Worker 实例池
- `metadata-validator.ts`: AUTO-DEV.md 格式校验
- `artifact-store.ts`: 任务输出物管理

**UI 增强**：
- `ModelDistributionChart.vue`: ECharts 模型使用分布图
- `DelegationTrace.vue`: 可视化委派流程
- `ApiErrorOverlay.vue`: API 速率限制处理
- `TaskCards.vue`/`WavesCard.vue`: 卡片式任务视图
- `ProgressCard.vue`/`ControlCard.vue`: 增强控制面板

## 更新日志

### v1.5.0 (2026-01) - Phase 4 Release

**重大架构变更**
- Claude-First 架构：统一通过 Claude 路由所有任务
- Worker Factory 模式：集中式 Worker 创建与路由
- Scheduler 子系统重构：模块化的调度器组件
- 智能委派系统：基于任务特征的自动模型选择

**新功能**
- ECharts 可视化：模型使用分布、任务进度图表
- 委派追踪：实时显示 Claude → Codex/Gemini 委派链路
- 元数据校验：AUTO-DEV.md 格式自动检查
- Artifact 管理：任务输出物集中存储
- 测试支持：集成 Vitest 测试框架

**依赖更新**
- 新增：`echarts` ^6.0.0
- 新增：`vue-echarts` ^8.0.1
- 新增：`vitest` ^2.1.0

### v1.4.0 (2024-12)

**新功能**
- 会话持久化：Issue、任务状态、暂停原因跨会话保存，重启后自动恢复
- 设置持久化：Watchdog、AutoRetry 配置跨项目保存到 userData
- Blocker 自动暂停：检测到 blocker 级别问题时自动暂停，显示模态弹窗提示
- 暂停原因追踪：区分用户手动暂停和 blocker 自动暂停

**Bug 修复**
- 修复 Windows GUI 模式下 EPIPE 崩溃：console.log 写入已关闭的 stdout 管道导致应用崩溃
- 添加全局 EPIPE 错误处理：防止 stdout/stderr 管道断开时崩溃

**改进**
- Settings 对话框新增 Blocker 自动暂停开关
- 状态栏显示暂停原因（用户/blocker）

### v1.3.0 (2024-12)

**新功能**
- Issue 收集面板：Worker 运行时自动收集问题报告，按严重级别分类（blocker/error/warning）
- Issue 去重合并：相同问题自动合并，记录出现次数
- Issue 注入集成任务：INT-*/INTEGRATION* 任务启动时自动注入待解决 Issue 列表
- Issue 报告协议：Worker 发现跨任务问题时输出 `AUTO_DEV_ISSUE: {...}` 格式报告
- 自动重试：任务失败后自动调度重试，可配置最大重试次数（默认 2 次）
- 指数退避：重试延迟采用指数退避 + 随机抖动，避免雷鸣群效应
- 重试倒计时：任务表格显示实时倒计时，提示距下次重试的时间
- 配置 UI：Settings 对话框新增自动重试配置项（启用/禁用、最大次数、基础延迟）

**改进**
- 重试耗尽前不级联失败：给瞬态错误（网络波动、资源竞争）自动恢复的机会
- 手动重试时重置自动重试状态：确保完整的重试配额
- 状态栏显示 Issue 计数和 blocker 数量
- auto-dev.md 新增强制问题报告协议（Mandatory Issue Reporting）

### v1.2.0 (2024-12)

**新功能**
- 任务状态持久化：启动时尊重文件中已完成的任务状态
- 自动更新 checkbox：任务成功后自动将 `[ ]` 改为 `[x]`
- DELIVERY 任务规范：新增交付文档生成任务

**Bug 修复**
- 修复 checkbox 解析：支持缩进列表、`+` 标记、大写 `[X]`
- 修复慢工具超时被覆盖问题

### v1.1.0 (2024-12)

**架构变更**
- 移除 Git 同步和分布式锁，改为内存状态管理
- 简化流程，任务完成后正常退出即可

**新功能**
- 任务重试：失败任务一键重试
- 慢工具超时：codex/gemini 60分钟，npm 15-20分钟

### v1.0.0 (2024-12)

- Electron + Vue 3 桌面应用
- Watchdog 健康监控
- 可视化任务管理

---

## 捐助

如果这个项目对你有帮助，欢迎请作者喝杯咖啡 ☕

<img src="docs/images/ali-pay.png" alt="支付宝" width="300">

*使用支付宝扫码捐助*

---

## 致谢

- [OpenSpec](https://github.com/Fission-AI/OpenSpec) - 规格驱动开发框架
