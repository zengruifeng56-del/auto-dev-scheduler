# Linux 用户完整指南

本指南为 Linux 用户提供详细的安装和使用说明。

---

## 系统兼容性

支持的 Linux 发行版：
- Ubuntu 20.04+
- Debian 11+
- Fedora 33+
- CentOS 8+
- Arch Linux

---

## 前置要求检查

### 1. 检查 Linux 版本

```bash
lsb_release -a
# 或
cat /etc/os-release
```

### 2. 更新包管理器

**Ubuntu/Debian**:
```bash
sudo apt update
sudo apt upgrade -y
```

**Fedora/CentOS**:
```bash
sudo dnf update -y
```

**Arch**:
```bash
sudo pacman -Syu
```

---

## 逐步安装

### Step 1: 安装 Node.js 20+

**Ubuntu/Debian**:
```bash
# 使用 NodeSource 仓库
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

**Fedora/CentOS**:
```bash
sudo dnf install -y nodejs npm
```

**Arch**:
```bash
sudo pacman -S nodejs npm
```

**使用 nvm**（推荐，多版本管理）:
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# 重新加载 shell
source ~/.bashrc

# 安装 Node.js 20
nvm install 20
nvm use 20
nvm alias default 20
```

验证安装：
```bash
node --version  # v20.x.x
npm --version   # 10.x.x
```

### Step 2: 安装 Git

**Ubuntu/Debian**:
```bash
sudo apt install -y git
```

**Fedora/CentOS**:
```bash
sudo dnf install -y git
```

**Arch**:
```bash
sudo pacman -S git
```

验证：
```bash
git --version
```

### Step 3: 安装 Claude CLI

```bash
# 使用 npm 全局安装
npm install -g @anthropic-ai/claude-cli

# 验证
claude --version

# 配置 API Key
export ANTHROPIC_API_KEY="your-api-key-here"

# 添加到 ~/.bashrc 或 ~/.zshrc（永久配置）
echo 'export ANTHROPIC_API_KEY="your-api-key-here"' >> ~/.bashrc
source ~/.bashrc
```

### Step 4: 安装 OpenSpec CLI

```bash
# 使用 npm 全局安装
npm install -g openspec

# 验证
openspec --version
```

### Step 5: 安装构建工具（Linux 特定）

某些 npm 包可能需要编译：

**Ubuntu/Debian**:
```bash
sudo apt install -y build-essential python3
```

**Fedora/CentOS**:
```bash
sudo dnf install -y gcc-c++ make python3
```

**Arch**:
```bash
sudo pacman -S base-devel python3
```

### Step 6: 安装 Auto-Dev Scheduler

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

### 开发模式（推荐 Linux 用户使用）

```bash
cd tools/auto-dev-scheduler-web
npm run dev
```

浏览器会自动打开 `http://localhost:5174`。

### Headless 模式（无 GUI，用于服务器）

如果在无图形界面的 Linux 服务器上运行：

```bash
# 安装必要的 X11 库
sudo apt install -y libgconf-2-4 libatk1.0-0 libgdk-pixbuf2.0-0 libgtk-3-0

# 使用 xvfb 虚拟显示
sudo apt install -y xvfb

# 运行
xvfb-run -a npm start
```

或使用 Docker（推荐用于服务器）：

```bash
# 使用 Docker 运行
docker run -it -v $(pwd):/app -p 5174:5174 \
  node:20 bash -c "cd /app/tools/auto-dev-scheduler-web && npm install && npm run dev"
```

---

## 配置环境变量

### 方式 1: 临时配置（仅当前会话）

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENSPEC_HOME="$HOME/.openspec"
```

### 方式 2: 永久配置

编辑 `~/.bashrc` 或 `~/.zshrc`：

```bash
# 编辑配置文件
nano ~/.bashrc

# 添加以下内容
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENSPEC_HOME="$HOME/.openspec"
export NODE_OPTIONS="--max-old-space-size=4096"  # 增加 Node 内存限制

# 保存: Ctrl+X, Y, Enter
# 重新加载配置
source ~/.bashrc
```

### 方式 3: 使用 systemd 服务（高级）

创建 `~/.config/systemd/user/auto-dev-scheduler.service`：

```ini
[Unit]
Description=Auto-Dev Scheduler
After=network.target

[Service]
Type=simple
User=%u
WorkingDirectory=%h/YourProject/tools/auto-dev-scheduler-web
Environment="ANTHROPIC_API_KEY=sk-ant-..."
ExecStart=%h/.nvm/versions/node/v20.x.x/bin/npm run dev
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

启用和运行：
```bash
systemctl --user daemon-reload
systemctl --user enable auto-dev-scheduler
systemctl --user start auto-dev-scheduler

# 查看状态
systemctl --user status auto-dev-scheduler
```

---

## 常见问题

### Q1: "command not found: node"

**原因**: Node.js 不在 PATH 中或未正确安装

**解决**:
```bash
# 如果使用 nvm
nvm use 20
nvm alias default 20

# 如果使用系统包管理器，重新安装
sudo apt install -y nodejs

# 检查 PATH
echo $PATH
which node
```

### Q2: npm 权限错误

**原因**: npm 尝试在全局目录安装，但没有权限

**解决**:
```bash
# 方式 1: 使用 sudo（不推荐）
sudo npm install -g ...

# 方式 2: 修改 npm 默认目录（推荐）
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

### Q3: "npm install" 超时或失败

**原因**: 网络连接或 npm 源问题

**解决**:
```bash
# 使用国内源（如果在中国）
npm config set registry https://registry.npmmirror.com

# 清除缓存
npm cache clean --force

