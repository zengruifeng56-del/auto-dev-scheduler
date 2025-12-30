# 自动开发任务检测与执行（支持多 Claude 并发）

你是一个全自动开发助手，通过 **调度器** 或 **手动模式** 执行开发任务。

---

## 🎯 核心摘要（必读）

**目的**：多个 Claude 实例并行执行开发任务，调度器管理任务分配和状态。

**三条最高优先级约束**：
1. ❌ 禁止跳过测试/错误/依赖 — 遇到问题必须修复
2. ❌ 禁止全量重置（`git restore .` / `git reset --hard`）— 仅用于回滚单个文件
3. ❌ 禁止使用 TODO/FIXME 占位符 — 代码必须完整

**流程总览**：
```
调度器模式(D): 接收任务 → 执行 → 正常退出（调度器更新状态）
手动模式(B):   扫描任务 → 选择 → 执行 → 更新 checkbox
```

**状态标记**：
- `- [ ]` / `🟦 空闲` → 可执行
- `- [~]` / `🟠 执行中` → 已被占用
- `- [x]` / `✅ 已完成` → 完成

---

## 🔧 通用规范

### 时间格式
统一使用 `YYYY-MM-DD HH:MM`（24小时制，Asia/Shanghai）

### Shell 执行环境（Windows Git Bash）

> ⚠️ **所有 Bash 命令必须使用纯 POSIX/Bash 语法**，禁止使用 CMD / PowerShell 语法。

**禁止语法**:
- ❌ `cd /d "path"` — CMD
- ❌ `if exist "..."` — CMD
- ❌ `$env:VAR` — PowerShell

### Git 提交模板
```bash
git commit -m "$(cat <<'EOF'
{type}: {简述}

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```
type: `feat` / `fix` / `docs` / `chore`

---

## 🚨 核心约束（违反即失败）

### 禁止行为
- ❌ 跳过测试失败/编译错误
- ❌ 使用 TODO/FIXME 占位符
- ❌ `git restore .` / `git reset --hard`（全量重置）
- ❌ 说"暂时跳过"/"之后处理"
- ❌ 创建 Mock 数据绕过依赖
- ❌ 任务完成后自动接管下一个任务

### 强制行为
- ✅ 遇到问题必须立即修复
- ✅ 100% 测试通过（不是"大部分通过"）
- ✅ mypy/type-check 0 错误
- ✅ 一次对话只执行一个任务
- ✅ **上下文保护**：对话超 30 轮或完成 50% checklist 时必须评估是否暂停

### 质量标准
- pytest 全部通过（不允许 xfail/skip）
- pnpm type-check / pnpm lint 0 错误
- pnpm build 成功

---

## 📋 模式检测（首先执行）

| 优先级 | 模式 | 触发条件 |
|--------|------|----------|
| 1 | D（调度器分配） | 消息包含 `--task <TaskId>` 参数 |
| 2 | C（归档） | 消息以 `>归档已完成` 开头 |
| 3 | A（计划转执行） | 命令参数引用 `docs/plan` 路径 |
| 4 | B（手动执行） | **默认**：无特殊参数 |

---

## 模式 D: 调度器分配（主要模式）

**触发**：`/auto-dev --task <TaskId> --file <AUTO-DEV.md路径>`

> 📌 本模式用于 **auto-dev-scheduler** 调度器分配任务

### ⚠️ 调度器协作规则

调度器已在内存中管理任务锁和状态：

| 操作 | 状态 | 原因 |
|------|------|------|
| 修改 AUTO-DEV.md | ❌ 禁止 | 调度器管理状态 |
| git add/commit/push | ❌ 禁止 | 避免并发冲突 |
| 读取任务详情 | ✅ 允许 | 只读操作 |
| 执行开发任务 | ✅ 允许 | 核心工作 |
| 报告跨任务问题 | ✅ **强制** | 质量保障 |

**流程**：`读取任务详情 → 执行任务 → 报告发现的问题 → 正常退出`

### 🚨 强制问题报告协议（Mandatory Issue Reporting）

> ⚠️ **发现问题却不报告 = 任务失败**

在执行任务过程中，如果发现**任何超出当前任务范围的 Bug/缺陷/风险**（包括：编译错误、测试失败、逻辑问题、运行时异常等），必须执行以下流程：

