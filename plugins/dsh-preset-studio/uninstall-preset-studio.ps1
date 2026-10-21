# 卸载 dsh-preset-studio 并清理它在 profile 里留下的痕迹。
#
# 用法：
#   .\uninstall-preset-studio.ps1              # 卸包 + 清 profile patch 行，保留你的模块数据
#   .\uninstall-preset-studio.ps1 -PurgeData   # 上面这些 + 删除 ~/.dsh/preset-studio（模块、检测记录、skill 开关）
#   .\uninstall-preset-studio.ps1 -DryRun      # 只看会改什么，不落盘

param(
  [switch]$PurgeData,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\desktop'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$studioDir = Join-Path $dshHome 'preset-studio'
$exe = 'C:\Program Files\DSH Desktop\DSH Desktop.exe'
$cli = 'C:\Program Files\DSH Desktop\resources\app\lib\desktop-cli.js'

function Say($text) { Write-Host $text }

Say "DSH_HOME = $dshHome"
Say "profile   = $profileDir"

# 1) 从 profile 移除包（dependencies + bundles 一起）
$pkgJson = Join-Path $profileDir 'package.json'
if (Test-Path $pkgJson) {
  $manifest = Get-Content $pkgJson -Raw | ConvertFrom-Json
  $inBundles = @($manifest.dsh.profile.bundles) -contains 'dsh-preset-studio'
  $inDeps = $null -ne $manifest.dependencies.'dsh-preset-studio'
  if ($inBundles -or $inDeps) {
    if ($DryRun) {
      Say "[dry-run] 会从 package.json 移除 dsh-preset-studio（bundles=$inBundles, deps=$inDeps）"
    } else {
      Say "移除包…"
      $env:DSH_HOME = $dshHome
      $env:ELECTRON_RUN_AS_NODE = '1'
      & $exe --expose-internals $cli plugin --profile desktop remove dsh-preset-studio 2>&1 | ForEach-Object { Say "  $_" }
    }
  } else {
    Say "package.json 里没有 dsh-preset-studio，跳过移除"
  }
} else {
  Say "找不到 $pkgJson，跳过移除"
}

# 2) 清理 profile patch 里的 - id: preset-studio 块
if (Test-Path $patchPath) {
  Copy-Item $patchPath "$patchPath.bak-uninstall" -Force
  $lines = [IO.File]::ReadAllLines($patchPath, [Text.Encoding]::UTF8)
  $kept = New-Object System.Collections.Generic.List[string]
  $skipping = $false
  $removed = 0
  foreach ($line in $lines) {
    if ($line -match '^\s*-\s*id:\s*preset-studio\s*$') { $skipping = $true; $removed++; continue }
    if ($skipping -and $line -match '^\s*-\s') { $skipping = $false }
    if (-not $skipping) { $kept.Add($line) }
  }
  if ($removed -eq 0) {
    Say "profile patch 里没有 preset-studio 行"
  } elseif ($DryRun) {
    Say "[dry-run] 会从 cordis.patch.yml 删除 $removed 个 preset-studio 行块"
  } else {
    [IO.File]::WriteAllText($patchPath, (($kept -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding($false)))
    Say "已从 cordis.patch.yml 删除 $removed 个行块（备份：cordis.patch.yml.bak-uninstall）"
  }
} else {
  Say "找不到 $patchPath，跳过 patch 清理"
}

# 3) 可选：删除模块数据/检测记录/skill 开关
if (Test-Path $studioDir) {
  $files = Get-ChildItem $studioDir -Recurse -File
  if ($PurgeData) {
    if ($DryRun) {
      Say "[dry-run] 会删除 $studioDir（$($files.Count) 个文件）"
    } else {
      Remove-Item $studioDir -Recurse -Force
      Say "已删除 $studioDir"
    }
  } else {
    Say "保留 $studioDir（$($files.Count) 个文件）。要一起删就加 -PurgeData"
  }
} else {
  Say "$studioDir 不存在，跳过"
}

Say ""
Say "完成。请完全退出 DSH Desktop 再重新打开，改动才生效。"
Say "如果之前把 base 的生效范围改过，卸载后 system prompt 会回到 DSH 官方原样。"
