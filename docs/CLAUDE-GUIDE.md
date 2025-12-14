# Auto-Dev Scheduler 使用指南（AI 专用）

本文档供 Claude 读取，帮助用户使用 Auto-Dev Scheduler。

## 核心概念（必读）

**AUTO-DEV.md 是调度器执行的核心文件**。没有这个文件，调度器无法工作。

### OpenSpec 完整流程

```
用户需求
    ↓
/openspec:proposal {change-id}
    ↓
生成 openspec/changes/{change-id}/
├── proposal.md   (为什么、改什么)
├── design.md     (技术决策)
├── tasks.md      (细粒度清单)
└── specs/        (规格变更)
    ↓
【关键】生成 openspec/execution/{项目}/AUTO-DEV.md
    ↓
/openspec:apply {change-id}
    ↓
启动 Auto-Dev Scheduler → 多 Claude 并发执行
```

**重要**：使用 `/openspec:proposal` 完成需求分析后，**必须**生成 `AUTO-DEV.md` 文件，这是调度器的执行入口。

## 快速回答模板

### 用户问"怎么启动调度器"

使用 `/openspec:apply` 命令一键启动：

```
/openspec:apply {方案文件夹名}
```

例如：`/openspec:apply my-feature`

该命令会自动定位 AUTO-DEV.md 并启动调度器。

### 用户问"怎么创建任务文件"

1. 先使用 `/openspec:proposal {change-id}` 完成需求分析
2. 然后创建 `openspec/execution/{项目名}/AUTO-DEV.md`
3. 使用以下模板：

```markdown
# {项目名} 并发开发任务

## 并行波次图

Wave 1:  [TASK-01 第一个任务]
              ↓
Wave 2:  [TASK-02 第二个任务] ←→ [TASK-03 第三个任务]  (可并行)
              ↓
Wave 3:  [TASK-04 最后任务]

## 任务详情

### Task: TASK-01 第一个任务

**预估上下文**：~30k tokens
**状态**：🟦 空闲
**依赖**：无

**必读**：
- 相关文档路径

**范围**：
- [ ] 具体工作项1
- [ ] 具体工作项2

**验收标准**：
- [ ] 验收条件1
- [ ] 验收条件2

---

### Task: TASK-02 第二个任务

**预估上下文**：~40k tokens
**状态**：🟦 空闲
**依赖**：TASK-01

**范围**：
- [ ] 工作项

**验收标准**：
- [ ] 验收条件
```

### 用户问"任务ID格式"

支持 `XX-YYY` 格式，例如：
- `FE-01`, `FE-AUTH-01` - 前端任务
- `BE-01`, `BE-API-02` - 后端任务
- `TASK-001` - 通用任务

### 用户问"依赖怎么写"

```markdown
**依赖**：无                           # 无依赖
**依赖**：TASK-01                      # 单个依赖
**依赖**：TASK-01, TASK-02             # 多个依赖
**依赖**：TASK-01（可与 TASK-02 并行）  # 括号内是注释，不计入依赖
```

### 用户问"状态含义"

| 状态 | 含义 |
|------|------|
| 🟦 空闲 | 可被认领执行 |
| 🟠 执行中（实例ID, 时间） | 正在被某个 Claude 执行 |
| ✅ 已完成（时间） | 任务完成 |
| ⚠️ 阻塞 | 需要人工处理 |

### 用户问"调度器界面功能"

- **上方**：任务列表，显示状态、波次、耗时
- **下方**：Worker 日志面板，每个 Claude 实例一个
- **按钮**：Start（开始）、Pause（暂停）、Stop（停止）
- **并发**：右上角下拉框选择 1-4 个并行 Worker
- **Kill**：每个日志面板右上角，可终止单个 Worker
- **输入框**：日志面板底部，可向 Worker 发送消息

### 用户问"Worker 卡住怎么办"

1. 点击对应日志面板右上角的 `Kill` 按钮
2. 任务状态会保持，下次启动会重新分配

### 用户问"/auto-dev 命令是什么"

`/auto-dev` 是 Claude Code 的自定义命令，定义在 `.claude/commands/auto-dev.md`。

功能：
1. 扫描 `openspec/execution/*/AUTO-DEV.md` 找可执行任务
2. 通过 git push 抢占任务锁
3. 执行任务内容
4. 完成后更新状态并释放锁

调度器会自动向每个 Worker 发送 `/auto-dev` 命令启动执行。

## 文件位置速查

| 文件 | 路径 |
|------|------|
| 调度器主程序 | `tools/auto-dev-scheduler/auto-dev-scheduler.ps1` |
| 启动脚本 | `tools/auto-dev-scheduler/run.bat` |
| /auto-dev 命令 | `.claude/commands/auto-dev.md` |
| 任务文件（核心） | `openspec/execution/{项目}/AUTO-DEV.md` |
| 项目配置 | `openspec/project.md` |
| AI 代理指南 | `openspec/AGENTS.md` |
