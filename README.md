# Auto-Dev Scheduler (ADS)

> **Multi-Claude Parallel Development Orchestrator** 🚀
>
> 基于 OpenSpec 规范的智能并发开发调度系统，让多个 Claude 实例协同工作，加速开发流程。
>
> **版本**: v2.0 | **License**: MIT | **支持**: Windows / macOS / Linux

> ⚠️ **Token 成本提醒**
>
> 每个 Worker 是独立的 Claude 进程，上下文无法共享：
> - 每个任务启动时都要重新读取项目配置（CLAUDE.md、openspec/）
> - 每个 Worker 需要独立理解代码库结构
> - **10 个任务 = 10 次项目理解开销**（与并发数无关）
>
> 权衡：用更多 Token 换取更快的开发速度。建议合理控制任务粒度，避免拆分过细。

## ✨ 核心功能

### Phase 4 Claude-First Architecture

- **🔀 Claude-First 路由**: 所有任务统一由 Claude 执行，通过 MCP 工具智能委派给 Codex/Gemini
- **🎯 智能委派**: Claude 根据任务特征自动决定是否调用：
  - `mcp__codex__codex`: 后端逻辑、算法、Bug 修复
  - `mcp__gemini__gemini`: 前端 UI、样式、交互设计
- **📊 ECharts 可视化**: 实时模型分布图、任务进度图表、委派链路追踪
- **⚡ 并发执行**: 1-4 个 Claude Worker 同时工作，支持 Wave 波次和依赖管理
- **👁️ 可视化监控**: 实时查看任务状态、Worker 日志、Token 消耗、模型分布
- **🏥 健康监控**: Watchdog 进程检测、活动超时检测、分层诊断（规则 + AI）
- **💾 状态持久化**:
  - 任务完成自动更新 AUTO-DEV.md checkbox
  - Issue 追踪跨会话保存
  - Worker 委派历史记录
- **🛡️ 错误恢复**: API 速率限制处理、指数退避重试、自动恢复机制
- **🔧 OpenSpec 集成**: 完整支持 proposal → apply → archive 工作流

## 🎯 工作流程

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  需求分析   │ → │  OpenSpec    │ → │  AUTO-DEV    │ → │  并发执行    │
│ (User)      │     │  规范化      │     │  生成        │     │  (Scheduler) │
└─────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
                           ↓
                    /openspec:proposal
                           ↓
            proposal.md + tasks.md + design.md
                           ↓
                      ┌─────────────────┐
                      │   审核批准      │
                      │  (Peer Review)  │
                      └─────────────────┘
                           ↓
                   手动转换为 AUTO-DEV.md
                           ↓
                    /openspec:apply
                           ↓
                  Electron 调度器启动
                           ↓
              多 Claude Worker 并发执行
                           ↓
                      验收测试 (QA)
                           ↓
                    /openspec:archive
                           ↓
                    功能归档完成
```

### 关键步骤说明

| 步骤 | 命令 | 工件 | 说明 |
|------|------|------|------|
| **规范化** | `/openspec:proposal` | proposal.md, tasks.md, design.md | 使用 OpenSpec 规范创建变更提案 |
| **转换** | 手动/模板 | AUTO-DEV.md | 将细粒度 tasks 转为粗粒度并发任务 |
| **执行** | `/openspec:apply` | Electron GUI | 启动调度器并发执行 |
| **归档** | `/openspec:archive` | archive/ | 归档完成的变更到规范库 |

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

## 📋 系统要求

### 硬件要求

| 配置 | 最低 | 推荐 |
|------|------|------|
| CPU | 2 核 | 4 核+ |
| RAM | 4 GB | 8 GB+ |
| 磁盘 | 500 MB | 2 GB+ |
| 网络 | 稳定连接 | 高速网络 |

### 软件要求

- **操作系统**: Windows 10+ / macOS 12.0+ / Ubuntu 20.04+
- **Node.js**: >= 20 (推荐 20.10+)
- **npm**: >= 10.0
- **Git**: >= 2.30
- **Claude CLI**: 必需 (最新版本)
- **OpenSpec CLI**: 必需 (用于 proposal/archive 命令)

### 平台特定说明

#### Windows
- ✅ 完整支持，Electron 应用 + NSIS 安装程序
- 推荐使用 PowerShell 运行安装脚本

#### macOS (New in v2.0)
- ✅ 完整支持，包括 M1/M2 ARM64 芯片
- 需要 Command Line Tools: `xcode-select --install`
- 推荐使用 Homebrew: `brew install node openspec`
- 详见 **MAC_GUIDE.md**

#### Linux (New in v2.0)
- ✅ 完整支持，多发行版覆盖 (Ubuntu/Debian/Fedora/CentOS/Arch)
- 支持开发模式和 Docker 容器化部署
- 支持 Systemd 服务集成（生产环境）
- 详见 **LINUX_GUIDE.md**

## ❓ 常见问题

### Q1: 调度器无法启动 Claude？

**解决**:
```bash
# 检查 Claude CLI 是否安装
claude --version

# 检查 API Key 配置
echo $ANTHROPIC_API_KEY

