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
- **结构**：项目概述 → **Wave章节** → 任务详情（状态、依赖、范围、验收标准）

### ⚠️ 调度器解析格式（强制要求）

> **重要**：AUTO-DEV.md 必须严格遵循以下格式，否则调度器无法解析任务！

#### Wave 章节格式

```markdown
## Wave 1: 章节描述

### TASK-01: 任务标题

- [ ] 任务描述

**依赖**: 无

...任务详情...

---

### TASK-02: 另一个任务

- [ ] 任务描述

**依赖**: TASK-01

...
```

#### 格式规则（必须遵守）

| 元素 | 格式 | 示例 | 说明 |
|------|------|------|------|
| Wave标题 | `## Wave N: 描述` | `## Wave 1: 资源准备` | 两个 `#`，N为数字 |
| 任务标题 | `### {ID}: {Title}` | `### W1-T1: 创建目录` | 三个 `#`，ID支持字母数字点横杠 |
| 任务标记 | `- [ ] 描述` | `- [ ] 执行任务` | **必须包含**，否则任务不被识别 |
| 依赖声明 | `**依赖**: ID列表` | `**依赖**: W1-T1, W1-T2` | 或使用 `**依赖**：` (中文冒号) |

#### 任务ID格式

调度器支持通用格式 `[\w.-]+` (字母、数字、点、横杠)：

```
有效ID: W1-T1, TASK-01, FE-AUTH-01, BE.API.01, task_001
无效ID: (空), ---, ...
```

#### 任务块必要元素

每个任务块**至少包含以下之一**，否则会被忽略：
1. `- [ ]` 或 `- [x]` 或 `- [~]` checkbox
2. `**依赖**:` 或 `**依赖**：` 字段
3. `**状态**:` 或 `**状态**：` 字段

### REVIEW-SYNC 任务（必需）

> **重要**：每个 AUTO-DEV.md **必须**在倒数第二个 Wave 包含 `REVIEW-SYNC` 任务！

该任务负责：
1. 审核代码改动与 tasks.md 的一致性
2. 验证每个任务是否完成
3. 勾选 tasks.md 中已完成任务的 checkbox

**标准模板**：
```markdown
## Wave N: 审核与同步

### REVIEW-SYNC: 审核改动并同步任务状态

- [ ] 审核 tasks.md 与代码改动的一致性

**依赖**: {前一个 Wave 的所有任务 ID}

**执行步骤**:
1. 读取 `openspec/changes/{change-id}/tasks.md`
2. 对比当前代码改动（git diff 或逐文件审查）
3. 逐项验证 tasks.md 中每个任务是否完成
4. 将已完成任务的 `- [ ]` 改为 `- [x]`
5. 未完成任务保留 `- [ ]` 并记录原因

**验收标准**:
- tasks.md 所有已完成任务标记为 [x]
- 验收检查清单同步更新
- 未完成项有明确原因说明
```

**规则**：
- REVIEW-SYNC 必须是倒数第二个 Wave 的唯一任务
- 依赖所有前序任务（确保实施完成后执行）
- 执行时使用 Edit 工具修改 tasks.md

### DELIVERY 任务（必需）

> **重要**：每个 AUTO-DEV.md **必须**在最后一个 Wave 包含 `DELIVERY` 任务！

该任务负责：
1. 生成交付文档 `DELIVERY.md`
2. 汇总所有已完成任务的成果
3. 提供测试指南和归档流程

**标准模板**：
```markdown
## Wave N+1: 生成交付文档

### DELIVERY: 生成交付文档

- [ ] 生成 DELIVERY.md 交付文档

**依赖**: REVIEW-SYNC

**执行步骤**:
1. 读取 `openspec/changes/{change-id}/proposal.md` 获取变更概述
2. 读取 `openspec/changes/{change-id}/tasks.md` 获取已完成任务列表
3. 生成 `openspec/execution/{project}/DELIVERY.md`，包含：
   - 完成内容摘要（按 Wave 分组列出已完成任务）
   - 新增/修改文件清单
   - 测试指南（构建验证、功能测试、验收标准）
   - 归档流程（/openspec:archive 命令）
   - 相关文档链接

**验收标准**:
- DELIVERY.md 文件已生成
- 包含所有已完成任务的摘要
- 测试指南清晰可执行
- 归档命令正确
```

**规则**：
- DELIVERY 必须是最后一个 Wave 的唯一任务
- 依赖 REVIEW-SYNC 任务
- 参考 `DELIVERY-TEMPLATE.md` 生成交付文档

**正确示例**：
```markdown
### W1-T1: 创建目录结构

- [ ] 创建图标存放目录

**依赖**: 无

**执行步骤**:
...
```

**错误示例**（会被忽略）：
```markdown
### W1-T1: 创建目录结构

创建图标存放目录    # ❌ 没有checkbox也没有依赖/状态字段

执行步骤:
...
```

### 并行波次图（⚠️ 必需）

> **重要**：调度器通过并行波次图识别任务波次，**必须**包含此章节！

```markdown
## 并行波次图

Wave 1: TASK-01, TASK-02, TASK-03
Wave 2: TASK-04, TASK-05
Wave 3: TASK-06

---
```

**规则**：
- 章节标题必须是 `## 并行波次图`
- 每行格式：`Wave N: ID1, ID2, ID3` (逗号分隔)
- 同一 Wave 内的任务可并行执行
- 任务ID 必须与 `### {ID}: {Title}` 中的 ID **完全一致**
- 放置在文档开头（变更概述之后，Wave详情章节之前）

### 任务ID格式

调度器支持通用格式 `XX-YYY`，示例：

| 前缀 | 用途 | 示例 |
|------|------|------|
| `FE-` | 前端任务 | FE-01, FE-AUTH-01 |
| `BE-` | 后端任务 | BE-API-01, BE-DB-02 |
| `GM-` | 游戏管理 | GM-00, GM-TOOL-01 |
| `TASK-` | 通用任务 | TASK-001, TASK-002 |
| `TEST-` | 测试任务 | TEST-UNIT-01 |

### 依赖声明格式

依赖字段支持多种写法：

```markdown
**依赖**：无
**依赖**：None
**依赖**：BE-01
**依赖**：BE-01, FE-01
**依赖**：BE-01（可与 FE-01 并行）   # 括号内为注释，不计入依赖
```

> 括号内的内容会被自动忽略，仅提取实际的任务 ID 作为依赖。

### 任务状态流转

```
- [ ] 空闲 → - [~] 执行中 → - [x] 已完成
                  ↓
              ⚠️ 失败（需人工处理）
```

> **调度器自动更新**：任务完成后，调度器会自动将 `- [ ]` 更新为 `- [x]`，Claude 无需手动修改 AUTO-DEV.md。

---

## 进行中的项目

| 项目 | 简述 | OpenSpec 来源 | 状态 | 进度 | 前置条件 |
|------|------|---------------|------|------|----------|
| example-feature | 示例功能 | example-change-id | 🟦 待执行 | 0/5 | 无 |

> 💡 使用 `/openspec:apply {change-id}` 添加新项目

---

## 并发窗口执行

```bash
/auto-dev
```

**流程**：调度器扫描 `execution/*/AUTO-DEV.md` → 分配任务给 Claude → 执行 → 调度器更新状态

---

## 状态说明

| 状态 | 含义 |
|------|------|
| `- [ ]` | 待执行 |
| `- [~]` | 执行中 |
| `- [x]` | 已完成 |
| `⚠️ 失败` | 需人工处理 |
