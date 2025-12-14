#Requires -Version 5.1
<#
.SYNOPSIS
    Install OpenSpec + Auto-Dev to current project
.DESCRIPTION
    Copies openspec/, .claude/commands/, tools/auto-dev-scheduler/ to target directory
#>

param(
    [string]$TargetDir = (Get-Location).Path
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== OpenSpec + Auto-Dev Install Script ===" -ForegroundColor Cyan
Write-Host "Target directory: $TargetDir"

# Check target directory
if (-not (Test-Path $TargetDir)) {
    Write-Error "Target directory does not exist: $TargetDir"
    exit 1
}

# Copy openspec/
$srcOpenspec = Join-Path $ScriptDir "openspec"
$dstOpenspec = Join-Path $TargetDir "openspec"
if (Test-Path $dstOpenspec) {
    Write-Warning "openspec/ already exists, skipping (delete manually to overwrite)"
} else {
    Copy-Item -Path $srcOpenspec -Destination $dstOpenspec -Recurse
    Write-Host "[OK] Copied openspec/" -ForegroundColor Green
}

# Copy .claude/commands/
$srcCommands = Join-Path $ScriptDir ".claude\commands"
$dstCommands = Join-Path $TargetDir ".claude\commands"
if (-not (Test-Path (Join-Path $TargetDir ".claude"))) {
    New-Item -ItemType Directory -Path (Join-Path $TargetDir ".claude") | Out-Null
}
if (-not (Test-Path $dstCommands)) {
    New-Item -ItemType Directory -Path $dstCommands | Out-Null
}
$autodevCmd = Join-Path $srcCommands "auto-dev.md"
$dstAutodevCmd = Join-Path $dstCommands "auto-dev.md"
if (Test-Path $dstAutodevCmd) {
    Write-Warning "auto-dev.md already exists, skipping"
} else {
    Copy-Item -Path $autodevCmd -Destination $dstAutodevCmd
    Write-Host "[OK] Copied .claude/commands/auto-dev.md" -ForegroundColor Green
}

# Copy tools/auto-dev-scheduler/
$srcScheduler = Join-Path $ScriptDir "tools\auto-dev-scheduler"
$dstTools = Join-Path $TargetDir "tools"
$dstScheduler = Join-Path $dstTools "auto-dev-scheduler"
if (-not (Test-Path $dstTools)) {
    New-Item -ItemType Directory -Path $dstTools | Out-Null
}
if (Test-Path $dstScheduler) {
    Write-Warning "tools/auto-dev-scheduler/ already exists, skipping"
} else {
    Copy-Item -Path $srcScheduler -Destination $dstScheduler -Recurse
    Write-Host "[OK] Copied tools/auto-dev-scheduler/" -ForegroundColor Green
}

# Check if CLAUDE.md needs OpenSpec reference
$claudeMd = Join-Path $TargetDir "CLAUDE.md"
$openspecBlock = @"

<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open ``@/openspec/AGENTS.md`` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use ``@/openspec/AGENTS.md`` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

<!-- OPENSPEC:END -->
"@

if (Test-Path $claudeMd) {
    $content = Get-Content $claudeMd -Raw -Encoding UTF8
    if ($content -notmatch "OPENSPEC:START") {
        Add-Content -Path $claudeMd -Value $openspecBlock -Encoding UTF8
        Write-Host "[OK] Added OpenSpec reference to CLAUDE.md" -ForegroundColor Green
    } else {
        Write-Host "[OK] CLAUDE.md already contains OpenSpec reference" -ForegroundColor Yellow
    }
} else {
    Set-Content -Path $claudeMd -Value $openspecBlock -Encoding UTF8
    Write-Host "[OK] Created CLAUDE.md" -ForegroundColor Green
}

# Rename template files if needed
$projectTemplate = Join-Path $dstOpenspec "project.md.template"
$projectMd = Join-Path $dstOpenspec "project.md"
if ((Test-Path $projectTemplate) -and -not (Test-Path $projectMd)) {
    Rename-Item -Path $projectTemplate -NewName "project.md"
    Write-Host "[OK] Renamed project.md.template -> project.md (please edit)" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Installation Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Edit openspec/project.md to fill in project info"
Write-Host "2. Create openspec/execution/{project}/AUTO-DEV.md (see AUTO-DEV.md.template)"
Write-Host "3. Run tools/auto-dev-scheduler/run.bat to start scheduler"
Write-Host ""
