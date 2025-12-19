---
name: OpenSpec: Apply
description: 执行已批准的 OpenSpec 变更并同步任务状态
category: OpenSpec
tags: [openspec, apply]
---

# OpenSpec Apply - 自动执行并发任务

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

找到 AUTO-DEV.md 后，启动 Electron 调度器应用：

**方式一：开发模式启动**
```bash
cd tools/auto-dev-scheduler-web
npm run dev
```

**方式二：使用打包安装程序**
运行 `tools/auto-dev-scheduler-web/release/Auto-Dev-Scheduler-Setup-1.0.0.exe` 安装后启动。

**加载任务文件**：
1. 启动调度器后，点击 **选择文件** 按钮
2. 选择 `{AUTO-DEV.md完整路径}`
3. 任务列表会显示在表格中

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

## 使用说明

{根据项目内容，说明如何配置和使用}

### 环境配置

{需要的环境变量、依赖项}

### 启动步骤

{如何启动和运行}

---

## 测试指南

### 构建验证
{构建命令和预期结果}

### 功能测试
{核心功能的测试步骤}

### 验收标准
{从 AUTO-DEV.md 提取验收标准}

---

## 归档流程

确认测试通过后，执行以下步骤归档：

1. **运行归档命令**：
   ```bash
   /openspec:archive {change-id}
   ```

2. **归档操作包含**：
   - 移动 `openspec/changes/{change-id}/` → `openspec/changes/archive/{日期}-{change-id}/`
   - 更新 `openspec/specs/` 规格文档（如有变更）
   - 更新 `openspec/execution/README.md` 索引

3. **提交归档 PR**：
   ```bash
   git add openspec/
   git commit -m "archive: 归档 {change-id} OpenSpec 变更"
   git push
   ```

---

## 附录

### 相关文档
- [proposal.md](../../changes/{change-id}/proposal.md)
- [design.md](../../changes/{change-id}/design.md)
- [tasks.md](../../changes/{change-id}/tasks.md)
- [AUTO-DEV.md](./AUTO-DEV.md)

### 变更时间线
{从 git log 或 AUTO-DEV.md 提取执行时间线}
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
