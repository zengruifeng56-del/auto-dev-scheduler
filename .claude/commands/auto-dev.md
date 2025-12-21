# 自动开发任务检测与执行（支持多 Claude 并发）

你是一个全自动开发助手，通过 **Git 分布式锁机制** 与其他 Claude 实例协调工作。

---

## 🎯 核心摘要（必读）

**目的**：多个 Claude 实例并行执行开发任务，通过 Git 锁避免冲突。

**三条最高优先级约束**：
1. ❌ 禁止跳过测试/错误/依赖 — 遇到问题必须修复
2. ❌ 禁止全量重置（`git restore .` / `git reset --hard`）— 冲突必须智能合并
3. ❌ 禁止使用 TODO/FIXME 占位符 — 代码必须完整

**流程总览**：
```
检测模式 → 读取任务状态 → 选择任务 → 抢占锁(git push) → 执行 → 标记完成 → 释放锁
```

**状态标记**：
- `🟦 空闲` / `⏳ 待开始` → 可执行
- `🟠 执行中（实例ID, 时间）` → 已被占用
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
if [ -f ".git/index.lock" ]; then
  echo "Lock exists"
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
type: `feat` / `fix` / `docs` / `lock` / `archive`

### 实例 ID 格式
`Claude-Terminal-{随机4位数}`，如 `Claude-Terminal-1234`

---

## 🚨 核心约束（违反即失败）

### 禁止行为
- ❌ 跳过测试失败/编译错误
- ❌ 使用 TODO/FIXME 占位符
- ❌ `git restore .` / `git reset --hard`（全量重置）
- ❌ 说"暂时跳过"/"之后处理"
- ❌ 创建 Mock 数据绕过依赖
- ❌ 任务完成后自动接管下一个任务

### 允许的回滚操作
- ✅ `git checkout -- {单个文件}` 用于抢锁失败时回滚状态改动

### 强制行为
- ✅ 遇到问题必须立即修复
- ✅ 100% 测试通过（不是"大部分通过"）
- ✅ mypy/type-check 0 错误
- ✅ 文件冲突必须智能合并或提示用户
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
| 1 | D（指定任务） | 用户消息包含 `--task <TaskId>` 参数 |
| 2 | C（归档） | 用户消息以 `>归档已完成` 开头 |
| 3 | A（计划转执行） | 用户**命令参数**引用 `docs/plan` 路径 |
| 4 | B（常规开发） | **默认**：无特殊参数 |

> ⚠️ system-reminder 中的文件内容**不算**用户主动引用

---

## 模式 D: 指定任务执行（调度器分配）

**触发**：`/auto-dev --task <TaskId>` 或消息中包含 `--task GMT-E-05` 格式

> 📌 本模式用于 **auto-dev-scheduler** 调度器分配任务

### ⚠️ 调度器协作模式（重要）

当由 **auto-dev-scheduler** 分配任务时，调度器已在内存中管理任务锁和状态：

| 操作 | 状态 | 原因 |
|------|------|------|
| 修改 AUTO-DEV.md | ❌ 禁止 | 调度器管理状态 |
| git add/commit/push | ❌ 禁止 | 避免并发锁冲突 |
| git pull | ❌ 禁止 | 调度器已同步 |
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

### 与模式 B 的区别

| 方面 | 模式 B（常规/独立） | 模式 D（调度器分配） |
|-----|-------------------|---------------------|
| 任务选择 | Claude 自己扫描选择 | 调度器指定 |
| 任务锁 | Git 分布式锁 | 调度器内存管理 |
| 状态更新 | 修改 AUTO-DEV.md | ❌ 禁止修改 |
| Git 操作 | pull/add/commit/push | ❌ 全部禁止 |
| 完成方式 | 标记状态 + push | 正常退出即可 |

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

## 模式 B: 常规开发执行（默认）

> ⚠️ 本模式受「核心约束」全部条款约束

### 执行流程

#### Step 0: 同步最新状态
```bash
git pull origin master
```
确保本地视图最新，避免基于旧状态选任务。

#### Step 1-2: 任务选择
1. 扫描 `openspec/execution/*/AUTO-DEV.md` 所有文档
2. 筛选状态为 `🟦 空闲` / `⏳ 待开始` 的任务
3. 检查依赖：所有依赖任务必须为 `✅ 已完成`
4. 选择**一个**依赖已满足的任务

**依赖判定规则**：
- 若任务 B 依赖 A，A 未完成 → 先执行 A
- 若多个任务依赖均满足 → 任选一个

#### Step 3: 抢占任务锁（关键）

> ⚠️ 本步受「核心约束」约束，禁止跳过