# 如果都没问题，在调度器设置中重新配置
# Settings → 输入正确的 claude 命令路径
```

### Q2: Worker 卡住或无响应？

**解决**:
1. 点击 Worker 日志面板右上角的 **✕** 按钮终止进程
2. 任务会自动重置为待执行状态
3. 点击 **重试** 按钮重新执行
4. 如果频繁卡住，调整超时配置

### Q3: 如何调整超时时间？

**操作步骤**:
1. 点击调度器界面的 **⚙️ Settings** 按钮
2. 可配置以下项：
   - **普通操作超时**: 默认 10 分钟
   - **慢工具超时** (Codex/Gemini): 默认 60 分钟
   - **npm install 超时**: 默认 15 分钟
   - **Blocker 自动暂停**: 启用自动暂停
   - **自动重试**: 启用自动重试（最多 2 次）

### Q4: 失败任务如何重试？

**自动重试**:
- 启用 Settings 中的"自动重试"
- 失败任务会自动重试（指数退避）
- 显示实时倒计时

**手动重试**:
- 点击失败任务行的 **↻** 按钮
- 会级联重置依赖该任务的后续任务

### Q5: 调度器占用太多内存？

**优化**:
```bash
# 增加 Node.js 内存限制
export NODE_OPTIONS="--max-old-space-size=4096"
npm run dev

# 或减少并发 Worker 数量
# Settings → 设置为 1-2 个 Worker
```

### Q6: Windows/Mac/Linux 上安装失败？

**解决**:
- Windows: 查看 README 的 Windows 安装部分
- macOS: 查看 **MAC_GUIDE.md**
- Linux: 查看 **LINUX_GUIDE.md**

这三份文档包含各平台的完整故障排查步骤。

### Q7: 如何使用 Docker 运行？

**仅限 Linux 用户**：

```bash
# 使用 docker-compose
docker-compose up

# 访问 http://localhost:5174
```

详见 **LINUX_GUIDE.md** 的 Docker 部分。

## ⚠️ 注意事项

### 安全性
- 调度器使用 `--dangerously-skip-permissions` 启动 Claude，**仅在可信项目中使用**
- 不要在生产环境直接运行调度器，使用受控的 Docker 容器

### 性能和成本
- 每个 Worker 是独立的 Claude 进程，上下文**无法共享**
- 10 个任务 = 10 次完整的项目理解开销（与并发数无关）
- **建议**: 合理控制任务粒度，避免拆分过细（每个任务 > 2 小时工作量）

### 并发控制
- 任务依赖设计合理可避免代码冲突，**调度器不检测文件级冲突**
- Wave 序列严格按顺序执行，同 Wave 内的任务并发执行
- 避免在 Wave 间设置过多依赖关系

### 状态管理
- 失败状态仅保存在**内存**中，调度器重启后丢失
- 只有 **成功状态** 会写入 AUTO-DEV.md（持久化）
- Issue 追踪状态会跨会话持久化（存储到 userData）

### 网络和超时
- Claude CLI 调用需要**稳定网络**
- 慢速网络环境建议增加超时时间
- 某些工具调用（codex/gemini）可能耗时较长，默认 60 分钟超时

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

## 📚 文档导航

| 用户类型 | 首先阅读 | 然后阅读 |
|---------|---------|---------|
| **新用户** | README.md | 平台特定指南 (MAC_GUIDE.md / LINUX_GUIDE.md) |
| **Windows 用户** | 本文档 | install.ps1 + TROUBLESHOOTING.md |
| **Mac 用户** | MAC_GUIDE.md | README.md |
| **Linux 用户** | LINUX_GUIDE.md | README.md, Docker 部分 |
| **升级用户** | MIGRATION.md | UPDATE-SUMMARY.md |
| **开发者** | BRAINSTORM-ANALYSIS.md | SYNC-ANALYSIS.md, 源代码 |

## 📊 更新日志

### v2.0 (2026-01-23) - Major Release with Cross-Platform Support

**🎉 重大更新**
- ✅ 品牌统一: SanGuo Tools Team → Auto-Dev Scheduler Contributors
- ✅ 完整的跨平台支持: Windows / macOS / Linux
- ✅ 新增 Mac 用户完整指南 (MAC_GUIDE.md)
- ✅ 新增 Linux 用户完整指南 + Docker 支持 (LINUX_GUIDE.md)
- ✅ OpenSpec 命令同步: 最新的 auto-dev.md
- ✅ 安装脚本增强: 自动依赖检查 + npm 安装

**🔧 技术改进**
- 增强 install.ps1: Claude CLI 和 OpenSpec CLI 强制检查
- 创建 install.sh: 跨 Unix 平台通用安装脚本
- 自动化 npm install: 减少新用户错误
- 完善 AUTO-DEV.md 生成流程文档

**📚 文档完善**
- 新增 8 个文档文件 (~60 KB)
- 补充 AUTO-DEV.md 生成指南
- 平台特定的故障排查文档
- 工作流程可视化

**支持范围**:
- Windows 10+: ✅ Electron + NSIS
- macOS 12.0+: ✅ 开发模式 + 详细指南
- Ubuntu 20.04+: ✅ 多发行版 + Docker + Systemd
- Node.js 20+: ✅ 完整支持

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
