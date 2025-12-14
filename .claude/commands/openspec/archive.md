---
name: OpenSpec: Archive
description: Archive a deployed OpenSpec change and update specs.
category: OpenSpec
tags: [openspec, archive]
---

# OpenSpec Archive - 归档已完成的变更

你收到了用户指令：归档 OpenSpec 变更 `$ARGUMENTS`

---

## Step 1: 确定要归档的变更

根据参数 `$ARGUMENTS` 确定 change-id：

1. 如果参数已经是 change-id，直接使用
2. 如果不明确，列出可用的变更：
   ```bash
   ls openspec/changes/
   ```
3. 询问用户确认要归档哪个变更

---

## Step 2: 验证变更状态

检查变更是否可以归档：

1. 所有任务已完成（AUTO-DEV.md 中所有任务状态为 ✅）
2. 用户已测试验收通过
3. 变更目录存在且未被归档

```bash
# 检查变更目录
ls openspec/changes/{change-id}/
```

---

## Step 3: 执行归档

### 3.1 创建归档目录

```bash
# 格式：archive/YYYY-MM-DD-{change-id}
mkdir openspec/changes/archive/{日期}-{change-id}
```

### 3.2 移动变更文件

```bash
# 移动所有文件到归档目录
mv openspec/changes/{change-id}/* openspec/changes/archive/{日期}-{change-id}/
rmdir openspec/changes/{change-id}
```

### 3.3 更新规格文档（如有变更）

如果 `changes/{change-id}/specs/` 中有规格增量：
1. 将增量合并到 `openspec/specs/` 对应的规格文档中
2. 删除增量文件

---

## Step 4: 提交归档

```bash
git add openspec/
git commit -m "archive: 归档 {change-id} OpenSpec 变更"
```

---

## 归档清单

- [ ] 确认 change-id
- [ ] 验证所有任务已完成
- [ ] 创建归档目录 `archive/{日期}-{change-id}`
- [ ] 移动变更文件到归档目录
- [ ] 更新规格文档（如有）
- [ ] 提交 git 变更
- [ ] 通知用户归档完成

---

## 归档后的目录结构

```
openspec/changes/
├── archive/
│   └── 2024-12-15-{change-id}/
│       ├── proposal.md
│       ├── design.md
│       ├── tasks.md
│       └── specs/
└── {其他进行中的变更}/
```
