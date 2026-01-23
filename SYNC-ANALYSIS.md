# Auto-Dev Scheduler Sync Analysis

## Overview

This document outlines the differences between:
- **Source**: `E:\Xproject_SanGuo\tools\auto-dev-scheduler-web` (v1.0.0 → Latest)
- **Target**: `E:\auto-dev-scheduler\tools\auto-dev-scheduler-web` (v1.4.0 outdated)

## Version History

- **Project Version**: 1.0.0 (with extensive recent updates)
- **Generic Version**: 1.4.0 (outdated, missing Phase 4 updates)

## Major Architecture Changes

### Phase 4: Claude-First Architecture

The project version has evolved to a **Claude-First** architecture where:
- All tasks route through Claude by default
- Claude decides delegation to Codex/Gemini via MCP tools
- Direct Codex/Gemini worker instantiation is deprecated
- Routing hints are provided via `routing-registry.ts`

### Key Architectural Components Added

1. **Worker Factory System** (`worker-factory.ts`)
   - Centralized worker creation
   - Routing decision preview
   - Delegation hint generation

2. **Scheduler Subsystem** (`scheduler/` directory)
   - `compile-checker.ts`: TypeScript compilation validation
   - `issue-tracker.ts`: Centralized issue tracking
   - `resilience-manager.ts`: API error handling & retry logic
   - `scheduler-context.ts`: Shared scheduler state
   - `session-persistence.ts`: Pause/resume with state hydration
   - `task-manager.ts`: Task lifecycle management
   - `worker-pool.ts`: Worker instance pooling

3. **Routing Registry** (`routing-registry.ts`)
   - Task-to-worker routing rules
   - Persona-based delegation hints
   - Pattern matching for task categorization

4. **Enhanced Workers**
   - `codex-worker.ts`: Specialized backend/debug worker
   - `gemini-worker.ts`: Specialized frontend/UI worker
   - Enhanced `claude-worker.ts` with MCP delegation

5. **Metadata Validation** (`metadata-validator.ts`)
   - OpenSpec task metadata validation
   - Ensures compliance with AUTO-DEV.md format

6. **Artifact Store** (`artifact-store.ts`)
   - Centralized artifact management
   - File output tracking

## New UI Components

### Renderer Components Added

1. **ApiErrorOverlay.vue**: API rate limit/error handling UI
2. **ControlCard.vue**: Enhanced control panel
3. **DelegationTrace.vue**: Visual worker delegation flow
4. **ModelDistributionChart.vue**: ECharts-based model usage visualization
5. **ProgressCard.vue**: Enhanced progress display
6. **TaskCards.vue**: Card-based task view
7. **WavesCard.vue**: Wave-based task grouping UI

### Enhanced Components

- **ControlBar.vue**: Updated with new controls
- **IssuesPanel.vue**: Enhanced issue display
- **LogPanel.vue**: Improved log viewer
- **PhaseTimeline.vue**: Better phase visualization
- **SettingsDialog.vue**: Additional configuration options
- **TaskTable.vue**: Enhanced task table

## Dependencies Changes

### Added Dependencies

```json
{
  "echarts": "^6.0.0",
  "vue-echarts": "^8.0.1",
  "vitest": "^2.1.0"
}
```

### Added Dev Scripts

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage"
}
```

## Files to Sync

### New Files to Copy

**Main Process**:
- `src/main/artifact-store.ts`
- `src/main/codex-worker.ts`
- `src/main/gemini-worker.ts`
- `src/main/metadata-validator.ts`
- `src/main/routing-registry.ts`
- `src/main/worker-factory.ts`
- `src/main/worker-types.ts`
- `src/main/scheduler/` (entire directory)
  - `compile-checker.ts`
  - `index.ts`
  - `issue-tracker.ts`
  - `resilience-manager.ts`
  - `scheduler-context.ts`
  - `session-persistence.ts`
  - `task-manager.ts`
  - `worker-pool.ts`

**Renderer Components**:
- `src/renderer/components/ApiErrorOverlay.vue`
- `src/renderer/components/ControlCard.vue`
- `src/renderer/components/DelegationTrace.vue`
- `src/renderer/components/ModelDistributionChart.vue`
- `src/renderer/components/ProgressCard.vue`
- `src/renderer/components/TaskCards.vue`
- `src/renderer/components/WavesCard.vue`

### Files to Update

**Main Process**:
- `src/main/claude-worker.ts`
- `src/main/file-writer.ts`
- `src/main/index.ts`
- `src/main/ipc-handlers.ts`
- `src/main/parser.ts`
- `src/main/scheduler-service.ts`
- `src/main/scheduler-session-store.ts`
- `src/main/settings-store.ts`
- `src/main/watchdog.ts`

**Renderer**:
- `src/renderer/App.vue`
- `src/renderer/components/*.vue` (all existing)
- `src/renderer/stores/scheduler.ts`

**Config**:
- `package.json`
- `vitest.config.ts` (new file)

### Shared Types

Need to sync:
- `src/shared/types.ts`
- `src/shared/ipc-channels.ts`
- `src/shared/electron-api.d.ts`

## Configuration Files

### package.json Updates

```diff
- "version": "1.4.0"
+ "version": "1.0.0"

+ "echarts": "^6.0.0",
+ "vue-echarts": "^8.0.1"

+ "vitest": "^2.1.0",
+ "test": "vitest run",
+ "test:watch": "vitest",
+ "test:coverage": "vitest run --coverage"
```

### vitest.config.ts

New file needed for testing support.

## Breaking Changes

1. **Worker Instantiation**: Direct Codex/Gemini worker creation deprecated
2. **Routing Logic**: Now centralized in `routing-registry.ts`
3. **Scheduler API**: Enhanced with new callbacks and events
4. **IPC Channels**: New channels for enhanced features

## Migration Strategy

1. ✅ Backup current generic version
2. ✅ Copy new files
3. ✅ Update modified files
4. ✅ Update package.json
5. ✅ Add vitest.config.ts
6. ✅ Test compilation
7. ✅ Test runtime functionality

## Testing Checklist

- [ ] npm install succeeds
- [ ] npm run dev launches without errors
- [ ] Task parsing works correctly
- [ ] Worker delegation functions properly
- [ ] UI renders all new components
- [ ] Settings dialog shows new options
- [ ] Session persistence works
- [ ] Issue tracker displays correctly
- [ ] Model distribution chart renders
- [ ] Compilation checker functions

## Notes

- The project version is actively developed and may have SanGuo-specific features
- Some features might need generalization for public distribution
- Documentation needs to be updated to reflect Phase 4 architecture
- Consider adding migration guide for existing users

---

**Analysis Date**: 2026-01-23
**Analyzed By**: Claude Opus 4.5