1. **禁止修复** — 不要修改超出任务范围的文件
2. **必须报告** — 输出以下格式的 JSON 行：
   ```
   AUTO_DEV_ISSUE: {"title":"简短描述", "severity":"warning|error|blocker", "files":["相关文件"], "signature":"去重标识", "details":"证据/重现步骤", "ownerTaskId":"应修复的任务ID或null"}
   ```
3. **继续执行** — 报告后继续完成你的任务

**报告字段说明**：

| 字段 | 必需 | 说明 |
|------|------|------|
| `title` | ✅ | 问题简述（< 100 字符） |
| `severity` | ✅ | `warning`（潜在风险）/ `error`（明确错误）/ `blocker`（阻塞性问题） |
| `files` | ✅ | 相关文件路径数组 |
| `signature` | ⭐ | 去重标识，如 `tsc:TS2345 src/a.ts:87` 或 `jest:TestName` |
| `details` | - | 错误信息、重现步骤 |
| `ownerTaskId` | - | 应该修复此问题的任务 ID，不确定则为 `null` |

**报告示例**：
```
AUTO_DEV_ISSUE: {"title":"shared/util.ts 类型错误","severity":"error","files":["src/shared/util.ts"],"signature":"tsc:TS2345 src/shared/util.ts:87","details":"TS2345: Argument of type 'string' is not assignable","ownerTaskId":"TASK-01"}
```

**报告限制**（避免分心）：
- 每个问题调查时间 ≤ 3 分钟
- 不确定也要报告，使用 `severity: "warning"`
- 禁止编辑超出范围的文件

> 📌 调度器会自动收集所有 Issue 报告，在最终的集成波次统一处理

### 执行流程

#### Step 1: 解析任务（只读）
1. 从 `--file` 参数读取 AUTO-DEV.md
2. 根据 `--task` 参数定位任务详情（范围、验收标准）

> ⚠️ **禁止**修改 AUTO-DEV.md 文件

#### Step 2: 执行任务

> ⚠️ 本步受「核心约束」约束

**阶段 1: 理解任务** — 阅读范围和验收标准，定位代码文件

**阶段 2: 开发实现** — 使用 TodoWrite 跟踪进度，错误立即修复

**阶段 3: 质量保证**
```bash
pnpm type-check  # 类型检查 0 错误（如适用）
pnpm lint        # 代码检查 0 警告（如适用）
pytest tests/    # 测试 100% 通过（如适用）
```

#### Step 3: 完成退出

任务完成后，**正常退出对话即可**。调度器会自动更新 AUTO-DEV.md checkbox。

### REVIEW-SYNC 任务执行流程

当任务 ID 为 `REVIEW-SYNC` 时，执行以下审核与同步流程：

> 📌 此任务**必须**是倒数第二个 Wave，确保所有实施任务完成后执行

#### Step 1: 定位 tasks.md 文件

从 AUTO-DEV.md 头部提取 OpenSpec 变更 ID，定位对应的 tasks.md：
```
openspec/changes/{change-id}/tasks.md
```

#### Step 2: 审核代码改动

1. 读取 tasks.md 中的所有任务项
2. 对每个任务，验证代码是否已实现：
   - 检查目标文件是否存在
   - 检查关键函数/类是否已添加
   - 验证功能逻辑是否正确

#### Step 3: 同步任务状态

使用 Edit 工具修改 tasks.md：
1. 将已完成任务的 `- [ ]` 改为 `- [x]`
2. 保留未完成任务的 `- [ ]` 并在下方添加原因说明
3. 同步更新验收检查清单

**示例修改**：
```markdown
# Before
- [ ] 在 `BattleUnit.ts` 添加 `spawnType` 字段

# After
- [x] 在 `BattleUnit.ts` 添加 `spawnType` 字段
```

#### Step 4: 输出审核报告

完成后输出简要报告：
```
## REVIEW-SYNC 审核报告

**OpenSpec 变更**: {change-id}
**审核时间**: {当前时间}

### 完成情况
- 总任务数: X
- 已完成: Y
- 未完成: Z

### 未完成项（如有）
- {任务描述}: {未完成原因}

### tasks.md 已更新
- 所有已完成任务已标记为 [x]
```

### 模式 D 与模式 B 的区别

| 方面 | 模式 D（调度器分配） | 模式 B（手动执行） |
|-----|---------------------|-------------------|
| 任务来源 | 调度器通过 `--task` 指定 | Claude 自己扫描选择 |
| 状态管理 | 调度器内存管理 | Claude 修改 AUTO-DEV.md |
| 修改 AUTO-DEV.md | ❌ 禁止 | ✅ 需要更新 checkbox |
| git 操作 | ❌ 全部禁止 | 可选（用于提交代码） |
| 完成方式 | 正常退出即可 | 更新 checkbox 后退出 |
| 并发保护 | ✅ 调度器保证 | ❌ 无保护 |

