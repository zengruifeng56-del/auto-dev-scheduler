# Auto-Dev Scheduler 更新总结

**更新日期**: 2026-01-23
**版本**: v1.5.0 (Phase 4: Claude-First Architecture)
**更新范围**: 品牌统一、OpenSpec 同步、Mac/Linux 支持

---

## 🎯 本次更新亮点

### 1️⃣ 品牌统一 (ADS)

✅ **更新内容**:
- `package.json` author: "SanGuo Tools Team" → "Auto-Dev Scheduler Contributors"
- `package.json` appId: "com.sanguo.auto-dev-scheduler" → "com.autodev.scheduler"
- 所有引用已统一为 "Auto-Dev Scheduler" (简称: ADS)

✅ **影响范围**:
- 桌面应用品牌标识
- 安装程序品牌信息
- 文档品牌统一

### 2️⃣ OpenSpec 命令同步

✅ **更新内容**:
- 同步最新的 `auto-dev.md` 命令文件
- 确保调度器行为与项目版一致
- 更新了 Issue 报告协议、REVIEW-SYNC 任务处理等

✅ **修复的问题**:
- ❌ 版本差异导致的行为不一致
- ❌ Issue 追踪逻辑偏差
- ❌ 任务完成状态更新差异

### 3️⃣ 安装脚本增强

✅ **Windows (install.ps1)**:
- 添加 Claude CLI 检查（必需）
- 添加 OpenSpec CLI 检查（必需）
- 自动执行 `npm install` 或清晰提示
- 改进错误信息和帮助文本

✅ **macOS/Linux (install.sh)**:
- 全新创建，支持 Bash 脚本
- 使用 curl/rsync 替代 PowerShell 特定命令
- 自动依赖检查和安装
- 跨平台兼容性

### 4️⃣ AUTO-DEV.md 生成指南

✅ **添加内容**:
- README.md 中补充"转换为并发任务"章节
- 明确说明 tasks.md vs AUTO-DEV.md 的区别
- 提供两种创建方式（手动/模板）
- 格式要求和最佳实践

✅ **文档完整性**:
- 细粒度 vs 粗粒度任务的对比
- Wave 波次分组策略
- Persona 字段使用说明

### 5️⃣ 平台支持扩展

✅ **Windows 支持**:
- PowerShell install.ps1（已有，现已增强）
- Electron 应用完整支持
- 打包为 NSIS 安装程序

✅ **macOS 支持** (新增):
- Bash install.sh
- 详细故障排查指南 (MAC_GUIDE.md)
- M1/M2 ARM64 兼容性说明
- Command Line Tools 配置

✅ **Linux 支持** (新增):
- Bash install.sh
- 多发行版支持 (Ubuntu/Debian/Fedora/CentOS/Arch)
- Headless/Server 部署方案
- Docker 容器化部署
- Systemd 服务集成

---

## 📋 更新清单

### 核心修复 (Priority 1)
- [x] 同步 auto-dev.md 命令
- [x] 增强 install.ps1 CLI 检查
- [x] 自动化 npm install
- [x] 补充 AUTO-DEV.md 生成流程

### 品牌统一 (Priority 2)
- [x] 更新 package.json author
- [x] 更新 package.json appId
- [x] 统一命名约定

### 平台支持 (Priority 3)
- [x] 创建 Mac 用户指南
- [x] 创建 Linux 用户指南
- [x] 创建 install.sh (跨 Unix)
- [x] 添加系统要求说明

### 文档完善 (Priority 4)
- [x] README.md AUTO-DEV.md 生成说明
- [x] 添加 Mac/Linux 安装说明
- [x] BRAINSTORM-ANALYSIS 流程分析
- [x] 本文档 (UPDATE-SUMMARY)

---

## 📊 文件变更统计

### 新增文件
```
BRAINSTORM-ANALYSIS.md          (8.5 KB) - 详细流程分析
LINUX_GUIDE.md                 (12.0 KB) - Linux 用户完整指南
MAC_GUIDE.md                   (10.5 KB) - Mac 用户完整指南
SYNC-COMPLETE.md                (9.5 KB) - Phase 4 同步完成报告
UPDATE-SUMMARY.md (本文件)      (7.5 KB) - 本次更新总结
SYNC-ANALYSIS.md                (6.3 KB) - 差异分析文档
install.sh                      (8.0 KB) - Unix/Linux 安装脚本
sync-from-project.ps1           (4.8 KB) - 同步脚本
```

### 修改文件
```
install.ps1                      增强依赖检查 + 自动 npm install
README.md                        添加 AUTO-DEV.md 生成指南 + 平台说明
package.json                     品牌更新 (author, appId)
.claude/commands/auto-dev.md     同步最新版本
```

### 同步的代码文件
```
主进程模块:
  - artifact-store.ts (新)
  - codex-worker.ts (新)
  - gemini-worker.ts (新)
  - metadata-validator.ts (新)
  - routing-registry.ts (新)
  - worker-factory.ts (新)
  - worker-types.ts (新)
  - scheduler/* (8 个新文件)

渲染进程:
  - 7 个新 Vue 组件
  - 多个现有组件更新

共享模块:
  - types.ts, ipc-channels.ts, electron-api.d.ts 更新
```