# 增加超时时间
npm config set fetch-timeout 120000

# 重试
npm install
```

### Q4: Electron 相关错误（Linux 特定）

**原因**: 缺少图形库依赖

**解决**:
```bash
# Ubuntu/Debian
sudo apt install -y libgconf-2-4 libatk1.0-0 libgdk-pixbuf2.0-0 libgtk-3-0

# 或使用 Electron 官方支持的依赖
npm install electron-deps
```

### Q5: 内存不足错误

**原因**: Node.js 进程耗尽内存

**解决**:
```bash
# 增加 Node 内存限制
export NODE_OPTIONS="--max-old-space-size=4096"
npm run dev

# 或在 ~/.bashrc 中永久设置
```

### Q6: 端口被占用（5174）

**原因**: 其他进程已使用该端口

**解决**:
```bash
# 查找占用端口的进程
lsof -i :5174
ss -tlnp | grep 5174

# 杀死进程
kill -9 <PID>

# 或使用其他端口
npm run dev -- --port 5175
```

### Q7: 原生模块编译失败

**原因**: 缺少编译工具或 Python 3

**解决**:
```bash
# 安装编译工具
sudo apt install -y build-essential python3

# 清除缓存并重新安装
rm -rf node_modules package-lock.json
npm install
```

---

## 性能优化

### 1. 使用本地 npm 缓存

```bash
npm config set prefer-offline true
npm config set cache-min 999999999
```

### 2. 并行安装依赖

```bash
npm config set maxsockets 10
```

### 3. 监控资源使用

```bash
# 实时监控
top
htop  # 更友好的界面（安装: sudo apt install htop）

# 查看 Node 进程
ps aux | grep node
```

### 4. 启用 Node.js profiling

```bash
NODE_OPTIONS="--prof" npm run dev
node --prof-process isolate-*.log > profile.txt
```

---

## Docker 部署（推荐用于生产）

创建 `Dockerfile`：

```dockerfile
FROM node:20-alpine

WORKDIR /app

# 安装依赖
RUN apk add --no-cache git

# 复制项目
COPY . .

# 安装 npm 依赖
RUN npm install
RUN cd tools/auto-dev-scheduler-web && npm install

# 暴露端口
EXPOSE 5174

# 启动
CMD ["npm", "run", "dev"]
```

构建和运行：

```bash
# 构建镜像
docker build -t auto-dev-scheduler .

# 运行容器
docker run -it -p 5174:5174 \
  -e ANTHROPIC_API_KEY="sk-ant-..." \
  auto-dev-scheduler
```

或使用 docker-compose：

创建 `docker-compose.yml`：

```yaml
version: '3.8'

services:
  scheduler:
    build: .
    ports:
      - "5174:5174"
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - OPENSPEC_HOME=/app/.openspec
    volumes:
      - ./openspec:/app/openspec
      - ./tools:/app/tools
```

运行：
```bash
docker-compose up
```

---

## 工作流程

### 创建提案

```bash
cd ~/YourProject

# 使用 Claude 创建提案
claude "/openspec:proposal add-user-auth"

# 验证提案
openspec validate add-user-auth --strict
```

### 转换为并发任务

```bash
# 手动创建 openspec/execution/add-user-auth/AUTO-DEV.md
# 参考 openspec/execution/README.md 中的格式

mkdir -p openspec/execution/add-user-auth
cat > openspec/execution/add-user-auth/AUTO-DEV.md << 'EOF'
# AUTO-DEV: Add User Auth

## 并行波次图

Wave 1: TASK-01, TASK-02
Wave 2: TASK-03

---

## Wave 1: 基础设施

### TASK-01: 创建认证模块

- [ ] 创建 src/auth/

**依赖**: 无

...
EOF
```

### 启动调度器

```bash
# 启动
cd tools/auto-dev-scheduler-web
npm run dev

# 打开浏览器
# http://localhost:5174

# 加载 AUTO-DEV.md 文件
# 设置并发数并点击 Start
```

### 归档完成的变更

```bash
claude "/openspec:archive add-user-auth"
```

---

## 故障排查

### 完整的诊断步骤

```bash
#!/bin/bash

echo "=== System Info ==="
lsb_release -a
uname -a

echo ""
echo "=== Node/npm ==="
node --version
npm --version

echo ""
echo "=== Claude CLI ==="
claude --version
echo "API Key: ${ANTHROPIC_API_KEY:0:10}***"

echo ""
echo "=== OpenSpec CLI ==="
openspec --version

echo ""
echo "=== Disk Space ==="
df -h

echo ""
echo "=== Memory ==="
free -h

echo ""
echo "=== Port 5174 ==="
lsof -i :5174 || echo "Port available"
```

保存为 `diagnose.sh`，运行：
```bash
chmod +x diagnose.sh
./diagnose.sh
```

---

## 获取帮助

1. **官方文档**:
   - [Node.js 文档](https://nodejs.org/docs)
   - [npm 文档](https://docs.npmjs.com)
   - [Claude API 文档](https://docs.anthropic.com)
   - [OpenSpec 文档](https://github.com/Fission-AI/OpenSpec)

2. **社区支持**:
   - GitHub Issues: https://github.com/zengruifeng56-del/auto-dev-scheduler/issues
   - Stack Overflow: 搜索 `auto-dev-scheduler`

3. **本地调试**:
   ```bash
   DEBUG=* npm run dev  # 启用详细日志
   NODE_DEBUG=* npm run dev  # Node.js 调试
   ```

---

**最后更新**: 2026-01-23
**支持版本**: Auto-Dev Scheduler v1.5.0+
**兼容系统**: Ubuntu 20.04+, Debian 11+, Node.js 20+
