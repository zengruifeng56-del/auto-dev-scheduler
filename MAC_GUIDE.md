# macOS 用户完整指南

本指南为 macOS 用户提供详细的安装和使用说明。

---

## 前置要求检查

### 1. 检查 macOS 版本

```bash
sw_vers
# 推荐: macOS 12.0 或更高版本
```

### 2. 安装 Command Line Tools

```bash
xcode-select --install
```

如果已安装，可检查版本：
```bash
xcode-select --version
```

### 3. 安装 Homebrew（可选，但推荐）

如果还未安装：
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

---

## 逐步安装

### Step 1: 安装 Node.js 20+

**方式 A: 使用 Homebrew（推荐）**
```bash
brew install node@20
```

验证安装：
```bash
node --version  # v20.x.x
npm --version   # 10.x.x
```

**方式 B: 使用 nvm（Node Version Manager）**
```bash
# 安装 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# 重启终端或运行
source ~/.zshrc

# 安装 Node.js 20
nvm install 20
nvm use 20
```

**方式 C: 直接下载**

访问 https://nodejs.org 下载 macOS 安装程序。

### Step 2: 安装 Git

大多数 macOS 系统已预装 Git。检查：
```bash
git --version
```

如未安装，使用 Homebrew：
```bash
brew install git
```

### Step 3: 安装 Claude CLI

按照官方文档：https://docs.anthropic.com/claude/docs/claude-cli

```bash
# 使用 npm 全局安装
npm install -g @anthropic-ai/claude-cli

# 验证
claude --version

# 配置 API Key
export ANTHROPIC_API_KEY="your-api-key-here"
# 或添加到 ~/.zshrc 或 ~/.bash_profile
echo 'export ANTHROPIC_API_KEY="your-api-key-here"' >> ~/.zshrc
```

### Step 4: 安装 OpenSpec CLI

从 GitHub 安装：https://github.com/Fission-AI/OpenSpec

```bash
# 使用 Homebrew（如果支持）
brew install openspec

# 或使用 npm
npm install -g openspec

# 验证
openspec --version
```

### Step 5: 安装 Auto-Dev Scheduler

在项目根目录运行：
```bash
curl -fsSL https://raw.githubusercontent.com/zengruifeng56-del/auto-dev-scheduler/master/install.sh | bash
```

或手动执行：
```bash
# Clone 项目
git clone https://github.com/zengruifeng56-del/auto-dev-scheduler.git
cd auto-dev-scheduler

# 复制文件到你的项目
cp -r openspec ~/YourProject/
cp -r .claude ~/YourProject/
cp -r tools/auto-dev-scheduler-web ~/YourProject/tools/

# 安装调度器依赖
cd ~/YourProject/tools/auto-dev-scheduler-web
npm install
```

---

## 启动调度器

### 开发模式

```bash
cd tools/auto-dev-scheduler-web
npm run dev
```

浏览器会自动打开 `http://localhost:5174`。

### 打包模式（可选）

```bash
npm run build:mac
# 生成 release/Auto-Dev-Scheduler-x.x.x.dmg
```

**注意**: macOS 应用需要编码签名和公证。目前仅提供 Windows 安装程序。如需 macOS 应用，请在开发模式下运行。

---

## 配置环境变量

### 方式 1: 临时配置（仅当前会话）

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENSPEC_HOME="$HOME/.openspec"
```

### 方式 2: 永久配置

编辑 `~/.zshrc`（macOS 11+ 默认使用 zsh）或 `~/.bash_profile`（较旧版本）：

```bash
# 打开编辑器
nano ~/.zshrc

# 添加以下内容
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENSPEC_HOME="$HOME/.openspec"
export PATH="/usr/local/opt/node/bin:$PATH"  # 如果使用 Homebrew Node

# 保存: Ctrl+X, Y, Enter
# 重新加载配置
source ~/.zshrc
```

### 方式 3: 使用 .env 文件

在项目根目录创建 `.env`：
```
ANTHROPIC_API_KEY=sk-ant-...
OPENSPEC_HOME=/Users/yourname/.openspec
```

---

## 常见问题

### Q1: "command not found: node"

**原因**: Node.js 不在 PATH 中

**解决**:
```bash
# 如果使用 nvm
nvm use 20

# 如果使用 Homebrew
export PATH="/usr/local/opt/node/bin:$PATH"
echo 'export PATH="/usr/local/opt/node/bin:$PATH"' >> ~/.zshrc
```

### Q2: "npm install" 超时或失败

**原因**: 网络连接或 npm 源问题

**解决**:
```bash
# 更换 npm 源
npm config set registry https://registry.npmjs.org/

