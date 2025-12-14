#Requires -Version 5.1
<#
.SYNOPSIS
    Auto-Dev Scheduler v6 - Dark Theme + DataGridView + Dock Layout
.DESCRIPTION
    Multi-Claude concurrent task scheduler with generalized task ID support.
    Supports task IDs in format: XX-YYY (e.g., GM-00, FE-01, TASK-001, BE-AUTH-01)
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# ============================================================================
# Theme Definition (VS Code Dark Style)
# ============================================================================
$script:Theme = @{
    Background    = [System.Drawing.Color]::FromArgb(45, 45, 48)
    PanelBack     = [System.Drawing.Color]::FromArgb(37, 37, 38)
    InputBack     = [System.Drawing.Color]::FromArgb(30, 30, 30)
    ForeText      = [System.Drawing.Color]::FromArgb(220, 220, 220)
    ForeTextDim   = [System.Drawing.Color]::FromArgb(150, 150, 150)
    AccentBlue    = [System.Drawing.Color]::FromArgb(0, 122, 204)
    AccentGreen   = [System.Drawing.Color]::FromArgb(60, 120, 60)
    AccentRed     = [System.Drawing.Color]::FromArgb(205, 70, 70)
    AccentOrange  = [System.Drawing.Color]::FromArgb(200, 140, 50)
    ButtonBack    = [System.Drawing.Color]::FromArgb(62, 62, 66)
    ButtonHover   = [System.Drawing.Color]::FromArgb(80, 80, 85)
    Border        = [System.Drawing.Color]::FromArgb(67, 67, 70)
    GridLine      = [System.Drawing.Color]::FromArgb(55, 55, 58)
    Selection     = [System.Drawing.Color]::FromArgb(51, 51, 52)
}

# ============================================================================
# Global State
# ============================================================================
$script:AutoDevFile = ""
$script:ProjectRoot = ""
$script:MaxParallel = 2
$script:IsRunning = $false
$script:IsPaused = $false
$script:Timer = $null
$script:Workers = @{}
$script:LogFontSize = 9
$script:LastPanelWorkerIds = ""
$script:TickInProgress = $false

# Task data parsed from file (static structure)
$script:AllTasks = @{}  # taskId -> { Id, Name, Status, Deps, Group }

# ============================================================================
# Styled Button Helper
# ============================================================================
function New-StyledButton {
    param(
        [string]$Text,
        [System.Drawing.Color]$BackColor = $script:Theme.ButtonBack,
        [System.Drawing.Color]$HoverColor = $script:Theme.ButtonHover,
        [int]$Width = 70,
        [int]$Height = 28
    )
    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = $Text
    $btn.Size = New-Object System.Drawing.Size($Width, $Height)
    $btn.FlatStyle = "Flat"
    $btn.FlatAppearance.BorderSize = 1
    $btn.FlatAppearance.BorderColor = $script:Theme.Border
    $btn.BackColor = $BackColor
    $btn.ForeColor = $script:Theme.ForeText
    $btn.Cursor = [System.Windows.Forms.Cursors]::Hand
    $btn.Font = New-Object System.Drawing.Font("Microsoft YaHei", 9)

    # Hover effects using closure
    $normalColor = $BackColor
    $hoverColorVal = $HoverColor
    $btn.Add_MouseEnter({ $this.BackColor = $hoverColorVal }.GetNewClosure())
    $btn.Add_MouseLeave({ $this.BackColor = $normalColor }.GetNewClosure())

    return $btn
}

# ============================================================================
# Parse AUTO-DEV.md directly (no Claude)
# ============================================================================
function Parse-AutoDevFile {
    param([string]$FilePath)

    if (-not (Test-Path $FilePath)) { return @{} }

    $content = Get-Content $FilePath -Raw -Encoding UTF8
    $tasks = @{}

    # Step 1: Parse wave chart to get taskId -> wave mapping
    $waveMap = @{}
    $wavePattern = '(?m)^Wave\s+(\d+):\s*(.+)$'
    $waveMatches = [regex]::Matches($content, $wavePattern)
    foreach ($wm in $waveMatches) {
        $waveNum = [int]$wm.Groups[1].Value
        $waveLine = $wm.Groups[2].Value
        # Extract task IDs from [XX-YYY ...] patterns (generalized format)
        $taskIdMatches = [regex]::Matches($waveLine, '\[([A-Z]+-[A-Z0-9-]+)')
        foreach ($tm in $taskIdMatches) {
            $tid = $tm.Groups[1].Value
            $waveMap[$tid] = $waveNum
        }
    }

    # Step 2: Parse task blocks (generalized task ID format)
    $taskPattern = '(?m)^### Task:\s+([A-Z]+-[A-Z0-9-]+)\s+(.+)$'
    $taskMatches = [regex]::Matches($content, $taskPattern)

    for ($i = 0; $i -lt $taskMatches.Count; $i++) {
        $m = $taskMatches[$i]
        $taskId = $m.Groups[1].Value
        $taskName = $m.Groups[2].Value.Trim()

        # Use next match position to delimit block
        $startIdx = $m.Index
        $nextIdx = if ($i -lt ($taskMatches.Count - 1)) { $taskMatches[$i + 1].Index } else { $content.Length }
        $block = $content.Substring($startIdx, $nextIdx - $startIdx)

        # Parse status
        $status = "idle"
        if ($block -match '\*\*状态\*\*[：:]\s*(.+?)(?=\r?\n)') {
            $statusLine = $Matches[1]
            if ($statusLine -match '已完成') { $status = "completed" }
            elseif ($statusLine -match '执行中') { $status = "running" }
            else { $status = "idle" }
        }

        # Parse dependencies (generalized format)
        $deps = @()
        if ($block -match '\*\*依赖\*\*[：:]\s*(.+?)(?=\r?\n)') {
            $depLine = $Matches[1].Trim()
            if ($depLine -ne '无' -and $depLine -ne '') {
                $deps = $depLine -split '[,，、\s]+' | Where-Object { $_ -match '^[A-Z]+-' }
            }
        }

        # Get wave from waveMap (default 99 if not found)
        $wave = if ($waveMap.ContainsKey($taskId)) { $waveMap[$taskId] } else { 99 }

        $tasks[$taskId] = @{
            Id = $taskId
            Name = $taskName
            Status = $status
            Deps = $deps
            Wave = $wave
        }
    }

    return $tasks
}

function Get-TaskGroup {
    param([hashtable]$Task, [hashtable]$AllTasks, [hashtable]$RunningWorkerIds)

    # If worker is running this task
    if ($RunningWorkerIds.ContainsKey($Task.Id)) {
        return "Running"
    }

    if ($Task.Status -eq "completed") { return "Completed" }
    if ($Task.Status -eq "running") { return "Running" }

    # Check if all deps completed
    $allDepsCompleted = $true
    foreach ($dep in $Task.Deps) {
        if ($AllTasks.ContainsKey($dep)) {
            if ($AllTasks[$dep].Status -ne "completed") {
                $allDepsCompleted = $false
                break
            }
        }
    }

    if ($allDepsCompleted) { return "Ready" }
    return "Waiting"
}

