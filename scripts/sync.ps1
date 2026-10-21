#requires -Version 7.0
<#
.SYNOPSIS
    把本机正在用的 DSH 配置 / 自研插件 / MCP / 技能 / preset 同步进 dsh-vault，并可选提交推送。

.DESCRIPTION
    - 快照类：profile 配置、preset、redteam 运行配置 → vault（单向覆盖，不删除 vault 里手工新增的文件）
    - 链接类：plugins/dsh-purge、plugins/dsh-rea 是 junction，本来就在 vault 里，无需复制
    - 脱敏：password 行、*_KEY / *_TOKEN / *_SECRET 的 JSON 值替换为 ***REDACTED***
    - 提交前扫描明文密钥，命中就中止，不提交

.PARAMETER Push
    提交后推送到 origin/main。

.PARAMETER NoCommit
    只同步文件，不 git add/commit（调试用）。

.EXAMPLE
    pwsh -File scripts\sync.ps1 -Push
#>
[CmdletBinding()]
param(
    [switch]$Push,
    [switch]$NoCommit
)

$ErrorActionPreference = 'Stop'

$Vault         = Split-Path -Parent $PSScriptRoot
$UserProfileDir = $env:USERPROFILE
$Dsh           = Join-Path $UserProfileDir '.dsh'
$ProfileDir    = Join-Path $Dsh 'profiles\desktop'
$PresetsDir    = Join-Path $Dsh '.agent-presets'
$Workspace     = 'C:\Users\lt\Documents\deepseek-harness\default-workspace'
$QuantPreset   = 'C:\Users\lt\Documents\deepseek-harness\量化投资顾问\quant-advisor-preset'

$LogDir  = Join-Path $Vault 'logs'
$LogFile = Join-Path $LogDir 'sync.log'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log {
    param([string]$Message)
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8
    Write-Host $line
}

function Invoke-CopyTree {
    param(
        [string]$Source,
        [string]$Destination,
        [string[]]$ExcludeDirs = @(),
        [string[]]$ExcludeFiles = @()
    )
    if (-not (Test-Path -LiteralPath $Source)) {
        Write-Log "SKIP (missing) $Source"
        return
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $rcArgs = @($Source, $Destination, '/E', '/XJ', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    if ($ExcludeDirs.Count -gt 0)  { $rcArgs += '/XD'; $rcArgs += $ExcludeDirs }
    if ($ExcludeFiles.Count -gt 0) { $rcArgs += '/XF'; $rcArgs += $ExcludeFiles }
    robocopy @rcArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy 失败($LASTEXITCODE): $Source -> $Destination" }
    Write-Log "SYNC $Source -> $Destination"
}

function Copy-OneFile {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path -LiteralPath $Source)) {
        Write-Log "SKIP (missing) $Source"
        return
    }
    $parent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    Write-Log "COPY $Source -> $Destination"
}

# ── 脱敏 ────────────────────────────────────────────────────────────────────

function Protect-PasswordLines {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $text = Get-Content -LiteralPath $Path -Raw
    $new  = [regex]::Replace(
        $text,
        '(?m)^(\s*#?\s*password\s*:\s*)(?!\*\*\*REDACTED\*\*\*)(\S+)\s*$',
        '$1***REDACTED***'
    )
    if ($new -ne $text) {
        Set-Content -LiteralPath $Path -Value $new -NoNewline -Encoding utf8
        Write-Log "REDACT password lines: $Path"
    }
}

function Protect-JsonSecrets {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $text = Get-Content -LiteralPath $Path -Raw
    # 只脱敏真正的密钥；像 REDTEAM_VPS_KEY 这种存的是私钥路径，保留原值
    $new  = [regex]::Replace(
        $text,
        '("(?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)"\s*:\s*)"(?![A-Za-z]:\\\\|/|\$|~)(?:[^"\\]|\\.)*"',
        '$1"***REDACTED***"'
    )
    if ($new -ne $text) {
        Set-Content -LiteralPath $Path -Value $new -NoNewline -Encoding utf8
        Write-Log "REDACT json secrets: $Path"
    }
}

# ── 提交前密钥扫描 ──────────────────────────────────────────────────────────

function Assert-NoPlaintextSecrets {
    $patterns = @(
        'sk-[A-Za-z0-9_-]{24,}',
        'ghp_[A-Za-z0-9]{30,}',
        'github_pat_[A-Za-z0-9_]{30,}',
        'AKIA[0-9A-Z]{16}',
        '-----BEGIN [A-Z ]*PRIVATE KEY',
        '(?i)password\s*[:=]\s*(?!\*\*\*REDACTED)(?!\$|\{|process\.env|os\.environ)[^\s"''#]{6,}',
        '(?i)["'']?[A-Z0-9_]*(?:API|ACCESS|SECRET|PRIVATE)[A-Z0-9_]*KEY["'']?\s*[:=]\s*["'']?(?!\*\*\*REDACTED)(?!\$|\{|process\.env)[A-Za-z0-9_\-]{16,}'
    )

    $files = Get-ChildItem -LiteralPath $Vault -Recurse -File -Force |
        Where-Object { $_.FullName -notmatch '\\(\.git|logs|node_modules)\\' -and
                       $_.Extension -match '^\.(ya?ml|json|md|mjs|cjs|js|ts|ps1|sh|py|txt|env|toml|ini|cfg)$' }

    $hits = foreach ($pattern in $patterns) {
        $files | Select-String -Pattern $pattern -AllMatches -ErrorAction SilentlyContinue
    }
    # 文档里的占位符 / 示例不算密钥
    $hits = $hits |
        Where-Object { $_.Line -notmatch '\*\*\*REDACTED\*\*\*|\^PASS\^|\^USER\^|<PASSWORD>|<TOKEN>|<KEY>|placeholder|example' } |
        Sort-Object Path, LineNumber -Unique

    if ($hits) {
        $report = Join-Path $LogDir 'secret-scan.txt'
        $hits | ForEach-Object { '{0}:{1}: {2}' -f $_.Path, $_.LineNumber, $_.Line.Trim() } |
            Set-Content -LiteralPath $report -Encoding utf8
        $hits | Select-Object -First 10 | ForEach-Object {
            Write-Log ("SECRET? {0}:{1}: {2}" -f $_.Path, $_.LineNumber, $_.Line.Trim())
        }
        throw "发现疑似明文密钥，已中止提交。详见 $report"
    }
    Write-Log 'SECRET-SCAN clean'
}

