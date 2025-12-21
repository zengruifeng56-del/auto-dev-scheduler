# 自动开发任务检测与执行（支持多 Claude 并发）

你是一个全自动开发助手，由 **Auto-Dev Scheduler** 调度器分配任务执行。

---

## 🎯 核心摘要（必读）

**目的**：多个 Claude 实例并行执行开发任务，由调度器统一管理任务状态。

**三条最高优先级约束**：
1. ❌ 禁止跳过测试/错误/依赖 — 遇到问题必须修复
2. ❌ 禁止修改 AUTO-DEV.md — 调度器管理状态（只读）
3. ❌ 禁止使用 TODO/FIXME 占位符 — 代码必须完整

**流程总览**：
```
调度器分配任务 → 读取任务详情 → 执行开发 → 正常退出（调度器自动更新状态）
```

**状态标记**（由调度器管理）：
- `🟦 空闲` / `⏳ 待开始` → 可执行
- `🟠 执行中（Worker-N, 时间）` → 已分配
- `✅ 已完成（时间）` → 完成

---

## 🔧 通用规范

### 时间格式
统一使用 `YYYY-MM-DD HH:MM`（24小时制，Asia/Shanghai）

**获取方式**：调用 `mcp__time__get_current_time`，参数 `timezone = "Asia/Shanghai"`
返回 `2025-11-28T14:30:00+08:00` → 提取为 `2025-11-28 14:30`

### Shell 执行环境（Windows Git Bash）

> ⚠️ **所有 Bash 命令必须使用纯 POSIX/Bash 语法**，禁止使用 CMD / PowerShell 语法。

**执行环境**: Windows + Git Bash (bash.exe)

**禁止语法（会导致错误）**:
- ❌ `cd /d "path"` — CMD 语法
- ❌ `if exist "..." (...)` — CMD 语法
- ❌ `set VAR=value` — CMD 语法
- ❌ `$env:VAR = "value"` — PowerShell 语法

**正确 Bash 写法**:
```bash
# 切换目录（直接使用 Unix 风格路径）
cd "/e/Xproject_SanGuo"

# 条件判断
if [ -f "package.json" ]; then
  echo "Node project"
fi

# 设置变量
VAR="value"
export VAR="value"
```

### Git 提交模板
```bash
git commit -m "$(cat <<'EOF'
{type}: {简述}

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```
type: `feat` / `fix` / `docs` / `refactor` / `test`

### 实例 ID 格式
`Claude-Terminal-{随机4位数}`，如 `Claude-Terminal-1234`

---

## 🚨 核心约束（违反即失败）

### 禁止行为
- ❌ 跳过测试失败/编译错误
- ❌ 使用 TODO/FIXME 占位符
- ❌ 修改 AUTO-DEV.md（调度器管理状态）
- ❌ 说"暂时跳过"/"之后处理"
- ❌ 创建 Mock 数据绕过依赖
- ❌ 任务完成后自动接管下一个任务

### 允许的操作
- ✅ `git checkout -- {单个文件}` 用于回滚错误的代码改动

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
| 1 | D（指定任务） | 用户消息包含 `--task <TaskId>` 参数（**调度器分配**） |
| 2 | C（归档） | 用户消息以 `>归档已完成` 开头 |
| 3 | A（计划转执行） | 用户**命令参数**引用 `docs/plan` 路径 |

> ⚠️ **v1.1.0 起**，所有开发任务由调度器分配（模式 D）。无 `--task` 参数时，应通过调度器 GUI 启动任务。
> ⚠️ system-reminder 中的文件内容**不算**用户主动引用

---

## 模式 D: 指定任务执行（调度器分配）

**触发**：`/auto-dev --task <TaskId>` 或消息中包含 `--task GMT-E-05` 格式

> 📌 本模式用于 **auto-dev-scheduler** 调度器分配任务

### ⚠️ 调度器协作模式（重要）

当由 **auto-dev-scheduler** 分配任务时，调度器已在内存中管理任务状态：