function Get-ExecutableTasks {
    param([hashtable]$AllTasks)

    $result = @()
    foreach ($task in $AllTasks.Values) {
        if ($task.Status -ne "idle") { continue }

        $allDepsCompleted = $true
        foreach ($dep in $task.Deps) {
            if ($AllTasks.ContainsKey($dep) -and $AllTasks[$dep].Status -ne "completed") {
                $allDepsCompleted = $false
                break
            }
        }

        if ($allDepsCompleted) { $result += $task.Id }
    }
    return $result
}

# ============================================================================
# Worker Management
# ============================================================================
function New-Worker {
    param([int]$WorkerIndex)
    return @{
        Index = $WorkerIndex
        Process = $null
        TaskId = ""
        State = "Idle"
        StartTime = $null
        LastEventTime = $null
        CurrentTool = ""
        ToolStartTime = $null
        TokenUsage = ""
        LogLines = [System.Collections.ArrayList]::new()
        FullLogLines = [System.Collections.ArrayList]::new()  # Full log (not truncated)
        OutputQueue = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
        StdoutEventId = ""
        StderrEventId = ""
    }
}

function Start-ClaudeWorker {
    param([hashtable]$Worker, [string]$ProjectRoot)

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = "/c chcp 65001 >nul && claude --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions"
    $psi.WorkingDirectory = $ProjectRoot
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi

    try {
        $stdoutId = "stdout-$($Worker.Index)-$(Get-Random)"
        $stderrId = "stderr-$($Worker.Index)-$(Get-Random)"
        $Worker.StdoutEventId = $stdoutId
        $Worker.StderrEventId = $stderrId

        Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -SourceIdentifier $stdoutId -MessageData $Worker -Action {
            $w = $Event.MessageData
            $data = $EventArgs.Data
            if ($null -ne $data -and $data -ne "") { $w.OutputQueue.Enqueue($data) }
        } | Out-Null

        Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -SourceIdentifier $stderrId -MessageData $Worker -Action {
            $w = $Event.MessageData
            $data = $EventArgs.Data
            if ($null -ne $data -and $data -ne "") { $w.OutputQueue.Enqueue("[stderr] $data") }
        } | Out-Null

        $process.Start() | Out-Null
        $process.BeginOutputReadLine()
        $process.BeginErrorReadLine()

        $Worker.Process = $process
        $Worker.State = "Running"
        $Worker.StartTime = Get-Date
        $Worker.LastEventTime = Get-Date

        $msg = @{ type = "user"; message = @{ role = "user"; content = "/auto-dev" } } | ConvertTo-Json -Compress
        $process.StandardInput.WriteLine($msg)
        $process.StandardInput.Flush()

        return $true
    } catch {
        try { Unregister-Event -SourceIdentifier $stdoutId -ErrorAction SilentlyContinue } catch {}
        try { Unregister-Event -SourceIdentifier $stderrId -ErrorAction SilentlyContinue } catch {}
        [void]$Worker.LogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [ERROR] $($_.Exception.Message)")
        [void]$Worker.FullLogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [ERROR] $($_.Exception.Message)")
        return $false
    }
}

function Stop-ClaudeWorker {
    param([hashtable]$Worker)
    if (-not $Worker) { return }

    if ($Worker.Process -and -not $Worker.Process.HasExited) {
        try { $Worker.Process.CancelOutputRead() } catch {}
        try { $Worker.Process.CancelErrorRead() } catch {}
    }

    if ($Worker.StdoutEventId) { try { Unregister-Event -SourceIdentifier $Worker.StdoutEventId -ErrorAction SilentlyContinue } catch {} }
    if ($Worker.StderrEventId) { try { Unregister-Event -SourceIdentifier $Worker.StderrEventId -ErrorAction SilentlyContinue } catch {} }

    if ($Worker.Process -and -not $Worker.Process.HasExited) { try { $Worker.Process.Kill() } catch {} }
    if ($Worker.Process) { try { $Worker.Process.Dispose() } catch {} }
    $Worker.Process = $null
}

# ============================================================================
# Log Parsing
# ============================================================================
function Parse-StreamJson {
    param([string]$Line, [hashtable]$Worker)

    if ([string]::IsNullOrWhiteSpace($Line)) { return $null }
    if ($Line.StartsWith("[stderr]")) { return @{ type = "stderr"; text = $Line.Substring(9) } }

    try {
        $json = $Line | ConvertFrom-Json -ErrorAction Stop
        $result = @{ type = $json.type; raw = $json }

        switch ($json.type) {
            "system" {
                if ($json.subtype -eq "init" -and $json.session_id) { $result.sessionId = $json.session_id }
            }
            "assistant" {
                if ($json.message.content) {
                    $first = $json.message.content[0]
                    if ($first.type -eq "tool_use") {
                        $result.toolName = $first.name
                        $Worker.CurrentTool = $first.name
                        $Worker.ToolStartTime = Get-Date
                        if ($first.input) {
                            $input = $first.input
                            if ($input.file_path) { $result.toolDetail = $input.file_path -replace '^.*[\\/]', '' }
                            elseif ($input.command) { $cmd = $input.command; if ($cmd.Length -gt 40) { $cmd = $cmd.Substring(0,40) + "..." }; $result.toolDetail = $cmd }
                            elseif ($input.pattern) { $result.toolDetail = "pattern: $($input.pattern)" }
                            elseif ($input.query) { $q = $input.query; if ($q.Length -gt 30) { $q = $q.Substring(0,30) + "..." }; $result.toolDetail = $q }
                            elseif ($input.PROMPT) { $p = $input.PROMPT; if ($p.Length -gt 40) { $p = $p.Substring(0,40) + "..." }; $result.toolDetail = $p }
                        }
                    } elseif ($first.type -eq "text") {
                        $result.text = $first.text
                        # Generalized task ID detection
                        if (-not $Worker.TaskId -and $first.text -match '(?i)Task\s+([A-Z]+-[A-Z0-9]+(?:-[A-Z0-9]+)*)') {
                            $Worker.TaskId = $Matches[1]
                        }
                    }
                }
                if ($json.message.usage) {
                    $total = $json.message.usage.input_tokens + $json.message.usage.output_tokens
                    if ($json.message.usage.cache_read_input_tokens) { $total += $json.message.usage.cache_read_input_tokens }
                    $Worker.TokenUsage = "$([math]::Round($total/1000,1))k"
                }
            }
            "user" {
                if ($json.message.content -and $json.message.content[0].type -eq "tool_result") {
                    $result.toolResult = $true
                    $result.isError = $json.message.content[0].is_error
                    $content = $json.message.content[0].content
                    if ($content -is [string] -and $content.Length -gt 0) {
                        $preview = $content -replace "`n", " " -replace "\s+", " "
                        if ($preview.Length -gt 50) { $preview = $preview.Substring(0,50) + "..." }
                        $result.resultPreview = $preview
                        # Detect TaskId from tool_result (e.g., git commit message)
                        if (-not $Worker.TaskId -and $content -match '(?i)Task\s+([A-Z]+-[A-Z0-9]+(?:-[A-Z0-9]+)*)') {
                            $Worker.TaskId = $Matches[1]
                        }
                    }
                    $Worker.CurrentTool = ""
                    $Worker.ToolStartTime = $null
                }
            }
            "result" {
                $result.isComplete = $true
                $result.success = ($json.subtype -eq "success")
                $result.durationMs = $json.duration_ms
            }
        }
        return $result
    } catch { return @{ type = "raw"; text = $Line } }
}