# ── 同步 ────────────────────────────────────────────────────────────────────

Write-Log '=== dsh-vault sync start ==='

# 1) profile 配置（只取需要的，node_modules / market 缓存不碰）
$profileFiles = @(
    'cordis.patch.yml',
    'cordis.yml',
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    'PRESETS.md',
    'cyrene-preset-declarations.yml',
    'compatibility.json',
    '_patch-append.yml'
)
foreach ($name in $profileFiles) {
    Copy-OneFile -Source (Join-Path $ProfileDir $name) -Destination (Join-Path $Vault "config\desktop\$name")
}
Invoke-CopyTree -Source (Join-Path $ProfileDir 'patches')  -Destination (Join-Path $Vault 'config\desktop\patches') -ExcludeFiles @('*.bak', '*.bak-*')
Invoke-CopyTree -Source (Join-Path $ProfileDir 'preset-references') -Destination (Join-Path $Vault 'config\desktop\preset-references')

Protect-PasswordLines -Path (Join-Path $Vault 'config\desktop\cordis.patch.yml')

# 2) 自研插件
Invoke-CopyTree -Source (Join-Path $Dsh 'dsh-multizen-browser') `
    -Destination (Join-Path $Vault 'plugins\dsh-multizen-browser') `
    -ExcludeDirs @('node_modules', '.git') -ExcludeFiles @('*.log')

# 3) 自建 MCP
Invoke-CopyTree -Source (Join-Path $Workspace 'multizen-mcp') `
    -Destination (Join-Path $Vault 'mcp\multizen') `
    -ExcludeDirs @('node_modules', '.git') -ExcludeFiles @('*.log')

# 4) 技能
Invoke-CopyTree -Source (Join-Path $Dsh 'skills\paper-figure') `
    -Destination (Join-Path $Vault 'skills\paper-figure') `
    -ExcludeDirs @('node_modules', '.git')

# 5) preset
Invoke-CopyTree -Source (Join-Path $PresetsDir 'expert-orchestrator') `
    -Destination (Join-Path $Vault 'presets\expert-orchestrator') `
    -ExcludeDirs @('.git') -ExcludeFiles @('*.log', '*.bak', '*.bak-*')
Invoke-CopyTree -Source (Join-Path $PresetsDir 'redteam') `
    -Destination (Join-Path $Vault 'presets\redteam') `
    -ExcludeDirs @('.git') -ExcludeFiles @('*.log', '*.bak', '*.bak-*')

# 6) redteam 运行配置与知识库（技能文本已在 plugins/dsh-purge 里，这里保留运行态）
Invoke-CopyTree -Source (Join-Path $Dsh 'redteam') `
    -Destination (Join-Path $Vault 'redteam') `
    -ExcludeDirs @('.git') -ExcludeFiles @('.nuclei-index.json', '*.log', '*.bak', '*.bak-*')

Protect-JsonSecrets -Path (Join-Path $Vault 'redteam\config.json')

# 7) 全局注入与量化 preset
Copy-OneFile -Source (Join-Path $Dsh 'prompt-inject.md') -Destination (Join-Path $Vault 'prompts\prompt-inject.md')
Invoke-CopyTree -Source $QuantPreset -Destination (Join-Path $Vault 'config\quant-advisor-preset')

# 8) 不跟随 junction 把 vault 自己复制进来
Write-Log '=== sync files done ==='

if ($NoCommit) {
    Write-Log 'NoCommit: skip git'
    return
}

Assert-NoPlaintextSecrets

Push-Location $Vault
try {
    git add -A
    if ($LASTEXITCODE -ne 0) { throw 'git add 失败' }

    $staged = git diff --cached --name-only
    if (-not $staged) {
        Write-Log 'NO-CHANGES'
        return
    }

    $summary = ($staged | Measure-Object).Count
    $message = 'backup: sync {0} ({1} files)' -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $summary
    git commit -m $message | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'git commit 失败' }
    Write-Log "COMMIT $message"

    if ($Push) {
        git push origin main 2>&1 | ForEach-Object { Write-Log $_ }
        if ($LASTEXITCODE -ne 0) { throw 'git push 失败' }
        Write-Log 'PUSH ok'
    }
}
finally {
    Pop-Location
}

Write-Log '=== dsh-vault sync end ==='