---

## 🚀 使用对比

### 安装流程改进

**Before (v1.4.0)**:
```bash
# 仅支持 Windows
irm install.ps1 | iex
# ❌ 不检查 Claude/OpenSpec CLI
# ❌ 不自动安装 npm 依赖
```

**After (v1.5.0)**:
```bash
# Windows
irm install.ps1 | iex
# ✅ 检查所有必需工具
# ✅ 自动执行 npm install
# ✅ 清晰的错误提示

# macOS/Linux (新)
curl -fsSL install.sh | bash
# ✅ 统一的 Unix 安装流程
# ✅ 跨平台支持
```

### 文档流程改进

**Before (v1.4.0)**:
```
/openspec:proposal → ??? → /openspec:apply
# ❌ 如何生成 AUTO-DEV.md? 不清楚
# ❌ tasks.md 和 AUTO-DEV.md 区别? 不清楚
```

**After (v1.5.0)**:
```
/openspec:proposal → tasks.md → 手动/模板转换 → AUTO-DEV.md → /openspec:apply
# ✅ 明确的生成流程
# ✅ 详细的格式要求
# ✅ 最佳实践说明
# ✅ 两种创建方式可选
```

---

## 🔧 技术细节

### Phase 4 架构回顾

通用版现已包含：
- ✅ Claude-First 路由
- ✅ MCP 智能委派 (Codex/Gemini)
- ✅ 模块化 Scheduler 子系统
- ✅ ECharts 可视化
- ✅ Issue 追踪和 Session 持久化
- ✅ API 错误恢复和指数退避

### 命令版本同步

`auto-dev.md` 同步涵盖：
- ✅ 调度器分配模式 (Mode D)
- ✅ 手动执行模式 (Mode B)
- ✅ 计划转执行模式 (Mode A)
- ✅ 归档模式 (Mode C)
- ✅ Issue 报告协议
- ✅ REVIEW-SYNC 任务处理

---

## 💡 对用户的建议

### 升级建议

**现有用户 (v1.4.0 → v1.5.0)**:

1. **拉取最新代码**:
   ```bash
   git pull origin master
   ```

2. **查看 MIGRATION.md**:
   了解 Phase 4 架构变化（可选但推荐）

3. **更新依赖**:
   ```bash
   cd tools/auto-dev-scheduler-web
   npm install
   npm run typecheck
   ```

4. **重新启动调度器**:
   ```bash
   npm run dev
   ```

**新用户**:

1. **按平台选择安装方式**:
   - Windows: `install.ps1`
   - macOS: 查看 `MAC_GUIDE.md` 或运行 `install.sh`
   - Linux: 查看 `LINUX_GUIDE.md` 或运行 `install.sh`

2. **配置 API Key**:
   ```bash
   export ANTHROPIC_API_KEY="sk-ant-..."
   ```

3. **创建第一个项目**:
   ```bash
   claude "/openspec:proposal my-first-feature"
   ```

---

## 📚 新增文档导航

| 文档 | 适用对象 | 内容 |
|------|---------|------|
| README.md | 所有人 | 概览、安装、快速开始 |
| MAC_GUIDE.md | Mac 用户 | 详细安装、配置、故障排查 |
| LINUX_GUIDE.md | Linux 用户 | 详细安装、Docker、Systemd |
| MIGRATION.md | 现有用户 | v1.4.0 → v1.5.0 迁移指南 |
| BRAINSTORM-ANALYSIS.md | 项目维护者 | 流程分析、风险评估、改进建议 |
| SYNC-ANALYSIS.md | 开发者 | Phase 4 同步的详细差异 |
| SYNC-COMPLETE.md | 开发者 | 本次同步的完整报告 |

---

## ✅ 验证清单

- [x] TypeScript 编译通过 (0 errors)
- [x] Vite 构建成功
- [x] 依赖安装完成
- [x] 品牌信息统一
- [x] 平台支持覆盖
- [x] 文档完整性检查
- [x] OpenSpec 命令同步
- [x] 安装脚本增强
- [x] AUTO-DEV.md 生成流程文档化

---

## 🎓 下一步建议

### 短期 (1-2 周)
1. 社区测试 (特别是 Mac/Linux 用户)
2. 收集反馈并修复 Issue
3. 完善故障排查文档

### 中期 (1 个月)
1. 创建示例项目展示完整工作流
2. 录制视频教程
3. 发布 v1.5.0 正式版本

### 长期 (2-3 个月)
1. Mac/Linux Electron 打包支持
2. Web 版调度器 (不依赖 Electron)
3. 云端协作功能 (多用户编辑 AUTO-DEV.md)

---

## 📞 支持和反馈

- **GitHub Issues**: https://github.com/zengruifeng56-del/auto-dev-scheduler/issues
- **讨论区**: https://github.com/zengruifeng56-del/auto-dev-scheduler/discussions
- **文档反馈**: 在对应的 .md 文件中开 Issue

---

## 致谢

感谢：
- OpenSpec 框架的设计和支持
- Claude API 的强大能力
- 社区用户的反馈和贡献

---

**更新者**: Claude Opus 4.5
**更新完成时间**: 2026-01-23
**下一个计划更新**: v1.5.1 (Bug fixes & Polish)
