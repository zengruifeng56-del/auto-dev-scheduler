# OpenSpec + Auto-Dev Scheduler

多 Claude 并发开发框架，让多个 Claude Code 实例同时执行开发任务，通过 Git 分布式锁机制避免冲突。

## 核心功能

### 1. Auto-Dev Scheduler（GUI 调度器）

可视化任务调度界面，主要功能：

- **任务解析**：自动解析 AUTO-DEV.md 文件，识别任务ID、状态、依赖关系
- **波次排序**：按并行波次图顺序显示任务，直观展示执行顺序
- **并发控制**：支持 1-4 个 Claude 实例并行执行
- **实时日志**：每个 Worker 独立日志面板，实时显示执行过程
- **进度追踪**：进度条显示整体完成情况
- **耗时统计**：显示运行中和已完成任务的耗时（支持超过1小时）
- **Worker 管理**：
  - 启动/暂停/停止全部
  - 单独 Kill 某个 Worker
  - 向 Worker 发送自定义消息
- **日志导出**：导出所有 Worker 日志到文件
- **字体调节**：日志面板字体大小可调
- **深色主题**：VS Code 风格深色界面
- **命令行参数**：支持启动时指定 AUTO-DEV.md 文件路径

### 2. /auto-dev 命令（执行协议）

Claude Code 的并发执行规范，核心机制：

- **Git 分布式锁**：通过 git push 抢占任务，避免多实例冲突
- **状态机管理**：
  - `🟦 空闲` → 可认领
  - `🟠 执行中（实例ID, 时间）` → 已被占用
  - `✅ 已完成（时间）` → 完成
- **依赖检查**：自动检查前置任务是否完成
- **冲突处理**：push 失败自动回滚并重试
- **质量保证**：强制通过测试、类型检查、构建

### 3. OpenSpec（规格驱动开发）

结构化的变更管理流程：

- **提案驱动**：先写 proposal.md 说明为什么、改什么
- **规格优先**：通过 spec.md 定义需求和验收标准
- **任务拆分**：tasks.md 细粒度清单，AUTO-DEV.md 粗粒度并发任务
- **变更归档**：完成后归档到 archive/，保留历史记录

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
    └── auto-dev-scheduler/
        ├── auto-dev-scheduler.ps1    # 调度器主程序
        └── run.bat                   # 启动脚本
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

1. 下载所有必需文件到当前目录
2. 创建/更新 CLAUDE.md，添加 OpenSpec 引用
3. 生成 project.md 模板供编辑

## 使用流程

```
┌─────────────────────────────────────────────────────────────┐
│  1. 安装          运行 install.ps1                          │
│       ↓                                                     │
│  2. 说需求        /openspec:proposal my-feature             │
│       ↓           告诉 Claude 你要做什么                     │
│       ↓                                                     │
│  3. 讨论确认      Claude 提问 ←→ 你回答                      │
│       ↓           直到双方理解一致                           │
│       ↓                                                     │
│  4. 生成任务      Claude 自动生成 AUTO-DEV.md               │
│       ↓                                                     │
│  5. 并发执行      /openspec:apply my-feature                │
│       ↓           调度器启动，多 Claude 并行开发             │
│       ↓                                                     │
│  6. 测试验收      你测试功能，确认没问题                      │
│       ↓                                                     │
│  7. 归档          /openspec:archive my-feature              │
└─────────────────────────────────────────────────────────────┘
```

### 第一步：安装

```powershell
irm https://raw.githubusercontent.com/zengruifeng56-del/auto-dev-scheduler/master/install.ps1 | iex
```

### 第二步：告诉 Claude 你的需求

```
/openspec:proposal my-feature
```

然后用自然语言描述你要做什么，比如：
- "我要给系统加一个用户登录功能"
- "帮我重构订单模块，支持多种支付方式"

### 第三步：和 Claude 讨论确认

Claude 会：
1. 提问澄清不明确的地方
2. 分析技术方案
3. 拆解任务和依赖关系

**你需要**：回答问题，确认方案，直到双方理解一致。

### 第四步：Claude 生成执行文件

确认后，Claude 会自动生成：
- `openspec/changes/my-feature/` - 方案文档
- `openspec/execution/{项目}/AUTO-DEV.md` - **调度器执行文件（核心）**

### 第五步：启动并发执行

```
/openspec:apply my-feature
```

调度器 GUI 启动后：
1. 点击「Start」开始执行
2. 多个 Claude 实例并行工作
3. 实时查看各任务进度和日志

### 第六步：测试验收

所有任务完成后，**你自己测试**：
- 功能是否正常
- 是否符合预期

### 第七步：归档（可选）

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
    ▼ (抢锁成功)                               │
🟠 执行中（Claude-Terminal-1234, 时间）        │
    │                                         │
    ├──▶ ✅ 已完成（时间）                     │
    │                                         │
    └──▶ ⚠️ 阻塞（需人工处理）─────────────────┘
              │
              ▼ (问题解决后)
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

- **操作系统**：Windows（PowerShell 5.1+）
- **Claude Code**：已安装并配置 CLI
- **Git**：用于分布式锁和版本控制
- **网络**：在线安装需要访问 GitHub

## 常见问题

### Q: 调度器无法启动 Claude？

确保 `claude` 命令在 PATH 中可用，运行 `claude --version` 验证。

### Q: 任务一直显示「执行中」但实际已完成？

手动编辑 AUTO-DEV.md，将状态改为 `✅ 已完成（时间）`。

### Q: 如何添加新任务？

在 AUTO-DEV.md 中添加 `### Task: XX-YY 任务名` 块，并更新波次图。

### Q: 支持 Mac/Linux 吗？

调度器 GUI 目前仅支持 Windows。/auto-dev 命令本身跨平台可用。

## 更新日志

### v0.6.1 (2024-12)

**新功能**

- 命令行参数支持：`-AutoDevFile` 参数可指定启动时自动加载的文件
- 耗时统计：显示运行中和已完成任务的耗时

**Bug 修复**

- 修复依赖解析问题：括号内注释（如 `可与 XX 并行`）不再被误识别为依赖
- 修复耗时显示超过 1 小时回卷的问题（现在正确显示 `hh:mm:ss`）
- 增强 TaskId 识别：支持从 git commit、Edit 操作、多种文本格式中识别

**改进**

- 依赖支持 `None` 作为空依赖标记（兼容英文项目）
- 支持文件末尾无换行的情况

### v0.6.0

- 初始版本
- 深色主题 GUI
- 多 Worker 并发调度
- 实时日志面板

## 相关链接

- [Claude Code 官方文档](https://docs.anthropic.com/claude-code)
- [OpenSpec 规范说明](./openspec/AGENTS.md)
