# {项目名称} 交付文档

> **生成时间**：{YYYY-MM-DD HH:mm}
> **OpenSpec 变更**：{change-id}
> **执行时长**：{从第一个任务开始到最后一个任务完成}

---

## 完成内容摘要

| 任务 ID | 任务名称 | 完成时间 | 主要成果 |
|---------|----------|----------|----------|
| {TASK-01} | {任务名} | {时间} | {简述} |
| {TASK-02} | {任务名} | {时间} | {简述} |
| ... | ... | ... | ... |

---

## 变更清单

### 新增文件
```
{列出新增的文件路径}
```

### 修改文件
```
{列出修改的文件路径}
```

---

## 使用说明

### 环境配置

{需要的环境变量配置}

```bash
# 示例
export FEATURE_ENABLED=true
export API_KEY=xxx
```

### 依赖安装

```bash
# 后端依赖
cd server && npm install

# 前端依赖（如有）
cd tools/{project} && npm install
```

### 启动步骤

```bash
# 步骤 1: {描述}
{命令}

# 步骤 2: {描述}
{命令}
```

---

## 测试指南

### 构建验证

```bash
# 后端构建
cd server && npm run build
# 预期结果：无错误输出

# 前端构建（如有）
cd tools/{project} && npm run build
# 预期结果：无错误输出
```

### 功能测试

#### 测试场景 1：{场景名称}
- **前置条件**：{条件}
- **操作步骤**：
  1. {步骤1}
  2. {步骤2}
- **预期结果**：{预期}

#### 测试场景 2：{场景名称}
- **前置条件**：{条件}
- **操作步骤**：
  1. {步骤1}
  2. {步骤2}
- **预期结果**：{预期}

### 验收标准

{从 AUTO-DEV.md 提取各任务的验收标准}

- [ ] {验收项 1}
- [ ] {验收项 2}
- [ ] {验收项 3}

---

## 归档流程

**确认所有测试通过后，执行以下步骤：**

### 1. 运行归档命令

```bash
/openspec:archive {change-id}
```

### 2. 归档操作包含

- 移动 `openspec/changes/{change-id}/` → `openspec/changes/archive/{日期}-{change-id}/`
- 更新 `openspec/specs/` 规格文档（如有变更）
- 更新 `openspec/execution/README.md` 索引
- 清理 `openspec/execution/{project}/` 目录（可选）

### 3. 提交归档

```bash
git add openspec/
git commit -m "archive: 归档 {change-id} OpenSpec 变更"
git push
```

---

## 附录

### 相关文档
- [proposal.md](../../changes/{change-id}/proposal.md) - 变更提案
- [design.md](../../changes/{change-id}/design.md) - 技术设计
- [tasks.md](../../changes/{change-id}/tasks.md) - 细粒度任务
- [AUTO-DEV.md](./AUTO-DEV.md) - 并发任务

### 执行时间线

| 时间 | 事件 |
|------|------|
| {时间} | 开始执行 |
| {时间} | {里程碑1} |
| {时间} | {里程碑2} |
| {时间} | 全部完成 |

---

*此文档由 Auto-Dev Scheduler 辅助生成*