function Format-LogEntry {
    param($Parsed)
    if (-not $Parsed) { return $null }
    $ts = Get-Date -Format "HH:mm:ss"
    switch ($Parsed.type) {
        "system" { if ($Parsed.sessionId) { return "[$ts] [INIT] Session: $($Parsed.sessionId.Substring(0,8))..." } }
        "assistant" {
            if ($Parsed.toolName) {
                $name = $Parsed.toolName -replace '^mcp__', '' -replace '__', ':'
                $detail = if ($Parsed.toolDetail) { " -> $($Parsed.toolDetail)" } else { "" }
                return "[$ts] [TOOL] $name$detail"
            } elseif ($Parsed.text) {
                $text = $Parsed.text -replace "`n", " " -replace "\s+", " "
                if ($text.Length -gt 80) { $text = $text.Substring(0,80) + "..." }
                return "[$ts] [OUT] $text"
            }
        }
        "user" {
            if ($Parsed.toolResult) {
                $icon = if ($Parsed.isError) { "X" } else { "OK" }
                $preview = if ($Parsed.resultPreview) { " -> $($Parsed.resultPreview)" } else { "" }
                return "[$ts] [RES] $icon$preview"
            }
        }
        "result" {
            $icon = if ($Parsed.success) { "OK" } else { "FAIL" }
            $dur = [math]::Round($Parsed.durationMs / 1000, 1)
            return "[$ts] [DONE] $icon ${dur}s"
        }
        "stderr" { return "[$ts] [stderr] $($Parsed.text)" }
    }
    return $null
}

function Format-FullLogEntry {
    param($Parsed)
    if (-not $Parsed) { return $null }
    $ts = Get-Date -Format "HH:mm:ss"
    switch ($Parsed.type) {
        "system" { if ($Parsed.sessionId) { return "[$ts] [INIT] Session: $($Parsed.sessionId)" } }
        "assistant" {
            if ($Parsed.toolName) {
                $name = $Parsed.toolName -replace '^mcp__', '' -replace '__', ':'
                $detail = if ($Parsed.toolDetail) { " -> $($Parsed.toolDetail)" } else { "" }
                return "[$ts] [TOOL] $name$detail"
            } elseif ($Parsed.text) {
                return "[$ts] [OUT]`n$($Parsed.text)"
            }
        }
        "user" {
            if ($Parsed.toolResult) {
                $icon = if ($Parsed.isError) { "X" } else { "OK" }
                $content = if ($Parsed.raw.message.content[0].content) {
                    "`n$($Parsed.raw.message.content[0].content)"
                } else { "" }
                return "[$ts] [RES] $icon$content"
            }
        }
        "result" {
            $icon = if ($Parsed.success) { "OK" } else { "FAIL" }
            $dur = [math]::Round($Parsed.durationMs / 1000, 1)
            return "[$ts] [DONE] $icon ${dur}s"
        }
        "stderr" { return "[$ts] [stderr] $($Parsed.text)" }
    }
    return $null
}

function Show-FullLogWindow {
    param([int]$WorkerIndex)

    if (-not $script:Workers.ContainsKey($WorkerIndex)) { return }
    $worker = $script:Workers[$WorkerIndex]
    $taskId = if ($worker.TaskId) { $worker.TaskId } else { "Worker $WorkerIndex" }

    $logForm = New-Object System.Windows.Forms.Form
    $logForm.Text = "Full Log - $taskId"
    $logForm.Size = New-Object System.Drawing.Size(900, 600)
    $logForm.StartPosition = "CenterParent"
    $logForm.BackColor = $script:Theme.Background
    $logForm.ForeColor = $script:Theme.ForeText
    $logForm.MinimumSize = New-Object System.Drawing.Size(600, 400)

    $txtLog = New-Object System.Windows.Forms.TextBox
    $txtLog.Dock = "Fill"
    $txtLog.Multiline = $true
    $txtLog.ScrollBars = "Both"
    $txtLog.ReadOnly = $true
    $txtLog.BackColor = $script:Theme.InputBack
    $txtLog.ForeColor = $script:Theme.ForeText
    $txtLog.Font = New-Object System.Drawing.Font("Consolas", 10)
    $txtLog.WordWrap = $false
    $txtLog.Text = ($worker.FullLogLines -join "`r`n`r`n")

    $btnPanel = New-Object System.Windows.Forms.Panel
    $btnPanel.Height = 40
    $btnPanel.Dock = "Bottom"
    $btnPanel.BackColor = $script:Theme.PanelBack

    $btnClose = New-StyledButton -Text "Close" -Width 80 -Height 30
    $btnClose.Location = New-Object System.Drawing.Point(10, 5)
    $btnClose.Add_Click({ $this.FindForm().Close() })
    $btnPanel.Controls.Add($btnClose)

    $btnCopy = New-StyledButton -Text "Copy All" -Width 80 -Height 30
    $btnCopy.Location = New-Object System.Drawing.Point(100, 5)
    $btnCopy.Add_Click({
        $form = $this.FindForm()
        $textBox = $form.Controls | Where-Object { $_ -is [System.Windows.Forms.TextBox] } | Select-Object -First 1
        if ($textBox -and $textBox.Text) {
            [System.Windows.Forms.Clipboard]::SetText($textBox.Text)
            [System.Windows.Forms.MessageBox]::Show("Copied to clipboard", "Info", "OK", "Information")
        }
    })
    $btnPanel.Controls.Add($btnCopy)

    $logForm.Controls.Add($txtLog)
    $logForm.Controls.Add($btnPanel)

    $txtLog.SelectionStart = $txtLog.Text.Length
    $txtLog.ScrollToCaret()

    [void]$logForm.ShowDialog($script:Form)
}

# ============================================================================
# GUI Components
# ============================================================================
$script:Form = $null
$script:StatusLabel = $null
$script:ProgressLabel = $null
$script:ProgressBar = $null
$script:TaskGrid = $null
$script:LogPanels = @{}
$script:LogContainer = $null

function Update-Progress {
    if (-not $script:ProgressLabel -or -not $script:ProgressBar) { return }
    $completed = @($script:AllTasks.Values | Where-Object { $_.Status -eq "completed" }).Count
    $total = $script:AllTasks.Count
    $script:ProgressLabel.Text = "Progress: $completed / $total"
    $script:ProgressBar.Maximum = [Math]::Max(1, $total)
    $script:ProgressBar.Value = [Math]::Min($completed, $total)
}

