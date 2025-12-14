# OpenSpec + Auto-Dev Scheduler

Multi-Claude concurrent development framework.

## Features

- **OpenSpec** - Spec-driven development workflow
- **Auto-Dev Scheduler** - GUI task scheduler for concurrent Claude execution
- **/auto-dev command** - Claude Code concurrent execution protocol

## Quick Install (Windows)

In your target project root, run PowerShell:

```powershell
# Local install (if downloaded)
.\path\to\auto-dev-scheduler\install.ps1
```

## Post-Install Configuration

1. Edit `openspec/project.md` to fill in your project info
2. Create `openspec/execution/{project-name}/AUTO-DEV.md` (see template)
3. Run `tools/auto-dev-scheduler/run.bat` to start the scheduler

## Directory Structure

```
your-project/
├── openspec/
│   ├── AGENTS.md                 # OpenSpec AI agent guide
│   ├── project.md                # Project configuration
│   └── execution/
│       ├── README.md             # AUTO-DEV.md format spec
│       └── {project}/
│           └── AUTO-DEV.md       # Concurrent task file
├── .claude/
│   └── commands/
│       └── auto-dev.md           # /auto-dev command spec
└── tools/
    └── auto-dev-scheduler/
        ├── auto-dev-scheduler.ps1
        └── run.bat
```

## Workflow

```
User Request
    ↓
OpenSpec Proposal (/openspec:proposal)
    ↓
openspec/changes/{change-id}/
├── proposal.md   ← Why, What
├── design.md     ← Technical decisions
├── tasks.md      ← Fine-grained checklist (single Claude)
└── specs/        ← Spec changes
    ↓
After Approval → Convert to Concurrent Tasks
    ↓
openspec/execution/{project}/AUTO-DEV.md  ← Coarse-grained tasks (multi-Claude)
    ↓
/auto-dev Concurrent Execution
    ↓
After Completion → OpenSpec Archive (/openspec:archive)
```

## Task ID Format

The scheduler supports generalized task ID format: `XX-YYY`

Examples:
- `GM-00`, `GM-01` (Game Manager)
- `FE-01`, `FE-AUTH-01` (Frontend)
- `BE-API-01` (Backend)
- `TASK-001` (Generic)

## Usage

1. **Start Scheduler**: Run `tools/auto-dev-scheduler/run.bat`
2. **Select Task File**: Browse to `openspec/execution/{project}/AUTO-DEV.md`
3. **Set Parallelism**: Choose 1-4 concurrent workers
4. **Click Start**: Scheduler will launch Claude instances automatically

## Task States

| State | Meaning |
|-------|---------|
| 🟦 Idle | Ready to claim |
| ⏳ Waiting | Dependencies not met |
| 🟠 Running | Being executed |
| ✅ Completed | Done |
| ⚠️ Blocked | Needs attention |

## Requirements

- Windows (PowerShell 5.1+)
- Claude Code CLI installed and configured
- Git (for distributed locking)
