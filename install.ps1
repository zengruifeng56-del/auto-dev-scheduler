#Requires -Version 5.1
<#
.SYNOPSIS
    Install OpenSpec + Auto-Dev Scheduler (Electron) to current project
.DESCRIPTION
    Downloads and installs openspec/, .claude/commands/, tools/auto-dev-scheduler-web/
    Supports both online and local installation
#>

param(
    [string]$TargetDir = (Get-Location).Path
)

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/zengruifeng56-del/auto-dev-scheduler.git"
$RepoBase = "https://raw.githubusercontent.com/zengruifeng56-del/auto-dev-scheduler/master"

Write-Host "=== OpenSpec + Auto-Dev Scheduler Install Script ===" -ForegroundColor Cyan
Write-Host "Target directory: $TargetDir"

# Check target directory
if (-not (Test-Path $TargetDir)) {
    Write-Error "Target directory does not exist: $TargetDir"
    exit 1
}

# Check prerequisites
Write-Host ""
Write-Host "Checking prerequisites..." -ForegroundColor Yellow

# Check Node.js
try {
    $nodeVersion = node --version 2>$null
    Write-Host "  [OK] Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "  [WARN] Node.js not found. Please install Node.js 18+ to run the scheduler." -ForegroundColor Yellow
}

# Check Git
try {
    $gitVersion = git --version 2>$null
    Write-Host "  [OK] Git: $gitVersion" -ForegroundColor Green
} catch {
    Write-Error "Git is required but not found. Please install Git first."
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

# Clone repo to temp directory
$tempDir = Join-Path $env:TEMP "auto-dev-scheduler-$(Get-Date -Format 'yyyyMMddHHmmss')"
Write-Host ""
Write-Host "Cloning repository..." -ForegroundColor Yellow
git clone --depth 1 $RepoUrl $tempDir 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Git clone failed, falling back to direct download..." -ForegroundColor Yellow
    $useDirectDownload = $true
} else {
    Write-Host "  [OK] Repository cloned" -ForegroundColor Green
    $useDirectDownload = $false
}

if ($useDirectDownload) {
    # Fallback: download individual files
    $files = @(
        # OpenSpec core files
        @{ Remote = "openspec/AGENTS.md"; Local = "openspec/AGENTS.md" },
        @{ Remote = "openspec/project.md.template"; Local = "openspec/project.md.template" },
        @{ Remote = "openspec/execution/README.md"; Local = "openspec/execution/README.md" },
        # OpenSpec slash commands
        @{ Remote = ".claude/commands/openspec/proposal.md"; Local = ".claude/commands/openspec/proposal.md" },
        @{ Remote = ".claude/commands/openspec/apply.md"; Local = ".claude/commands/openspec/apply.md" },
        @{ Remote = ".claude/commands/openspec/archive.md"; Local = ".claude/commands/openspec/archive.md" },
        # Auto-Dev command
        @{ Remote = ".claude/commands/auto-dev.md"; Local = ".claude/commands/auto-dev.md" },
        # Documentation
        @{ Remote = "docs/CLAUDE-GUIDE.md"; Local = "docs/CLAUDE-GUIDE.md" }
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
    Write-Host "[WARN] Scheduler source not copied. Please clone the repo manually:" -ForegroundColor Yellow
    Write-Host "  git clone $RepoUrl"
    Write-Host "  Copy tools/auto-dev-scheduler-web/ to your project"
} else {
    # Copy files from cloned repo
    Write-Host ""
    Write-Host "Copying files..." -ForegroundColor Yellow

    # Copy directories
    $dirs = @(
        @{ Src = "openspec"; Dest = "openspec" },
        @{ Src = ".claude"; Dest = ".claude" },
        @{ Src = "tools/auto-dev-scheduler-web"; Dest = "tools/auto-dev-scheduler-web" },
        @{ Src = "docs"; Dest = "docs" }
    )

    foreach ($dir in $dirs) {
        $src = Join-Path $tempDir $dir.Src
        $dest = Join-Path $TargetDir $dir.Dest
        if (Test-Path $src) {
            if (-not (Test-Path $dest)) {
                Copy-Item -Path $src -Destination $dest -Recurse -Force
                Write-Host "  [OK] Copied $($dir.Src)" -ForegroundColor Green
            } else {
                # Merge: copy files that don't exist
                Get-ChildItem -Path $src -Recurse -File | ForEach-Object {
                    $relPath = $_.FullName.Substring($src.Length + 1)
                    $destFile = Join-Path $dest $relPath
                    if (-not (Test-Path $destFile)) {
                        $destDir = Split-Path -Parent $destFile
                        if (-not (Test-Path $destDir)) {
                            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
                        }
                        Copy-Item -Path $_.FullName -Destination $destFile -Force
                    }
                }
                Write-Host "  [OK] Merged $($dir.Src)" -ForegroundColor Green
            }
        }
    }

    # Cleanup temp directory
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Check if CLAUDE.md needs OpenSpec reference
$claudeMd = Join-Path $TargetDir "CLAUDE.md"
$openspecBlock = @"

<!-- OPENSPEC:START -->
# OpenSpec + Auto-Dev Instructions

These instructions are for AI assistants working in this project.

## Auto-Dev Scheduler (Multi-Claude Parallel Execution)

When user asks about Auto-Dev Scheduler usage, read ``@/docs/CLAUDE-GUIDE.md`` for:
- How to start the scheduler
- How to create AUTO-DEV.md task files
- Task ID format and dependency syntax
- Troubleshooting guide

Quick start (Electron version):
``````bash
cd tools/auto-dev-scheduler-web
npm install
npm run dev
``````

## OpenSpec (Spec-Driven Development)

Always open ``@/openspec/AGENTS.md`` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts
- Sounds ambiguous and you need the authoritative spec before coding

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
Write-Host "2. Install scheduler dependencies:"
Write-Host "   cd tools/auto-dev-scheduler-web && npm install"
Write-Host "3. Start the scheduler:"
Write-Host "   npm run dev"
Write-Host ""