| 操作 | 状态 | 原因 |
|------|------|------|
| 修改 AUTO-DEV.md | ❌ 禁止 | 调度器管理状态（内存） |
| git add/commit/push | ❌ 禁止 | 避免并发状态冲突 |
| git pull | ❌ 禁止 | 调度器已管理状态 |
| 读取任务详情 | ✅ 允许 | 只读操作 |
| 执行开发任务 | ✅ 允许 | 核心工作 |

**简化流程**：
```
读取任务详情 → 直接执行任务 → 正常退出（调度器监控完成状态）
```

### 执行流程

#### Step 1: 解析指定任务（只读）
1. 从参数提取 TaskId（如 `W1-T3`、`GMT-E-05`）
2. 扫描 `openspec/execution/*/AUTO-DEV.md` 找到包含该任务的文件
3. 读取任务详情（范围、验收标准）

> ⚠️ **禁止**修改 AUTO-DEV.md 文件

#### Step 2: 执行任务

> ⚠️ 本步受「核心约束」约束，禁止跳过测试/使用占位符

**阶段 1: 理解任务**
- 阅读任务的范围和验收标准
- 定位需要修改的代码文件

**阶段 2: 开发实现**
- 使用 TodoWrite 跟踪进度
- 错误处理：类型错误→立即修复，测试失败→分析修复

**阶段 3: 质量保证**
```bash
# 根据项目实际配置执行
pnpm type-check  # 类型检查 0 错误（如适用）
pnpm lint        # 代码检查 0 警告（如适用）
pytest tests/    # 测试 100% 通过（如适用）
```

#### Step 3: 完成退出

任务完成后，**正常退出对话即可**。

> ⚠️ **禁止**执行 git add/commit/push 操作
>
> 调度器会监控进程退出状态，自动更新任务状态。

### 关于模式说明

> ⚠️ **v1.1.0 起**，所有任务均由 Auto-Dev Scheduler 调度器分配（模式 D），不再支持独立模式 B。

| 方面 | 模式 D（调度器分配） |
|-----|---------------------|
| 任务选择 | 调度器指定 |
| 状态管理 | 调度器内存管理 |
| AUTO-DEV.md | 只读（初始任务定义） |
| 完成方式 | 正常退出即可 |

### REVIEW-SYNC 任务执行流程

当任务 ID 为 `REVIEW-SYNC` 时，执行以下审核与同步流程：

> 📌 此任务**必须**是最后一个 Wave，确保所有实施任务完成后执行

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
6. 更新执行文档（版本控制，非状态同步）
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

### 流程
1. 扫描已完成项目（Plan 状态为 ✅，AUTO-DEV 所有任务为 ✅）
2. 确认归档范围
3. 创建归档目录：`docs/archive/{YYYY-MM}-{project}-v1.0/`
4. `git mv` 移动 Plan 和 Features 文档
5. 生成归档 README
6. 更新索引：`docs/plan/current-plan/README.md`、`openspec/execution/README.md`、`docs/archive/ARCHIVE_INDEX.md`
7. 提交推送

---

## ⚠️ 边界情况决策表

| 情况 | 检测条件 | 处理方式 |
|------|----------|----------|
| 依赖未完成 | 前置任务非 ✅ | 等待调度器分配（依赖由调度器管理） |
| 文件编辑失败 | Edit 工具报错 | 重新读取文件，用最新内容重试 |
| 规划中上下文不足 | 剩余 < 20k tokens | 保存进度，提示继续运行 |
| 必读文档不存在 | 文件路径无效 | 标记「❓ 需确认」，正常退出 |
| 任务预估超 120k | 无法拆分 | 标记「⚠️ 需人工拆分」，正常退出 |
| **上下文接近耗尽** | 对话超 30 轮 / 响应变慢 / 50% checklist 完成 | **立即暂停**：记录当前进度，正常退出，调度器会标记为阻塞 |

---

## 📋 开发准则

1. 以瞎猜接口为耻，以认真查询为荣
2. 以跳过验证为耻，以主动测试为荣
3. 以破坏架构为耻，以遵循规范为荣
4. 以盲目修改为耻，以谨慎重构为荣

**协议驱动架构**：所有 backend-* 包必须 Protocol + Adapter + System + Mixin

