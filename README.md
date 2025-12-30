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
用户需求 → /openspec:proposal → 生成 AUTO-DEV.md → /openspec:apply → 调度器执行 → 验收 → /openspec:archive
```

### 1. 创建提案

```bash
/openspec:proposal my-feature
```

与 Claude 讨论需求，生成方案文档和 `AUTO-DEV.md` 任务文件。

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

在目标项目根目录运行 PowerShell：

```powershell
irm https://raw.githubusercontent.com/zengruifeng56-del/auto-dev-scheduler/master/install.ps1 | iex
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

- Windows（Mac/Linux 未充分测试）
- Node.js >= 20
- Claude CLI 已安装并配置

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

## 更新日志

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