function Update-TaskGrid {
    if (-not $script:TaskGrid) { return }
    if (-not $script:AllTasks -or $script:AllTasks.Count -eq 0) {
        if ($script:TaskGrid.Rows.Count -gt 0) { $script:TaskGrid.Rows.Clear() }
        return
    }


    # Get running worker task IDs with duration
    $runningWorkerIds = @{}
    foreach ($w in $script:Workers.Values) {
        if ($w.State -eq "Running") {
            $tid = if ($w.TaskId) { [string]$w.TaskId } else { "Worker$($w.Index)" }
            $duration = ""
            if ($w.StartTime) {
                $elapsed = (Get-Date) - $w.StartTime
                $duration = "{0:mm}:{0:ss}" -f $elapsed
            }
            $runningWorkerIds[$tid] = $duration
        }
    }

    $script:TaskGrid.SuspendLayout()
    try {
        # Build lookup of existing rows (cast to string for reliable lookup)
        $existingRows = @{}
        foreach ($row in $script:TaskGrid.Rows) {
            if ($row.Cells[1].Value) { $existingRows[[string]$row.Cells[1].Value] = $row }
        }

        # Sort tasks by Wave, then by Id
        $sortedTasks = @($script:AllTasks.Values | Sort-Object { $_.Wave }, { $_.Id })

        foreach ($task in $sortedTasks) {
            try {
                $taskId = [string]$task.Id
                $group = Get-TaskGroup -Task $task -AllTasks $script:AllTasks -RunningWorkerIds $runningWorkerIds

                # Status with icon (Default to prevent null)
                $statusInfo = switch ($group) {
                    "Running"   { @{ Text = "* Running"; Color = $script:Theme.AccentOrange } }
                    "Completed" { @{ Text = "OK Done"; Color = $script:Theme.AccentGreen } }
                    "Ready"     { @{ Text = "o Ready"; Color = $script:Theme.AccentBlue } }
                    "Waiting"   { @{ Text = "- Waiting"; Color = $script:Theme.ForeTextDim } }
                    Default     { @{ Text = "? Unknown"; Color = [System.Drawing.Color]::Gray } }
                }

                $duration = if ($runningWorkerIds.ContainsKey($taskId)) { $runningWorkerIds[$taskId] } else { "" }
                $waveText = "W$($task.Wave)"

                if ($existingRows.ContainsKey($taskId)) {
                    # Update existing row
                    $row = $existingRows[$taskId]
                    if ($row.Cells[0].Value -ne $statusInfo.Text) {
                        $row.Cells[0].Value = $statusInfo.Text
                        $row.Cells[0].Style.ForeColor = $statusInfo.Color
                    }
                    if ($row.Cells[2].Value -ne $waveText) { $row.Cells[2].Value = $waveText }
                    if ($row.Cells[3].Value -ne $duration) { $row.Cells[3].Value = $duration }
                    $existingRows.Remove($taskId)
                } else {
                    # Add new row
                    $rowIdx = $script:TaskGrid.Rows.Add($statusInfo.Text, $taskId, $waveText, $duration)
                    $script:TaskGrid.Rows[$rowIdx].Cells[0].Style.ForeColor = $statusInfo.Color
                }
            } catch {
                # Single row error should not break entire update
            }
        }

        # Remove rows that no longer exist
        foreach ($row in $existingRows.Values) {
            $script:TaskGrid.Rows.Remove($row)
        }
    } finally {
        $script:TaskGrid.ResumeLayout()
    }
}

