---
name: OpenSpec: Apply
description: Implement an approved OpenSpec change and keep tasks in sync.
category: OpenSpec
tags: [openspec, apply]
---

# OpenSpec Apply - 执行并发任务

你收到了用户指令：执行 OpenSpec 变更 `$ARGUMENTS`

---

## Step 1: 定位 AUTO-DEV.md 任务文件

根据参数 `$ARGUMENTS` 查找对应的 AUTO-DEV.md：

1. 如果参数是完整路径，直接使用
2. 如果参数是项目名称，查找 `openspec/execution/{参数}/AUTO-DEV.md`
3. 如果参数是 change-id，查找 `openspec/execution/{对应项目}/AUTO-DEV.md`

**执行检查：**
```bash
# 列出可用的执行项目
ls openspec/execution/
```

---

## Step 2: 启动 Auto-Dev Scheduler

找到 AUTO-DEV.md 后，执行调度器并传入文件路径：

```bash
# 启动调度器（使用项目根目录的相对路径）
start "" "tools\auto-dev-scheduler\run.bat" "{AUTO-DEV.md完整路径}"
```

**注意**：调度器会自动加载任务列表，等待用户点击"开始"按钮。

---

## Step 3: 监控执行进度

调度器启动后：
1. 用户点击"开始"按钮启动任务执行
2. 调度器会自动分配任务给多个 Claude 实例
3. 任务完成后调度器会显示"全部任务完成"

---

## Step 4: 生成交付文档（任务完成后）

当所有任务完成后，**不要自动归档**。生成交付文档 `openspec/execution/{项目}/DELIVERY.md`：

```markdown
# {项目名称} 交付文档

> 生成时间：{当前时间}
> OpenSpec 变更：{change-id}

---

## 完成内容摘要

{从 AUTO-DEV.md 提取已完成任务，列出每个任务的主要成果}

---

## 测试指南

### 功能测试
{核心功能的测试步骤}

### 验收标准
{从 AUTO-DEV.md 提取验收标准}

---

## 下一步

测试通过后，执行归档：
```
/openspec:archive {change-id}
```
```

---

## 执行清单

- [ ] 定位 AUTO-DEV.md 文件
- [ ] 启动 Auto-Dev Scheduler
- [ ] 确认调度器已加载任务列表
- [ ] 等待用户点击开始
- [ ] （任务完成后）生成 DELIVERY.md 交付文档
- [ ] 提示用户进行测试验收
- [ ] 提示用户执行归档（/openspec:archive）
