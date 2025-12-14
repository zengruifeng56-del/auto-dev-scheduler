---
name: OpenSpec: Proposal
description: Scaffold a new OpenSpec change and validate strictly.
category: OpenSpec
tags: [openspec, change]
---

# OpenSpec Proposal - 创建变更提案

你收到了用户指令：创建 OpenSpec 变更提案 `$ARGUMENTS`

---

## 核心原则

- 在提案阶段**不要写任何代码**，只创建设计文档
- 识别任何模糊或不明确的细节，在编辑文件之前询问必要的后续问题
- 参考 `openspec/AGENTS.md` 了解 OpenSpec 规范

---

## Step 1: 理解项目上下文

**必须先阅读**：
1. `openspec/project.md` - 了解项目背景、技术栈、约束条件
2. `openspec/specs/` - 现有的规格文档
3. `openspec/changes/` - 正在进行的变更

---

## Step 2: 澄清需求

与用户讨论：
1. 这个变更要解决什么问题？
2. 期望的结果是什么？
3. 有什么约束条件？
4. 影响哪些现有功能？

**循环讨论直到双方理解一致。**

---

## Step 3: 创建提案文件

确定 `change-id`（使用 kebab-case，动词开头，如 `add-user-auth`）

创建目录结构：
```
openspec/changes/{change-id}/
├── proposal.md     # 为什么、改什么
├── design.md       # 技术决策（复杂变更需要）
├── tasks.md        # 实现清单
└── specs/          # 规格增量（可选）
    └── {capability}/
        └── spec.md
```

### proposal.md 模板

```markdown
# Change: {变更简述}

## Why（为什么）
{1-2 句话说明问题或机会}

## What Changes（改什么）
- {变更点 1}
- {变更点 2}
- **BREAKING**: {破坏性变更，如有}

## Impact（影响范围）
- 影响的规格：{列出}
- 影响的代码：{关键文件/系统}
```

### tasks.md 模板

```markdown
# Implementation Tasks

## 1. {阶段 1}
- [ ] 1.1 {具体任务}
- [ ] 1.2 {具体任务}

## 2. {阶段 2}
- [ ] 2.1 {具体任务}
- [ ] 2.2 {具体任务}

## Validation
- [ ] 所有测试通过
- [ ] 类型检查通过
- [ ] 构建成功
```

---

## Step 4: 创建 AUTO-DEV.md（关键！）

这是调度器执行的核心文件。创建 `openspec/execution/{项目}/AUTO-DEV.md`：

```markdown
# {项目名} 并发开发任务

## 并行波次图

Wave 1:  [{TASK-01} 任务描述]
              ↓
Wave 2:  [{TASK-02} 任务] ←→ [{TASK-03} 任务]  (可并行)
              ↓
Wave 3:  [{TASK-04} 最终任务]

## 任务详情

### Task: {TASK-01} 任务名称

**预估上下文**：~{N}k tokens
**状态**：🟦 空闲
**依赖**：无

**必读**：
- {相关文档或代码路径}

**范围**：
- [ ] {具体工作项}

**验收标准**：
- [ ] {验收条件}

---

（继续添加其他任务...）
```

---

## 执行清单

- [ ] 阅读 project.md 了解项目背景
- [ ] 与用户讨论澄清需求
- [ ] 创建 proposal.md
- [ ] 创建 tasks.md
- [ ] 创建 design.md（如需要）
- [ ] **创建 AUTO-DEV.md**（必须！）
- [ ] 告知用户使用 `/openspec:apply {change-id}` 执行