# 清除缓存
npm cache clean --force

# 重试
npm install
```

### Q3: Claude CLI 找不到

**原因**: CLI 未正确安装或 PATH 未配置

**解决**:
```bash
# 检查安装位置
which claude

# 如果为空，检查 npm 全局目录
npm list -g | grep claude

# 重新安装
npm install -g @anthropic-ai/claude-cli
```

### Q4: Electron 应用启动失败

**原因**: 依赖缺失或 Node 版本不兼容

**解决**:
```bash
# 检查 Node 版本
node --version  # 需要 >= 20

# 清除 node_modules 并重装
cd tools/auto-dev-scheduler-web
rm -rf node_modules package-lock.json
npm install

# 重新启动
npm run dev
```

### Q5: "Permission denied" 错误

**原因**: 脚本文件没有执行权限

**解决**:
```bash
chmod +x install.sh
./install.sh
```

### Q6: M1/M2 Mac 兼容性问题

**原因**: 某些原生模块可能不支持 arm64 架构

**解决**:
```bash
# 检查当前架构
uname -m  # arm64 (M1/M2) 或 x86_64 (Intel)

# 如果遇到编译错误，尝试
arch -x86_64 npm install
arch -x86_64 npm run dev
```

---

## 工作流程

### 创建提案

```bash
cd ~/YourProject

# 使用 Claude 创建提案
claude "/openspec:proposal add-user-auth"

# Claude 会生成
# openspec/changes/add-user-auth/
# ├── proposal.md
# ├── tasks.md
# ├── design.md (可选)
# └── specs/
```

### 转换为并发任务

根据 `tasks.md` 手动创建 `openspec/execution/add-user-auth/AUTO-DEV.md`。

参考格式见 `openspec/execution/README.md`。

### 启动调度器

```bash
# 启动 Electron 应用
cd tools/auto-dev-scheduler-web
npm run dev

# 打开调度器 UI
# http://localhost:5174

# 加载 AUTO-DEV.md 文件
# 点击"选择文件" → 选择 openspec/execution/add-user-auth/AUTO-DEV.md

# 设置并发数（1-4）并点击 Start
```

### 监控执行

- **任务列表**: 实时显示每个任务的状态
- **Worker 日志**: 查看每个 Claude Worker 的输出
- **进度条**: 显示完成百分比

### 归档完成的变更

```bash
claude "/openspec:archive add-user-auth"

# OpenSpec 会
# 1. 移动 openspec/changes/add-user-auth → openspec/changes/archive/
# 2. 更新 openspec/specs/
# 3. 更新索引文件
```

---

## 性能优化

### 1. 使用本地 npm 缓存

```bash
npm config set prefer-offline true
npm config set prefer-object-links true
```

### 2. 启用 Node.js 快照（加速启动）

```bash
NODE_OPTIONS="--enable-source-maps" npm run dev
```

### 3. 监控资源使用

```bash
# 在另一个终端监控内存和 CPU
top -l 1 | grep "claude\|node"
```

---

## 故障排查

### 完整的诊断步骤

```bash
#!/bin/bash

echo "=== System Info ==="
sw_vers
uname -m

echo ""
echo "=== Node/npm ==="
node --version
npm --version

echo ""
echo "=== Claude CLI ==="
claude --version
echo "ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:0:10}***"

echo ""
echo "=== OpenSpec CLI ==="
openspec --version

echo ""
echo "=== Project Structure ==="
ls -la openspec/
ls -la .claude/commands/
ls -la tools/auto-dev-scheduler-web/

echo ""
echo "=== Dependencies ==="
cd tools/auto-dev-scheduler-web
npm list | head -20
```

保存为 `diagnose.sh`，运行：
```bash
chmod +x diagnose.sh
./diagnose.sh
```

---

## 获取帮助

1. **官方文档**:
   - [Claude API 文档](https://docs.anthropic.com)
   - [OpenSpec 文档](https://github.com/Fission-AI/OpenSpec)
   - [Electron 文档](https://www.electronjs.org/docs)

2. **社区支持**:
   - GitHub Issues: https://github.com/zengruifeng56-del/auto-dev-scheduler/issues
   - 讨论区: https://github.com/zengruifeng56-del/auto-dev-scheduler/discussions

3. **本地调试**:
   ```bash
   DEBUG=* npm run dev  # 启用详细日志
   ```

---

**最后更新**: 2026-01-23
**支持版本**: Auto-Dev Scheduler v1.5.0+
**兼容系统**: macOS 12.0+, Node.js 20+
