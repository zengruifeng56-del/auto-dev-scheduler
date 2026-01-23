#!/usr/bin/env bash
#
# Install OpenSpec + Auto-Dev Scheduler (Electron) to current project
# macOS/Linux compatible version
#

set -euo pipefail

TARGET_DIR="${1:-.}"
REPO_URL="https://github.com/zengruifeng56-del/auto-dev-scheduler.git"
REPO_BASE="https://raw.githubusercontent.com/zengruifeng56-del/auto-dev-scheduler/master"

echo "=== OpenSpec + Auto-Dev Scheduler Install Script (macOS/Linux) ==="
echo "Target directory: $TARGET_DIR"

# Check target directory
if [ ! -d "$TARGET_DIR" ]; then
    echo "Error: Target directory does not exist: $TARGET_DIR"
    exit 1
fi

# Check prerequisites
echo ""
echo "Checking prerequisites..."

HAS_ERRORS=false

# Check Node.js
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    echo "  [OK] Node.js: $NODE_VERSION"
else
    echo "  [ERROR] Node.js not found. Please install Node.js 20+ from: https://nodejs.org"
    HAS_ERRORS=true
fi

# Check Git
if command -v git &> /dev/null; then
    GIT_VERSION=$(git --version)
    echo "  [OK] Git: $GIT_VERSION"
else
    echo "  [ERROR] Git not found. Please install Git from: https://git-scm.com"
    HAS_ERRORS=true
fi

# Check Claude CLI (Required)
if command -v claude &> /dev/null; then
    CLAUDE_VERSION=$(claude --version)
    echo "  [OK] Claude CLI: $CLAUDE_VERSION"
else
    echo "  [ERROR] Claude CLI not found. This is REQUIRED for running workers."
    echo "         Install from: https://docs.anthropic.com/claude/docs/claude-cli"
    HAS_ERRORS=true
fi

# Check OpenSpec CLI (Required)
if command -v openspec &> /dev/null; then
    OPENSPEC_VERSION=$(openspec --version)
    echo "  [OK] OpenSpec CLI: $OPENSPEC_VERSION"
else
    echo "  [ERROR] OpenSpec CLI not found. This is REQUIRED for proposal/archive commands."
    echo "         Install from: https://github.com/Fission-AI/OpenSpec"
    HAS_ERRORS=true
fi

# Exit if critical dependencies missing
if [ "$HAS_ERRORS" = true ]; then
    echo ""
    echo "[ABORT] Please install missing dependencies and try again."
    exit 1
fi

# Clone repo to temp directory
TEMP_DIR=$(mktemp -d)
echo ""
echo "Cloning repository..."
if git clone --depth 1 "$REPO_URL" "$TEMP_DIR" 2>&1 >/dev/null; then
    echo "  [OK] Repository cloned"
    USE_DIRECT_DOWNLOAD=false
else
    echo "Git clone failed, falling back to direct download..."
    USE_DIRECT_DOWNLOAD=true
fi

if [ "$USE_DIRECT_DOWNLOAD" = true ]; then
    # Fallback: download individual files
    echo ""
    echo "Downloading files..."

    FILES=(
        "openspec/AGENTS.md"
        "openspec/project.md.template"
        "openspec/execution/README.md"
        ".claude/commands/openspec/proposal.md"
        ".claude/commands/openspec/apply.md"
        ".claude/commands/openspec/archive.md"
        ".claude/commands/auto-dev.md"
        "docs/CLAUDE-GUIDE.md"
    )

    for FILE in "${FILES[@]}"; do
        DEST="$TARGET_DIR/$FILE"
        if [ -f "$DEST" ]; then
            echo "  [SKIP] $FILE (already exists)"
            continue
        fi

        URL="$REPO_BASE/$FILE"
        echo -n "  [DOWN] $FILE..."

        mkdir -p "$(dirname "$DEST")"
        if curl -fsSL "$URL" -o "$DEST" 2>/dev/null; then
            echo " OK"
        else
            echo " FAILED"
        fi
    done

    echo ""
    echo "[WARN] Scheduler source not copied. Please clone the repo manually:"
    echo "  git clone $REPO_URL"
    echo "  cp -r auto-dev-scheduler/tools/auto-dev-scheduler-web $TARGET_DIR/tools/"