function Create-LogPanel {
    param([int]$WorkerIndex, [int]$PanelIndex, [int]$TotalCols)

    # Layout constants
    $margin = 3
    $gap = 4
    $headerHeight = 24
    $inputHeight = 26
    $btnWidth = 50

    $w = [math]::Floor(($script:LogContainer.Width - 15) / $TotalCols) - 5
    $h = $script:LogContainer.Height - 10

    $panel = New-Object System.Windows.Forms.Panel
    $panel.Location = New-Object System.Drawing.Point(($PanelIndex * ($w + 5) + 5), 5)
    $panel.Size = New-Object System.Drawing.Size($w, $h)
    $panel.BorderStyle = "FixedSingle"
    $panel.BackColor = [System.Drawing.Color]::FromArgb(40, 40, 40)

    # Header label
    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Text = "Worker $WorkerIndex"
    $lbl.Location = New-Object System.Drawing.Point($margin, 2)
    $lbl.Size = New-Object System.Drawing.Size(($w - 50), 20)
    $lbl.ForeColor = [System.Drawing.Color]::LightGreen
    $lbl.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
    $lbl.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right
    $panel.Controls.Add($lbl)

    # Kill button
    $killBtn = New-Object System.Windows.Forms.Button
    $killBtn.Text = "Kill"
    $killBtn.Location = New-Object System.Drawing.Point(($w - 45), 1)
    $killBtn.Size = New-Object System.Drawing.Size(40, 20)
    $killBtn.BackColor = [System.Drawing.Color]::IndianRed
    $killBtn.ForeColor = [System.Drawing.Color]::White
    $killBtn.FlatStyle = "Flat"
    $killBtn.FlatAppearance.BorderSize = 0
    $killBtn.Cursor = [System.Windows.Forms.Cursors]::Hand
    $killBtn.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Right
    $killBtn.Tag = $WorkerIndex
    $killBtn.Add_Click({
        $wIdx = $this.Tag
        if ($script:Workers.ContainsKey($wIdx)) {
            Stop-ClaudeWorker -Worker $script:Workers[$wIdx]
            $script:Workers[$wIdx].State = "Failed"
            [void]$script:Workers[$wIdx].LogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [SYS] Terminated")
            [void]$script:Workers[$wIdx].FullLogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [SYS] Terminated")
        }
    })
    $panel.Controls.Add($killBtn)

    # Log display area (Anchor all sides for auto-resize)
    $txt = New-Object System.Windows.Forms.TextBox
    $txt.Location = New-Object System.Drawing.Point($margin, $headerHeight)
    $txt.Size = New-Object System.Drawing.Size(($w - $margin * 2), ($h - $headerHeight - $inputHeight - $gap))
    $txt.Multiline = $true
    $txt.ScrollBars = "Vertical"
    $txt.ReadOnly = $true
    $txt.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
    $txt.ForeColor = [System.Drawing.Color]::FromArgb(200, 200, 200)
    $txt.Font = New-Object System.Drawing.Font("Consolas", $script:LogFontSize)
    $txt.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right
    # Double-click to open full log
    $txt.Tag = $WorkerIndex
    $txt.Add_DoubleClick({
        $wIdx = $this.Tag
        Show-FullLogWindow -WorkerIndex $wIdx
    }.GetNewClosure())
    # Add Tooltip hint
    $tooltip = New-Object System.Windows.Forms.ToolTip
    $tooltip.SetToolTip($txt, "Double-click to view full log")
    $panel.Controls.Add($txt)

    # Send button (create first so input box can reference it)
    $sendBtn = New-Object System.Windows.Forms.Button
    $sendBtn.Text = "Send"
    $sendBtn.Location = New-Object System.Drawing.Point(($w - $margin - $btnWidth), ($h - $inputHeight))
    $sendBtn.Size = New-Object System.Drawing.Size($btnWidth, ($inputHeight - 4))
    $sendBtn.BackColor = [System.Drawing.Color]::FromArgb(60, 120, 60)
    $sendBtn.ForeColor = [System.Drawing.Color]::White
    $sendBtn.FlatStyle = "Flat"
    $sendBtn.FlatAppearance.BorderSize = 0
    $sendBtn.Cursor = [System.Windows.Forms.Cursors]::Hand
    $sendBtn.Font = New-Object System.Drawing.Font("Microsoft YaHei", 9)
    $sendBtn.Anchor = [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Right

    # Input box
    $inputBox = New-Object System.Windows.Forms.TextBox
    $inputBox.Location = New-Object System.Drawing.Point($margin, ($h - $inputHeight))
    $inputBox.Size = New-Object System.Drawing.Size(($w - $margin * 2 - $btnWidth - $gap), ($inputHeight - 4))
    $inputBox.BackColor = [System.Drawing.Color]::FromArgb(50, 50, 50)
    $inputBox.ForeColor = [System.Drawing.Color]::White
    $inputBox.Font = New-Object System.Drawing.Font("Consolas", 9)
    $inputBox.Anchor = [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right

    # Send button click event
    $sendBtn.Tag = @{ WorkerIndex = $WorkerIndex; InputBox = $inputBox }
    $sendBtn.Add_Click({
        $data = $this.Tag
        $wIdx = $data.WorkerIndex
        $input = $data.InputBox
        $msg = $input.Text.Trim()
        if (-not $msg) { return }
        if (-not $script:Workers.ContainsKey($wIdx)) {
            [System.Windows.Forms.MessageBox]::Show("Worker does not exist", "Error", "OK", "Warning")
            return
        }
        $worker = $script:Workers[$wIdx]
        if (-not $worker.Process -or $worker.Process.HasExited) {
            [void]$worker.LogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [SYS] Process exited, cannot send")
            [void]$worker.FullLogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [SYS] Process exited, cannot send")
            return
        }
        try {
            $jsonMsg = @{ type = "user"; message = @{ role = "user"; content = $msg } } | ConvertTo-Json -Compress
            $worker.Process.StandardInput.WriteLine($jsonMsg)
            $worker.Process.StandardInput.Flush()
            [void]$worker.LogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [USER] $msg")
            [void]$worker.FullLogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [USER] $msg")
            $input.Text = ""
        } catch {
            [void]$worker.LogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [ERROR] Send failed: $($_.Exception.Message)")
            [void]$worker.FullLogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [ERROR] Send failed: $($_.Exception.Message)")
        }
    })

    # Enter key to send (directly reference button to avoid text search)
    $inputBox.Tag = $sendBtn
    $inputBox.Add_KeyDown({
        if ($_.KeyCode -eq [System.Windows.Forms.Keys]::Enter) {
            $_.SuppressKeyPress = $true
            $btn = $this.Tag
            if ($btn) { $btn.PerformClick() }
        }
    })

    $panel.Controls.Add($inputBox)
    $panel.Controls.Add($sendBtn)

    $script:LogContainer.Controls.Add($panel)
    $script:LogPanels[$WorkerIndex] = @{ Panel = $panel; TextBox = $txt; Header = $lbl; InputBox = $inputBox; SendBtn = $sendBtn }
}

$script:EmptyLabel = $null

function Rebuild-LogPanels {
    $activeWorkers = @($script:Workers.Keys | Where-Object { $script:Workers[$_].State -eq "Running" } | Sort-Object)
    $currentIds = $activeWorkers -join ","

    if ($currentIds -eq $script:LastPanelWorkerIds) { return }
    $script:LastPanelWorkerIds = $currentIds

    $script:LogContainer.Controls.Clear()
    $script:LogPanels.Clear()

    if ($activeWorkers.Count -eq 0) {
        if (-not $script:EmptyLabel) {
            $script:EmptyLabel = New-Object System.Windows.Forms.Label
            $script:EmptyLabel.TextAlign = "MiddleCenter"
            $script:EmptyLabel.ForeColor = [System.Drawing.Color]::Gray
            $script:EmptyLabel.Font = New-Object System.Drawing.Font("Segoe UI", 10)
        }
        $script:EmptyLabel.Size = $script:LogContainer.Size
        $script:EmptyLabel.Location = New-Object System.Drawing.Point(0, 0)
        $script:EmptyLabel.Text = "No running tasks"
        $script:LogContainer.Controls.Add($script:EmptyLabel)
        return
    }

    $cols = [Math]::Min($activeWorkers.Count, $script:MaxParallel)
    for ($i = 0; $i -lt $activeWorkers.Count; $i++) {
        Create-LogPanel -WorkerIndex $activeWorkers[$i] -PanelIndex $i -TotalCols $cols
    }
}

function Update-LogPanels {
    foreach ($wIdx in $script:LogPanels.Keys) {
        if (-not $script:Workers.ContainsKey($wIdx)) { continue }

        $worker = $script:Workers[$wIdx]
        $panel = $script:LogPanels[$wIdx]

        # Efficient log update: append only new lines instead of replacing all
        $currentLineCount = $panel.TextBox.Lines.Count
        $targetLineCount = $worker.LogLines.Count

        if ($targetLineCount -gt $currentLineCount) {
            # Append new lines
            $newLines = $worker.LogLines.GetRange($currentLineCount, $targetLineCount - $currentLineCount)
            $newText = ($newLines -join "`r`n")
            if ($currentLineCount -gt 0) { $newText = "`r`n" + $newText }
            $panel.TextBox.AppendText($newText)
        } elseif ($targetLineCount -lt $currentLineCount -or $currentLineCount -eq 0) {
            # Log was truncated or first load, full replace
            $panel.TextBox.Text = $worker.LogLines -join "`r`n"
            $panel.TextBox.SelectionStart = $panel.TextBox.Text.Length
            $panel.TextBox.ScrollToCaret()
        }

        # Limit log lines (performance optimization)
        if ($panel.TextBox.Lines.Count -gt 500) {
            $lines = $panel.TextBox.Lines
            $panel.TextBox.Text = ($lines[100..($lines.Count-1)]) -join "`r`n"
            $panel.TextBox.SelectionStart = $panel.TextBox.Text.Length
            $panel.TextBox.ScrollToCaret()
        }

        $taskId = if ($worker.TaskId) { $worker.TaskId } else { "Worker $wIdx" }
        $token = if ($worker.TokenUsage) { " [$($worker.TokenUsage)]" } else { "" }
        $tool = if ($worker.CurrentTool) { " ..." + ($worker.CurrentTool -replace '^mcp__', '') } else { "" }
        $panel.Header.Text = "$taskId$token$tool"
    }
}

# ============================================================================
# Main Scheduler Logic
# ============================================================================
function Invoke-SchedulerTick {
    if (-not $script:IsRunning) { return }

    # Prevent re-entry: if previous tick not completed, skip
    if ($script:TickInProgress) { return }
    $script:TickInProgress = $true

    try {
        # Re-parse file to get latest status
        $script:AllTasks = Parse-AutoDevFile -FilePath $script:AutoDevFile

        $completedWorkers = @()
        foreach ($wIdx in @($script:Workers.Keys)) {
            $worker = $script:Workers[$wIdx]
            if ($worker.State -ne "Running") { continue }
            if (-not $worker.Process) { continue }

            $line = $null
            while ($worker.OutputQueue.TryDequeue([ref]$line)) {
                $worker.LastEventTime = Get-Date
                $parsed = Parse-StreamJson -Line $line -Worker $worker
                $logEntry = Format-LogEntry -Parsed $parsed
                $fullLogEntry = Format-FullLogEntry -Parsed $parsed

                if ($logEntry) {
                    [void]$worker.LogLines.Add($logEntry)
                    while ($worker.LogLines.Count -gt 300) { $worker.LogLines.RemoveAt(0) }
                }
                if ($fullLogEntry) {
                    [void]$worker.FullLogLines.Add($fullLogEntry)
                }

                if ($parsed -and $parsed.isComplete) {
                    [void]$worker.LogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [SYS] Task completed")
                    [void]$worker.FullLogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [SYS] Task completed")
                    $worker.State = if ($parsed.success) { "Completed" } else { "Failed" }
                    Stop-ClaudeWorker -Worker $worker
                    $completedWorkers += $wIdx
                    break
                }
            }

            if ($worker.Process -and $worker.Process.HasExited -and $worker.State -eq "Running") {
                [void]$worker.LogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [SYS] Process exited")
                [void]$worker.FullLogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [SYS] Process exited")
                $worker.State = "Completed"
                Stop-ClaudeWorker -Worker $worker
                $completedWorkers += $wIdx
            }
        }

        if ($completedWorkers.Count -gt 0) {
            $script:LastPanelWorkerIds = ""
            Rebuild-LogPanels
        }

        Update-LogPanels
        Update-Progress
        Update-TaskGrid

        # Check completion
        $completedCount = @($script:AllTasks.Values | Where-Object { $_.Status -eq "completed" }).Count
        if ($completedCount -eq $script:AllTasks.Count -and $script:AllTasks.Count -gt 0) {
            $script:StatusLabel.Text = "All tasks completed!"
            $script:StatusLabel.ForeColor = $script:Theme.AccentGreen
            [console]::beep(800, 200)
            [console]::beep(1000, 200)
            [console]::beep(1200, 400)
            return
        }

        # Start new workers if slots available
        if (-not $script:IsPaused) {
            $runningCount = @($script:Workers.Values | Where-Object { $_.State -eq "Running" }).Count
            $slots = $script:MaxParallel - $runningCount
            $execTasks = Get-ExecutableTasks -AllTasks $script:AllTasks
            # Exclude workers that are starting but haven't confirmed TaskId yet
            $pendingWorkers = @($script:Workers.Values | Where-Object { $_.State -eq "Running" -and -not $_.TaskId }).Count
            $availableExecTasks = [Math]::Max(0, $execTasks.Count - $pendingWorkers)
            $toStart = [Math]::Min([Math]::Max(0, $slots), $availableExecTasks)

            for ($i = 0; $i -lt $toStart; $i++) {
                $newIdx = 1
                while ($script:Workers.ContainsKey($newIdx) -and $script:Workers[$newIdx].State -eq "Running") { $newIdx++ }

                $worker = New-Worker -WorkerIndex $newIdx
                $script:Workers[$newIdx] = $worker
                [void]$worker.LogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [SYS] Starting...")
                [void]$worker.FullLogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [SYS] Starting...")

                if (Start-ClaudeWorker -Worker $worker -ProjectRoot $script:ProjectRoot) {
                    [void]$worker.LogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [SYS] Claude started")
                    [void]$worker.FullLogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] [SYS] Claude started")
                } else {
                    $worker.State = "Failed"
                }
            }

            if ($toStart -gt 0) {
                $script:LastPanelWorkerIds = ""
                Rebuild-LogPanels
            }
        }

        # Update status
        $runningWorkers = @($script:Workers.Values | Where-Object { $_.State -eq "Running" })
        if ($runningWorkers.Count -gt 0) {
            $ids = $runningWorkers | ForEach-Object { if ($_.TaskId) { $_.TaskId } else { "Worker$($_.Index)" } }
            $script:StatusLabel.Text = "Running: " + ($ids -join ", ")
        } elseif ($script:IsPaused) {
            $script:StatusLabel.Text = "Paused"
        } else {
            $script:StatusLabel.Text = "Ready"
        }
    } finally {
        $script:TickInProgress = $false
    }
}

# ============================================================================
# Main Form
# ============================================================================
function Show-MainForm {
    # Main form - dark theme
    $script:Form = New-Object System.Windows.Forms.Form
    $script:Form.Text = "Auto-Dev Scheduler v6"
    $script:Form.Size = New-Object System.Drawing.Size(950, 750)
    $script:Form.MinimumSize = New-Object System.Drawing.Size(800, 600)
    $script:Form.StartPosition = "CenterScreen"
    $script:Form.Font = New-Object System.Drawing.Font("Segoe UI", 9)
    $script:Form.BackColor = $script:Theme.Background
    $script:Form.ForeColor = $script:Theme.ForeText
    # Disable DPI auto-scaling to avoid Dock panel height issues
    $script:Form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None

    # Enable double buffering to reduce flicker
    $prop = $script:Form.GetType().GetProperty("DoubleBuffered", [System.Reflection.BindingFlags]"NonPublic,Instance")
    if ($prop) { $prop.SetValue($script:Form, $true, $null) }

    # ==================== Top Panel ====================
    $topPanel = New-Object System.Windows.Forms.Panel
    $topPanel.Height = 90
    $topPanel.Dock = "Top"
    $topPanel.BackColor = $script:Theme.PanelBack
    $topPanel.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 8)

    # Row 1: File selection
    $lblFile = New-Object System.Windows.Forms.Label
    $lblFile.Text = "Task File:"
    $lblFile.Location = New-Object System.Drawing.Point(10, 12)
    $lblFile.Size = New-Object System.Drawing.Size(60, 20)
    $lblFile.ForeColor = $script:Theme.ForeText
    $topPanel.Controls.Add($lblFile)

    $script:TxtFile = New-Object System.Windows.Forms.TextBox
    $script:TxtFile.Location = New-Object System.Drawing.Point(75, 10)
    $script:TxtFile.Size = New-Object System.Drawing.Size(520, 23)
    $script:TxtFile.ReadOnly = $true
    $script:TxtFile.BackColor = $script:Theme.InputBack
    $script:TxtFile.ForeColor = $script:Theme.ForeText
    $script:TxtFile.BorderStyle = "FixedSingle"
    $topPanel.Controls.Add($script:TxtFile)

    $btnBrowse = New-StyledButton -Text "Browse..." -Width 60 -Height 25
    $btnBrowse.Location = New-Object System.Drawing.Point(600, 9)
    $topPanel.Controls.Add($btnBrowse)

    $lblPar = New-Object System.Windows.Forms.Label
    $lblPar.Text = "Parallel:"
    $lblPar.Location = New-Object System.Drawing.Point(680, 12)
    $lblPar.Size = New-Object System.Drawing.Size(50, 20)
    $lblPar.ForeColor = $script:Theme.ForeText
    $topPanel.Controls.Add($lblPar)

    $cmbPar = New-Object System.Windows.Forms.ComboBox
    $cmbPar.Location = New-Object System.Drawing.Point(730, 9)
    $cmbPar.Size = New-Object System.Drawing.Size(50, 23)
    $cmbPar.DropDownStyle = "DropDownList"
    $cmbPar.BackColor = $script:Theme.InputBack
    $cmbPar.ForeColor = $script:Theme.ForeText
    $cmbPar.FlatStyle = "Flat"
    $cmbPar.Items.AddRange(@("1","2","3","4"))
    $cmbPar.SelectedIndex = 1
    $topPanel.Controls.Add($cmbPar)

    # Row 2: Control buttons
    $btnStart = New-StyledButton -Text "Start" -BackColor $script:Theme.AccentBlue -HoverColor ([System.Drawing.Color]::FromArgb(28, 151, 234))
    $btnStart.Location = New-Object System.Drawing.Point(10, 45)
    $btnStart.Enabled = $false
    $topPanel.Controls.Add($btnStart)

    $btnPause = New-StyledButton -Text "Pause"
    $btnPause.Location = New-Object System.Drawing.Point(85, 45)
    $btnPause.Enabled = $false
    $topPanel.Controls.Add($btnPause)

    $btnStop = New-StyledButton -Text "Stop All" -BackColor $script:Theme.AccentRed -HoverColor ([System.Drawing.Color]::FromArgb(230, 90, 90))
    $btnStop.Location = New-Object System.Drawing.Point(160, 45)
    $btnStop.Enabled = $false
    $topPanel.Controls.Add($btnStop)

    $btnExport = New-StyledButton -Text "Export Log" -Width 75
    $btnExport.Location = New-Object System.Drawing.Point(250, 45)
    $topPanel.Controls.Add($btnExport)

    # Font control
    $lblFont = New-Object System.Windows.Forms.Label
    $lblFont.Text = "Font:"
    $lblFont.Location = New-Object System.Drawing.Point(345, 50)
    $lblFont.Size = New-Object System.Drawing.Size(35, 20)
    $lblFont.ForeColor = $script:Theme.ForeTextDim
    $topPanel.Controls.Add($lblFont)

    $btnFontMinus = New-StyledButton -Text "-" -Width 28 -Height 25
    $btnFontMinus.Location = New-Object System.Drawing.Point(380, 45)
    $topPanel.Controls.Add($btnFontMinus)

    $script:FontSizeLabel = New-Object System.Windows.Forms.Label
    $script:FontSizeLabel.Text = "$($script:LogFontSize)"
    $script:FontSizeLabel.Location = New-Object System.Drawing.Point(410, 50)
    $script:FontSizeLabel.Size = New-Object System.Drawing.Size(25, 20)
    $script:FontSizeLabel.TextAlign = "MiddleCenter"
    $script:FontSizeLabel.ForeColor = $script:Theme.ForeText
    $topPanel.Controls.Add($script:FontSizeLabel)

    $btnFontPlus = New-StyledButton -Text "+" -Width 28 -Height 25
    $btnFontPlus.Location = New-Object System.Drawing.Point(435, 45)
    $topPanel.Controls.Add($btnFontPlus)

    # Progress label
    $script:ProgressLabel = New-Object System.Windows.Forms.Label
    $script:ProgressLabel.Text = "Progress: 0 / 0"
    $script:ProgressLabel.Location = New-Object System.Drawing.Point(500, 50)
    $script:ProgressLabel.Size = New-Object System.Drawing.Size(90, 20)
    $script:ProgressLabel.ForeColor = $script:Theme.ForeText
    $topPanel.Controls.Add($script:ProgressLabel)

    $script:ProgressBar = New-Object System.Windows.Forms.ProgressBar
    $script:ProgressBar.Location = New-Object System.Drawing.Point(590, 48)
    $script:ProgressBar.Size = New-Object System.Drawing.Size(200, 18)
    $script:ProgressBar.Style = "Continuous"
    $topPanel.Controls.Add($script:ProgressBar)

    # ==================== Status Bar ====================
    $statusPanel = New-Object System.Windows.Forms.Panel
    $statusPanel.Height = 28
    $statusPanel.Dock = "Top"
    $statusPanel.BackColor = $script:Theme.Background
    $statusPanel.Padding = New-Object System.Windows.Forms.Padding(10, 4, 10, 4)

    $script:StatusLabel = New-Object System.Windows.Forms.Label
    $script:StatusLabel.Text = "Please select a task file..."
    $script:StatusLabel.Dock = "Fill"
    $script:StatusLabel.ForeColor = $script:Theme.ForeTextDim
    $statusPanel.Controls.Add($script:StatusLabel)

    # ==================== Task Label ====================
    $taskLabelPanel = New-Object System.Windows.Forms.Panel
    $taskLabelPanel.Height = 22
    $taskLabelPanel.Dock = "Top"
    $taskLabelPanel.BackColor = $script:Theme.Background

    $lblTasks = New-Object System.Windows.Forms.Label
    $lblTasks.Text = "Task Status"
    $lblTasks.Dock = "Fill"
    $lblTasks.ForeColor = $script:Theme.ForeTextDim
    $lblTasks.Padding = New-Object System.Windows.Forms.Padding(10, 4, 0, 0)
    $taskLabelPanel.Controls.Add($lblTasks)

    # ==================== Log Label ====================
    $logLabelPanel = New-Object System.Windows.Forms.Panel
    $logLabelPanel.Height = 20
    $logLabelPanel.Dock = "Bottom"
    $logLabelPanel.BackColor = $script:Theme.Background

    $lblLog = New-Object System.Windows.Forms.Label
    $lblLog.Text = "Live Log"
    $lblLog.Dock = "Fill"
    $lblLog.ForeColor = $script:Theme.ForeTextDim
    $lblLog.Padding = New-Object System.Windows.Forms.Padding(10, 2, 0, 0)
    $logLabelPanel.Controls.Add($lblLog)

    # ==================== Bottom Log Container ====================
    $script:LogContainer = New-Object System.Windows.Forms.Panel
    $script:LogContainer.Height = 260
    $script:LogContainer.Dock = "Bottom"
    $script:LogContainer.BackColor = $script:Theme.InputBack
    $script:LogContainer.Padding = New-Object System.Windows.Forms.Padding(5)

    # DataGridView replaces ListView
    $script:TaskGrid = New-Object System.Windows.Forms.DataGridView
    $script:TaskGrid.Dock = "Fill"
    $script:TaskGrid.BackgroundColor = $script:Theme.PanelBack
    $script:TaskGrid.BorderStyle = "None"
    $script:TaskGrid.GridColor = $script:Theme.GridLine
    $script:TaskGrid.RowHeadersVisible = $false
    $script:TaskGrid.AllowUserToAddRows = $false
    $script:TaskGrid.AllowUserToDeleteRows = $false
    $script:TaskGrid.AllowUserToResizeRows = $false
    $script:TaskGrid.ReadOnly = $true
    $script:TaskGrid.SelectionMode = "FullRowSelect"
    $script:TaskGrid.MultiSelect = $false
    $script:TaskGrid.EnableHeadersVisualStyles = $false
    $script:TaskGrid.CellBorderStyle = "SingleHorizontal"
    $script:TaskGrid.RowTemplate.Height = 28

    # Enable double buffering
    $prop = $script:TaskGrid.GetType().GetProperty("DoubleBuffered", [System.Reflection.BindingFlags]"NonPublic,Instance")
    if ($prop) { $prop.SetValue($script:TaskGrid, $true, $null) }

    # Header style
    $script:TaskGrid.ColumnHeadersDefaultCellStyle.BackColor = $script:Theme.InputBack
    $script:TaskGrid.ColumnHeadersDefaultCellStyle.ForeColor = $script:Theme.ForeText
    $script:TaskGrid.ColumnHeadersDefaultCellStyle.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
    $script:TaskGrid.ColumnHeadersDefaultCellStyle.SelectionBackColor = $script:Theme.InputBack
    $script:TaskGrid.ColumnHeadersDefaultCellStyle.Padding = New-Object System.Windows.Forms.Padding(5, 0, 0, 0)
    $script:TaskGrid.ColumnHeadersHeight = 32
    $script:TaskGrid.ColumnHeadersBorderStyle = "Single"

    # Row style
    $script:TaskGrid.DefaultCellStyle.BackColor = $script:Theme.PanelBack
    $script:TaskGrid.DefaultCellStyle.ForeColor = $script:Theme.ForeText
    $script:TaskGrid.DefaultCellStyle.SelectionBackColor = $script:Theme.Selection
    $script:TaskGrid.DefaultCellStyle.SelectionForeColor = $script:Theme.ForeText
    $script:TaskGrid.DefaultCellStyle.Padding = New-Object System.Windows.Forms.Padding(5, 0, 0, 0)

    # Alternating row color
    $script:TaskGrid.AlternatingRowsDefaultCellStyle.BackColor = $script:Theme.Background

    # Add columns
    [void]$script:TaskGrid.Columns.Add("Status", "Status")
    [void]$script:TaskGrid.Columns.Add("TaskId", "Task ID")
    [void]$script:TaskGrid.Columns.Add("Wave", "Wave")
    [void]$script:TaskGrid.Columns.Add("Duration", "Duration")

    $script:TaskGrid.Columns["Status"].Width = 90
    $script:TaskGrid.Columns["TaskId"].Width = 150
    $script:TaskGrid.Columns["TaskId"].AutoSizeMode = "Fill"
    $script:TaskGrid.Columns["Wave"].Width = 60
    $script:TaskGrid.Columns["Duration"].Width = 80

    # ==================== Add controls in correct order ====================
    # WinForms Dock calculates in reverse order, put Fill first then Bottom/Top
    $script:Form.Controls.Add($script:TaskGrid)      # Dock=Fill (add first)
    $script:Form.Controls.Add($script:LogContainer)  # Dock=Bottom
    $script:Form.Controls.Add($logLabelPanel)        # Dock=Bottom
    $script:Form.Controls.Add($taskLabelPanel)       # Dock=Top
    $script:Form.Controls.Add($statusPanel)          # Dock=Top
    $script:Form.Controls.Add($topPanel)             # Dock=Top

    # ==================== Event Handlers ====================
    $btnBrowse.Add_Click({
        $dlg = New-Object System.Windows.Forms.OpenFileDialog
        $dlg.Filter = "AUTO-DEV.md|AUTO-DEV.md|All|*.*"
        if ($dlg.ShowDialog() -eq "OK") {
            $script:TxtFile.Text = $dlg.FileName
            $script:AutoDevFile = $dlg.FileName
            $script:ProjectRoot = (Get-Item $dlg.FileName).Directory.Parent.Parent.Parent.FullName

            $script:AllTasks = Parse-AutoDevFile -FilePath $dlg.FileName
            Update-Progress
            Update-TaskGrid

            $btnStart.Enabled = $true
            $script:StatusLabel.Text = "Loaded $($script:AllTasks.Count) tasks, click Start"
            $script:StatusLabel.ForeColor = $script:Theme.ForeText
        }
    })

    $btnStart.Add_Click({
        $script:MaxParallel = [int]$cmbPar.SelectedItem
        $script:IsRunning = $true
        $script:IsPaused = $false
        $script:TickInProgress = $false
        $script:Workers.Clear()
        $script:LastPanelWorkerIds = ""
        $btnStart.Enabled = $false
        $btnPause.Enabled = $true
        $btnStop.Enabled = $true
        $btnBrowse.Enabled = $false
        $cmbPar.Enabled = $false

        $script:StatusLabel.Text = "Starting..."
        $script:StatusLabel.ForeColor = $script:Theme.AccentBlue

        $script:Timer = New-Object System.Windows.Forms.Timer
        $script:Timer.Interval = 500
        $script:Timer.Add_Tick({
            try { Invoke-SchedulerTick }
            catch { $script:StatusLabel.Text = "Error: $($_.Exception.Message)"; $script:StatusLabel.ForeColor = $script:Theme.AccentRed }
        })
        $script:Timer.Start()
    })

    $btnPause.Add_Click({
        $script:IsPaused = -not $script:IsPaused
        $btnPause.Text = if ($script:IsPaused) { "Resume" } else { "Pause" }
        $script:StatusLabel.ForeColor = if ($script:IsPaused) { $script:Theme.AccentOrange } else { $script:Theme.ForeText }
    })

    $btnStop.Add_Click({
        $script:IsRunning = $false
        if ($script:Timer) { $script:Timer.Stop() }
        foreach ($wIdx in @($script:Workers.Keys)) { Stop-ClaudeWorker -Worker $script:Workers[$wIdx] }
        $btnStart.Enabled = $true
        $btnPause.Enabled = $false
        $btnStop.Enabled = $false
        $btnBrowse.Enabled = $true
        $cmbPar.Enabled = $true
        $btnPause.Text = "Pause"
        $script:StatusLabel.Text = "Stopped"
        $script:StatusLabel.ForeColor = $script:Theme.ForeTextDim
    })

    $btnFontMinus.Add_Click({
        if ($script:LogFontSize -gt 6) {
            $script:LogFontSize--
            $script:FontSizeLabel.Text = "$($script:LogFontSize)"
            foreach ($p in $script:LogPanels.Values) { $p.TextBox.Font = New-Object System.Drawing.Font("Consolas", $script:LogFontSize) }
        }
    })

    $btnFontPlus.Add_Click({
        if ($script:LogFontSize -lt 16) {
            $script:LogFontSize++
            $script:FontSizeLabel.Text = "$($script:LogFontSize)"
            foreach ($p in $script:LogPanels.Values) { $p.TextBox.Font = New-Object System.Drawing.Font("Consolas", $script:LogFontSize) }
        }
    })

    $btnExport.Add_Click({
        $dlg = New-Object System.Windows.Forms.SaveFileDialog
        $dlg.Filter = "Log|*.log"
        $dlg.FileName = "auto-dev-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
        if ($dlg.ShowDialog() -eq "OK") {
            $content = ""
            foreach ($wIdx in $script:Workers.Keys) {
                $w = $script:Workers[$wIdx]
                $taskId = if ($w.TaskId) { $w.TaskId } else { "Worker$wIdx" }
                $content += "=== $taskId ===`r`n"
                $content += ($w.LogLines -join "`r`n")
                $content += "`r`n`r`n"
            }
            $content | Out-File $dlg.FileName -Encoding UTF8
            [System.Windows.Forms.MessageBox]::Show("Exported", "Info", "OK", "Information")
        }
    })

    $script:Form.Add_FormClosing({
        $script:IsRunning = $false
        if ($script:Timer) { $script:Timer.Stop() }
        foreach ($wIdx in @($script:Workers.Keys)) { Stop-ClaudeWorker -Worker $script:Workers[$wIdx] }
    })

    [void]$script:Form.ShowDialog()
}

Show-MainForm