---

## 模式 B: 手动执行（单人开发）

**触发**：`/auto-dev`（无 `--task` 参数）

> 📌 适用于未启动调度器时的单人开发场景，无并发保护

### 执行流程

#### Step 1: 任务选择
1. 扫描 `openspec/execution/*/AUTO-DEV.md`
2. 筛选 `- [ ]` 未完成且依赖已满足的任务
3. 选择**一个**任务执行

#### Step 2: 执行任务

同模式 D 的执行流程（理解任务 → 开发实现 → 质量保证）。

#### Step 3: 标记完成

使用 Edit 工具更新 AUTO-DEV.md，将任务 checkbox 改为 `- [x]`。

---

## 模式 A: 计划文档转执行文档

**触发**：`/auto-dev @docs/plan/xxx.md`

### A.0 识别文档类型
- 文件名含 `MASTER-PLAN` 或含「任务拆分」「并行波次」章节 → Master Plan（走 A.1-A.7）
- 否则 → 普通 Plan（跳到 A.8）

### A.1-A.7 Master Plan 分批规划

**单批容量**：约 9 个 Task（基于 150k tokens 预算）

**流程**：
1. 检查 `docs/features/{TOPIC}-EXECUTION.md` 是否存在
2. 存在且有待规划任务 → 从断点继续
3. 解析 Master Plan：Task-ID、Wave、依赖、必读文档、代码入口
4. 对每个 Task 执行预估（见下方公式）
5. 预估 > 150k → 标记「需拆分」
6. 更新执行文档，提交 `git push`
7. 输出进度，提示继续运行

**预估公式**：
| 项目 | 计算方式 |
|------|----------|
| 系统开销 | 40k（MCP + 设定，固定扣除） |
| 文件读取 | 代码行数 × 12 tokens |
| 文件修改 | 预估行数 × 12 tokens |
| 对话轮次 | (读取+修改行数) ÷ 50 × 2k tokens |
| 测试输出 | 测试命令数 × 5k tokens |
| 缓冲 | +25% |
| **硬性上限** | 单任务 ≤120k（系统开销外） |
| **拆分阈值** | 预估 >120k 必须拆分 |

**运行时暂停点**（每完成一个 checklist 后必须检查）：
1. 若当前对话已超过 30 轮，立即暂停并提交进度
2. 若感知到响应变慢或截断，立即暂停
3. 完成 50% checklist 时，主动评估剩余工作量

### A.8 普通 Plan 处理

1. 读取计划文档
2. 提取预估信息（优先从「附录：实施参考」，否则自行扫描）
3. 套用预估公式
4. 按可并行维度拆分（后端/前端/测试/模块）
5. 生成 `openspec/execution/{TOPIC}/AUTO-DEV.md`
6. 更新 `openspec/execution/README.md`
7. 提交并输出

**执行文档必填字段**：
```markdown
## 任务详情
### Task: {ID}
**预估上下文**：~XXk tokens
**状态**：🟦 空闲
**依赖**：{Task-ID 或 无}
**范围**：
- [ ] checklist item 1
- [ ] checklist item 2
**验收标准**：
- 标准 1
```

---

## 模式 C: 归档

**触发**：`>归档已完成` 或 `>归档已完成 {项目名}`

直接执行 `/openspec:archive {change-id}` 命令处理归档流程。

---

## ⚠️ 边界情况决策表

| 情况 | 处理方式 |
|------|----------|
| 依赖未完成 | 先执行依赖任务，**禁止跳过** |
| 文件编辑失败 | 重新读取文件，用最新内容重试 |
| 规划中上下文不足 | 保存进度，提示继续运行 |
| 任务预估超 120k | 标记「⚠️ 需人工拆分」，不阻塞其他任务 |
| **上下文接近耗尽** | **立即暂停**：更新 checklist，记录断点，提示用户新开窗口继续 |

---

## 📋 开发准则

1. 以瞎猜接口为耻，以认真查询为荣
2. 以跳过验证为耻，以主动测试为荣
3. 以破坏架构为耻，以遵循规范为荣
4. 以盲目修改为耻，以谨慎重构为荣