else
    # Copy files from cloned repo
    echo ""
    echo "Copying files..."

    DIRS=(
        "openspec"
        ".claude"
        "tools/auto-dev-scheduler-web"
        "docs"
    )

    for DIR in "${DIRS[@]}"; do
        SRC="$TEMP_DIR/$DIR"
        DEST="$TARGET_DIR/$DIR"

        if [ -d "$SRC" ]; then
            if [ ! -d "$DEST" ]; then
                cp -r "$SRC" "$DEST"
                echo "  [OK] Copied $DIR"
            else
                # Merge: copy files that don't exist
                rsync -a --ignore-existing "$SRC/" "$DEST/"
                echo "  [OK] Merged $DIR"
            fi
        fi
    done

    # Cleanup temp directory
    rm -rf "$TEMP_DIR"
fi

# Check if CLAUDE.md needs OpenSpec reference
CLAUDE_MD="$TARGET_DIR/CLAUDE.md"
OPENSPEC_BLOCK='

<!-- OPENSPEC:START -->
# OpenSpec + Auto-Dev Instructions

These instructions are for AI assistants working in this project.

## Auto-Dev Scheduler (Multi-Claude Parallel Execution)

When user asks about Auto-Dev Scheduler usage, read `@/docs/CLAUDE-GUIDE.md` for:
- How to start the scheduler
- How to create AUTO-DEV.md task files
- Task ID format and dependency syntax
- Troubleshooting guide

Quick start (Electron version):
```bash
cd tools/auto-dev-scheduler-web
npm install
npm run dev
```

## OpenSpec (Spec-Driven Development)

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts
- Sounds ambiguous and you need the authoritative spec before coding

<!-- OPENSPEC:END -->
'

if [ -f "$CLAUDE_MD" ]; then
    if ! grep -q "OPENSPEC:START" "$CLAUDE_MD"; then
        echo "$OPENSPEC_BLOCK" >> "$CLAUDE_MD"
        echo "[OK] Added OpenSpec reference to CLAUDE.md"
    else
        echo "[OK] CLAUDE.md already contains OpenSpec reference"
    fi
else
    echo "$OPENSPEC_BLOCK" > "$CLAUDE_MD"
    echo "[OK] Created CLAUDE.md"
fi

# Rename template files if needed
PROJECT_TEMPLATE="$TARGET_DIR/openspec/project.md.template"
PROJECT_MD="$TARGET_DIR/openspec/project.md"
if [ -f "$PROJECT_TEMPLATE" ] && [ ! -f "$PROJECT_MD" ]; then
    mv "$PROJECT_TEMPLATE" "$PROJECT_MD"
    echo "[OK] Renamed project.md.template -> project.md (please edit)"
fi

echo ""
echo "=== Installation Complete ==="

# Check and install scheduler dependencies
SCHEDULER_PATH="$TARGET_DIR/tools/auto-dev-scheduler-web"
if [ -f "$SCHEDULER_PATH/package.json" ]; then
    echo ""
    echo "Installing scheduler dependencies..."
    cd "$SCHEDULER_PATH"

    if [ ! -d "node_modules" ]; then
        if npm install >/dev/null 2>&1; then
            echo "  [OK] Scheduler dependencies installed"
        else
            echo "  [WARN] npm install failed. Please run manually:"
            echo "         cd tools/auto-dev-scheduler-web && npm install"
        fi
    else
        echo "  [OK] Scheduler dependencies already installed"
    fi

    cd - >/dev/null
fi

echo ""
echo "Next steps:"
echo "1. Edit openspec/project.md to fill in project info"
echo "2. Start the scheduler:"
echo "   cd tools/auto-dev-scheduler-web && npm run dev"
echo "3. Create your first proposal:"
echo "   Ask Claude: /openspec:proposal <feature-name>"
echo ""
