# OpenSpec 执行任务索引

> 多 Claude 并发执行任务追踪
>
> **执行规范**：[auto-dev.md](../../.claude/commands/auto-dev.md)
> **OpenSpec 指南**：[AGENTS.md](../AGENTS.md)

---

## 工作流程

```
用户需求
    ↓
OpenSpec 创建提案 (/openspec:proposal)
    ↓
openspec/changes/{change-id}/
├── proposal.md   ← 为什么、改什么
├── design.md     ← 技术决策
├── tasks.md      ← 细粒度清单（单人用）
└── specs/        ← 规格变更
    ↓
批准后转为并发任务
    ↓
openspec/execution/{project}/AUTO-DEV.md  ← 粗粒度任务（多 Claude 用）
    ↓
/auto-dev 并发执行
    ↓
完成后 OpenSpec 归档 (/openspec:archive)
```

---

## 任务文档规范

- **路径**：`openspec/execution/{项目}/AUTO-DEV.md`
- **来源**：基于 `openspec/changes/{change-id}/tasks.md` 按可并行维度重组
- **结构**：项目概述 → **并行波次图（必需）** → 任务详情（状态、依赖、范围、验收标准）

### 并行波次图格式（必需）

Auto-Dev Scheduler 依赖波次图确定任务显示顺序。格式要求：

```markdown
## 并行波次图

Wave 1:  [TASK-ID-1 简述]
              ↓
Wave 2:  [TASK-ID-2] ←→ [TASK-ID-3]  (可并行)
              ↓
Wave 3:  [TASK-ID-4]
```

**规则**：
- 必须使用 `## 并行波次图` 作为标题
- 每行格式：`Wave N:  [任务ID ...]`
- 同一 Wave 内的任务可并行执行
- 任务ID 必须与 `### Task: ID` 中的 ID 一致
- 调度器按 Wave 编号排序显示任务

---

## 进行中的项目

| 项目 | 简述 | OpenSpec 来源 | 状态 | 进度 | 前置条件 |
|------|------|---------------|------|------|----------|
| (示例) | 项目描述 | [change-id](../changes/change-id/) | 🟦 空闲 | 0/N | 无 |

---

## 并发窗口执行

```bash
/auto-dev
```

**流程**：`git pull` → 扫描 `execution/*/AUTO-DEV.md` → 选空闲任务 → 抢锁(git push) → 执行 → 标记完成

---

## 状态说明

| 状态 | 含义 | 可操作 |
|------|------|--------|
| 🟦 空闲 | 待认领 | ✅ 可抢 |
| ⏳ 待开始 | 依赖未满足 | ❌ 等依赖 |
| 🟠 执行中（实例ID, 时间） | 正在开发 | ❌ 已占用 |
| ✅ 已完成（时间） | 完成 | - |
| ⚠️ 阻塞 | 遇到问题 | ❓ 需人工 |
