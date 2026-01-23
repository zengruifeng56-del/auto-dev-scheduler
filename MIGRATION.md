# Migration Guide: v1.4.0 → v1.5.0 (Phase 4)

## Overview

Version 1.5.0 introduces the **Claude-First Architecture**, a significant architectural evolution that changes how tasks are routed and executed.

## Breaking Changes

### 1. Worker Instantiation Model

**Before (v1.4.0)**:
```typescript
// Direct worker creation based on task type
const worker = taskType === 'frontend'
  ? new GeminiWorker(config)
  : new CodexWorker(config);
```

**After (v1.5.0)**:
```typescript
// All tasks go through Claude
// Claude decides internally whether to delegate via MCP
const worker = new ClaudeWorker(config);
// Delegation happens via mcp__codex__codex or mcp__gemini__gemini
```

### 2. Routing Logic

**Before**: Task type directly determines worker type
**After**: `routing-registry.ts` provides hints, Claude makes final decision

### 3. Worker Factory API

The `WorkerFactory.create()` method now throws for direct Codex/Gemini instantiation:

```typescript
// ❌ This will throw in v1.5.0
factory.create({ type: 'codex-cli', ... });

// ✅ This is the new way
factory.create({ type: 'claude-cli', ... });
// Claude internally routes to Codex via MCP if needed
```

## New Features

### 1. Enhanced Scheduler Subsystem

The scheduler is now modularized into specialized components:

```typescript
import {
  IssueTracker,
  SessionPersistence,
  ResilienceManager,
  WorkerPool,
  TaskManager,
  CompileChecker
} from './scheduler';
```

Each module has a focused responsibility:
- **IssueTracker**: Collect and manage cross-task issues
- **SessionPersistence**: Pause/resume with state hydration
- **ResilienceManager**: API error handling with exponential backoff
- **WorkerPool**: Worker lifecycle management
- **TaskManager**: Task state transitions
- **CompileChecker**: TypeScript compilation validation

### 2. Metadata Validation

AUTO-DEV.md format is now validated automatically:

```typescript
import { validateTaskMetadata } from './metadata-validator';

const validation = validateTaskMetadata(task);
if (!validation.isValid) {
  console.error('Invalid task format:', validation.errors);
}
```

### 3. Artifact Management

Centralized artifact tracking:

```typescript
import { ArtifactStore } from './artifact-store';

const store = new ArtifactStore(projectRoot);
store.recordArtifact(taskId, {
  path: 'src/components/Button.vue',
  type: 'component'
});
```

### 4. Visualization Components

#### Model Distribution Chart
```vue
<ModelDistributionChart :data="modelUsageData" />
```

Shows ECharts-based visualization of which models (Claude/Codex/Gemini) were used for which tasks.

#### Delegation Trace
```vue
<DelegationTrace :trace="delegationChain" />
```

Visual representation of Claude → Codex/Gemini delegation flow.

## Migration Steps

### Step 1: Update Dependencies

```bash
cd tools/auto-dev-scheduler-web
npm install
```

New dependencies will be added automatically:
- `echarts` ^6.0.0
- `vue-echarts` ^8.0.1
- `vitest` ^2.1.0

### Step 2: Update Worker References

If you have custom code that creates workers:

```diff
- import { CodexWorker, GeminiWorker } from './workers';
+ import { ClaudeWorker } from './claude-worker';
+ import { getDelegationHint } from './routing-registry';

- const worker = persona === 'backend' ? new CodexWorker(...) : new GeminiWorker(...);
+ const worker = new ClaudeWorker(...);
+ const hint = getDelegationHint(persona);
+ // Pass hint to Claude via initial prompt
```

### Step 3: Update Scheduler Imports

```diff
- import { SchedulerService } from './scheduler-service';
+ import { SchedulerService } from './scheduler-service';
+ import {
+   IssueTracker,
+   SessionPersistence,
+   ResilienceManager
+ } from './scheduler';
```

### Step 4: Test Migration

```bash
# Type check
npm run typecheck

# Build
npm run build

# Run tests (new in v1.5.0)
npm test

# Start in dev mode
npm run dev
```

### Step 5: Verify Functionality

1. Load an AUTO-DEV.md file
2. Start scheduling with 2-3 workers
3. Check the new UI components:
   - Model distribution chart should appear
   - Delegation traces should show in logs
   - API error overlay should work if rate-limited