1. 获取当前时间（见通用规范）
2. 生成实例 ID
3. **仅修改状态行**，更新任务文档：
```markdown
**状态**：🟠 执行中（Claude-Terminal-1234, 2025-11-28 14:30）
**执行实例**：Claude-Terminal-1234
**开始时间**：2025-11-28 14:30
```
4. 立即提交推送（**锁 commit 仅包含状态变更，type=lock**）：
```bash
git add openspec/execution/{项目}/AUTO-DEV.md
git commit -m "lock: 开始执行 Task-XX"
git push origin master
```
5. **push 失败处理**：
   - 回滚本次状态改动：`git checkout -- openspec/execution/{项目}/AUTO-DEV.md`
   - 执行 `git pull origin master`
   - 回到 Step 1 重新选择（最多重试 3 次）
6. **push 成功** → 继续执行

#### Step 4: 执行任务

> ⚠️ 本步受「核心约束」约束，禁止跳过测试/使用占位符

**阶段 1: 文档先行**
- 创建 TODO 文档（技术方案、API 设计、测试计划）

**阶段 2: 开发实现**
- 使用 TodoWrite 跟踪进度
- 错误处理：类型错误→立即修复，测试失败→分析修复，冲突→智能合并

**阶段 3: 质量保证**
```bash
# 根据项目实际配置执行（以下为示例）
pnpm type-check  # 类型检查 0 错误
pnpm lint        # 代码检查 0 警告
pytest tests/    # 测试 100% 通过
pnpm build       # 构建成功
```

**阶段 4: 文档归档**
- 更新 README，创建 COMPLETION-REPORT.md

#### Step 5: 标记完成并释放锁

> ⚠️ 必须先验证锁、更新状态、再提交推送

1. **验证锁仍归自己**：读取任务文档，确认执行实例 ID 仍是自己的
   - 如果被他人修改 → 输出警告，暂停执行，等待用户指令
2. 获取完成时间
3. 更新任务文档：
```markdown
**状态**：✅ 已完成（2025-11-28 16:45）
**完成时间**：2025-11-28 16:45
```
4. 一次性提交所有改动并推送（**释放锁**）：
```bash
git add .
git commit -m "feat: 完成 Task-XX - {任务名称}"
git push origin master
```
5. **push 冲突处理**：按边界情况决策表处理，解决后重新 push
6. **push 成功后停止执行**，不自动接管下一个任务

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
| 所有任务被占用 | 无 `🟦 空闲` 任务 | 等待 5 分钟，`git pull origin master` 后重新检查 |
| Git push 冲突 | push 返回错误 | `git pull origin master`，按冲突处理流程解决后重试 |
| 任务超时 | `🟠 执行中` 超过 2 小时 | 输出警告，**不自动接管**，提示用户确认是否解除/接管该锁 |
| 依赖未完成 | 前置任务非 ✅ | 先执行依赖任务，**禁止跳过** |
| 文件编辑失败 | Edit 工具报错 | 重新读取文件，用最新内容重试 |
| 规划中上下文不足 | 剩余 < 20k tokens | 保存进度，提示继续运行 |
| 必读文档不存在 | 文件路径无效 | 标记「❓ 需确认」，继续其他任务 |
| 任务预估超 120k | 无法拆分 | 标记「⚠️ 需人工拆分」，不阻塞其他任务 |
| 锁被他人修改 | 验证锁时发现实例 ID 不匹配 | 输出警告，暂停执行，等待用户指令 |
| **上下文接近耗尽** | 对话超 30 轮 / 响应变慢 / 50% checklist 完成 | **立即暂停**：提交当前进度，更新 checklist，记录断点，提示用户新开窗口继续 |

### Git 冲突处理（详细）

> ⚠️ 禁止全量重置（`git restore .` / `git reset --hard`）

1. **简单冲突**：`git pull origin master` 自动合并成功 → 继续
2. **复杂冲突**：
   - 查看 `git status` 中 `both modified` 文件
   - 任务状态冲突 → 保留更早时间戳的那个
   - 代码逻辑冲突 → 尝试合并双方改动
   - 手动编辑移除冲突标记（`<<<<<<<` / `=======` / `>>>>>>>`）
   - 执行 `git add {冲突文件}` + `git commit -m "merge: 解决并发冲突"`
3. **无法处理**：输出冲突文件列表，暂停执行，等待用户指令

---

## 📋 开发准则

1. 以瞎猜接口为耻，以认真查询为荣
2. 以跳过验证为耻，以主动测试为荣
3. 以破坏架构为耻，以遵循规范为荣
4. 以盲目修改为耻，以谨慎重构为荣

**协议驱动架构**：所有 backend-* 包必须 Protocol + Adapter + System + Mixin

