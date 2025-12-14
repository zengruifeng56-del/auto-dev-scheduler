#Requires -Version 5.1
<#
.SYNOPSIS
    Install OpenSpec + Auto-Dev to current project
.DESCRIPTION
    Downloads and installs openspec/, .claude/commands/, tools/auto-dev-scheduler/
    Supports both online and local installation
#>

param(
    [string]$TargetDir = (Get-Location).Path
)

$ErrorActionPreference = "Stop"
$RepoBase = "https://raw.githubusercontent.com/zengruifeng56-del/auto-dev-scheduler/master"

Write-Host "=== OpenSpec + Auto-Dev Install Script ===" -ForegroundColor Cyan
Write-Host "Target directory: $TargetDir"

# Check target directory
if (-not (Test-Path $TargetDir)) {
    Write-Error "Target directory does not exist: $TargetDir"
    exit 1
}

# Helper function to download file
function Download-File {
    param([string]$Url, [string]$Dest)
    $dir = Split-Path -Parent $Dest
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
        return $true
    } catch {
        Write-Warning "Failed to download: $Url"
        return $false
    }
}

# Files to download
$files = @(
    @{ Remote = "openspec/AGENTS.md"; Local = "openspec/AGENTS.md" },
    @{ Remote = "openspec/execution/README.md"; Local = "openspec/execution/README.md" },
    @{ Remote = "openspec/execution/AUTO-DEV.md.template"; Local = "openspec/execution/AUTO-DEV.md.template" },
    @{ Remote = "openspec/project.md.template"; Local = "openspec/project.md.template" },
    @{ Remote = ".claude/commands/auto-dev.md"; Local = ".claude/commands/auto-dev.md" },
    @{ Remote = "tools/auto-dev-scheduler/auto-dev-scheduler.ps1"; Local = "tools/auto-dev-scheduler/auto-dev-scheduler.ps1" },
    @{ Remote = "tools/auto-dev-scheduler/run.bat"; Local = "tools/auto-dev-scheduler/run.bat" }
)

Write-Host ""
Write-Host "Downloading files..." -ForegroundColor Yellow

$downloaded = 0
foreach ($file in $files) {
    $dest = Join-Path $TargetDir $file.Local
    if (Test-Path $dest) {
        Write-Host "  [SKIP] $($file.Local) (already exists)" -ForegroundColor Gray
        continue
    }
    $url = "$RepoBase/$($file.Remote)"
    Write-Host "  [DOWN] $($file.Local)..." -NoNewline
    if (Download-File -Url $url -Dest $dest) {
        Write-Host " OK" -ForegroundColor Green
        $downloaded++
    } else {
        Write-Host " FAILED" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "Downloaded $downloaded files" -ForegroundColor Cyan

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
$projectTemplate = Join-Path $TargetDir "openspec/project.md.template"
$projectMd = Join-Path $TargetDir "openspec/project.md"
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