## Configuration Changes

### Settings Dialog

New options available:

- **Auto-Retry**: Configure automatic task retry on failure
  - Max retry count (default: 2)
  - Base delay (default: 30s with exponential backoff)

- **Blocker Auto-Pause**: Automatically pause on blocker-level issues

- **Issue Tracking**: Enable/disable cross-task issue collection

### Watchdog Configuration

Enhanced slow tool detection:

```typescript
{
  slowToolTimeouts: {
    codex: 60 * 60_000,      // 60 min
    gemini: 60 * 60_000,     // 60 min
    npmInstall: 15 * 60_000, // 15 min
    npmBuild: 20 * 60_000,   // 20 min
    default: 10 * 60_000     // 10 min
  }
}
```

## Behavioral Changes

### Task Routing

**Before**: Task `persona` field directly specified worker type
**After**: Task `persona` is a hint; Claude decides delegation

Example AUTO-DEV.md:
```markdown
### FE-01: Build Login Form

**Persona**: frontend
```

v1.4.0: Spawns GeminiWorker directly
v1.5.0: Spawns ClaudeWorker, which may delegate to Gemini via MCP

### Session Persistence

**Before**: Only task completion states persisted
**After**: Full session state including:
- Issue tracker contents
- Pause reason (user/blocker)
- Worker delegation history
- API error backoff state

### Issue Collection

**Before**: Workers report issues via logs
**After**: Structured issue reporting with severity levels:
- `blocker`: Stops scheduling automatically
- `error`: Tracked but doesn't block
- `warning`: Informational

Workers can emit:
```
AUTO_DEV_ISSUE: {"severity": "blocker", "message": "..."}
```

## API Changes

### Scheduler Service

#### New Methods

```typescript
class SchedulerService {
  // Session management
  saveSession(): Promise<void>
  loadSession(): Promise<void>

  // Issue tracking
  getIssues(): RawIssueReport[]
  clearIssues(): void

  // Worker delegation
  getWorkerDelegationHistory(workerId: number): DelegationEvent[]
}
```

#### Changed Methods

```typescript
// Before
spawnWorker(taskId: string): void

// After
spawnWorker(taskId: string, hint?: DelegationHint): void
```

### IPC Channels

#### New Channels

```typescript
// Issue tracking
'scheduler:getIssues'
'scheduler:clearIssues'

// Session persistence
'scheduler:saveSession'
'scheduler:loadSession'

// API resilience
'scheduler:getApiErrorState'
'scheduler:retryAfterBackoff'
```

## Troubleshooting

### Build Errors

**Error**: `Cannot find module './scheduler'`

**Solution**: Ensure all new files are present. Re-run sync script or manually copy `src/main/scheduler/` directory.

### Runtime Errors

**Error**: `WorkerFactory.create() threw ClaudeWorkerNotImplementedError`

**Solution**: The factory is for internal use only. Use `ClaudeWorker` directly or through `SchedulerService.spawnWorker()`.

### UI Issues

**Error**: ECharts not rendering

**Solution**: Check that `echarts` and `vue-echarts` are installed:
```bash
npm list echarts vue-echarts
```

### Type Errors

**Error**: `Property 'persona' does not exist on type Task`

**Solution**: Update `src/shared/types.ts` from the latest version.

## Rollback Plan

If critical issues arise:

```bash
cd tools/auto-dev-scheduler-web
git checkout v1.4.0
npm install
npm run build:win
```

Note: Session files from v1.5.0 may not be compatible with v1.4.0.

## Support

For issues specific to the Phase 4 migration:
1. Check `SYNC-ANALYSIS.md` for detailed change list
2. Review git diff: `git diff v1.4.0..v1.5.0`
3. Open an issue at [GitHub Issues](https://github.com/zengruifeng56-del/auto-dev-scheduler/issues)

## Changelog Summary

See `README.md` for full changelog. Key highlights:

- ✅ Claude-First architecture
- ✅ Modular scheduler subsystem
- ✅ ECharts visualization
- ✅ Enhanced issue tracking
- ✅ Session persistence improvements
- ✅ API resilience with exponential backoff
- ✅ Vitest integration

---

**Last Updated**: 2026-01-23
