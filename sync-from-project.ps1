# Sync Auto-Dev Scheduler from Project to Generic Version
# Source: E:\Xproject_SanGuo\tools\auto-dev-scheduler-web
# Target: E:\auto-dev-scheduler\tools\auto-dev-scheduler-web

$ErrorActionPreference = "Stop"

$SOURCE = "E:\Xproject_SanGuo\tools\auto-dev-scheduler-web"
$TARGET = "E:\auto-dev-scheduler\tools\auto-dev-scheduler-web"

Write-Host "=== Auto-Dev Scheduler Sync Script ===" -ForegroundColor Cyan
Write-Host "Source: $SOURCE" -ForegroundColor Yellow
Write-Host "Target: $TARGET" -ForegroundColor Yellow
Write-Host ""

# Function to copy file with directory creation
function Copy-FileWithPath {
    param($RelPath)
    $srcFile = Join-Path $SOURCE $RelPath
    $dstFile = Join-Path $TARGET $RelPath

    if (Test-Path $srcFile) {
        $dstDir = Split-Path $dstFile -Parent
        if (-not (Test-Path $dstDir)) {
            New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
        }
        Copy-Item $srcFile $dstFile -Force
        Write-Host "[COPY] $RelPath" -ForegroundColor Green
    } else {
        Write-Host "[SKIP] $RelPath (not found)" -ForegroundColor Yellow
    }
}

Write-Host "Step 1: Copying new main process files..." -ForegroundColor Cyan

$newMainFiles = @(
    "src\main\artifact-store.ts",
    "src\main\codex-worker.ts",
    "src\main\gemini-worker.ts",
    "src\main\metadata-validator.ts",
    "src\main\routing-registry.ts",
    "src\main\worker-factory.ts",
    "src\main\worker-types.ts"
)

foreach ($file in $newMainFiles) {
    Copy-FileWithPath $file
}

Write-Host "`nStep 2: Copying scheduler subsystem..." -ForegroundColor Cyan

$schedulerFiles = @(
    "src\main\scheduler\compile-checker.ts",
    "src\main\scheduler\index.ts",
    "src\main\scheduler\issue-tracker.ts",
    "src\main\scheduler\resilience-manager.ts",
    "src\main\scheduler\scheduler-context.ts",
    "src\main\scheduler\session-persistence.ts",
    "src\main\scheduler\task-manager.ts",
    "src\main\scheduler\worker-pool.ts"
)

foreach ($file in $schedulerFiles) {
    Copy-FileWithPath $file
}

Write-Host "`nStep 3: Copying new renderer components..." -ForegroundColor Cyan

$newComponents = @(
    "src\renderer\components\ApiErrorOverlay.vue",
    "src\renderer\components\ControlCard.vue",
    "src\renderer\components\DelegationTrace.vue",
    "src\renderer\components\ModelDistributionChart.vue",
    "src\renderer\components\ProgressCard.vue",
    "src\renderer\components\TaskCards.vue",
    "src\renderer\components\WavesCard.vue"
)

foreach ($file in $newComponents) {
    Copy-FileWithPath $file
}

Write-Host "`nStep 4: Updating existing files..." -ForegroundColor Cyan

$updateFiles = @(
    "src\main\claude-worker.ts",
    "src\main\file-writer.ts",
    "src\main\index.ts",
    "src\main\ipc-handlers.ts",
    "src\main\log-manager.ts",
    "src\main\parser.ts",
    "src\main\scheduler-service.ts",
    "src\main\scheduler-session-store.ts",
    "src\main\settings-store.ts",
    "src\main\watchdog.ts",
    "src\preload\index.ts",
    "src\renderer\App.vue",
    "src\renderer\components\BlockerOverlay.vue",
    "src\renderer\components\ControlBar.vue",
    "src\renderer\components\IssuesPanel.vue",
    "src\renderer\components\LogPanel.vue",
    "src\renderer\components\PhaseTimeline.vue",
    "src\renderer\components\RetryCountdown.vue",
    "src\renderer\components\SettingsDialog.vue",
    "src\renderer\components\StatusBar.vue",
    "src\renderer\components\TaskTable.vue",
    "src\renderer\main.ts",
    "src\renderer\stores\scheduler.ts",
    "src\shared\electron-api.d.ts",
    "src\shared\ipc-channels.ts",
    "src\shared\task-id.ts",
    "src\shared\types.ts"
)

foreach ($file in $updateFiles) {
    Copy-FileWithPath $file
}

Write-Host "`nStep 5: Updating config files..." -ForegroundColor Cyan

$configFiles = @(
    "package.json",
    "vitest.config.ts",
    "vite.config.ts",
    "tsconfig.json",
    "tsconfig.base.json",
    "tsconfig.node.json",
    "index.html",
    ".gitignore",
    "README.md"
)

foreach ($file in $configFiles) {
    Copy-FileWithPath $file
}

Write-Host "`nStep 6: Copying resources..." -ForegroundColor Cyan

if (Test-Path "$SOURCE\resources") {
    Copy-Item "$SOURCE\resources\*" "$TARGET\resources\" -Recurse -Force
    Write-Host "[COPY] resources/*" -ForegroundColor Green
}

Write-Host "`n=== Sync Complete ===" -ForegroundColor Green
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. cd $TARGET" -ForegroundColor White
Write-Host "2. npm install" -ForegroundColor White
Write-Host "3. npm run dev (test)" -ForegroundColor White
Write-Host "4. npm run build:win (if tests pass)" -ForegroundColor White
