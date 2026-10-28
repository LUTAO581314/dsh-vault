[CmdletBinding()]
param(
  [string]$DshHome = $env:DSH_HOME,
  [string]$Workspace = (Join-Path $env:USERPROFILE 'Documents\deepseek-harness\default-workspace'),
  [switch]$WhatIf,
  [switch]$SkipPluginInstall,
  [switch]$SkipMcpInstall,
  [switch]$SkipMultiZenMcp
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($DshHome)) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$profileDir = Join-Path $DshHome 'profiles\desktop'
$manifestPath = Join-Path $repoRoot 'profiles\desktop\package.json'
$repoLockPath = Join-Path $repoRoot 'profiles\desktop\pnpm-lock.yaml'
$repoWorkspacePath = Join-Path $repoRoot 'profiles\desktop\pnpm-workspace.yaml'
$mcpPackagePath = Join-Path $repoRoot 'mcp\package.json'
$mcpWorkspace = Join-Path $Workspace '.dsh'
$mcpConfigPath = Join-Path $mcpWorkspace 'mcp.json'
$multiZenTokenPath = Join-Path $env:APPDATA 'MultiZen\mcp-token'

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Missing profile manifest: $manifestPath" }
if (-not (Test-Path -LiteralPath $repoLockPath -PathType Leaf)) { throw "Missing profile lockfile: $repoLockPath" }
if (-not (Test-Path -LiteralPath $repoWorkspacePath -PathType Leaf)) { throw "Missing pnpm workspace config: $repoWorkspacePath" }
if (-not (Test-Path -LiteralPath $mcpPackagePath -PathType Leaf)) { throw "Missing MCP manifest: $mcpPackagePath" }

$repoManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$profileManifestPath = Join-Path $profileDir 'package.json'
$profileManifest = if (Test-Path -LiteralPath $profileManifestPath -PathType Leaf) {
  Get-Content -LiteralPath $profileManifestPath -Raw | ConvertFrom-Json
} else {
  [pscustomobject]@{ name = 'dsh-profile-desktop'; private = $true; dependencies = [pscustomobject]@{}; dsh = [pscustomobject]@{ profile = [pscustomobject]@{ bundles = @() } } }
}

if (-not $profileManifest.dependencies) { $profileManifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
if (-not $profileManifest.dsh) { $profileManifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
if (-not $profileManifest.dsh.profile) { $profileManifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{ bundles = @() }) }
if (-not $profileManifest.dsh.profile.bundles) { $profileManifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force }

$dependencyMap = [ordered]@{}
foreach ($item in $profileManifest.dependencies.PSObject.Properties) { $dependencyMap[$item.Name] = $item.Value }
foreach ($item in $repoManifest.dependencies.PSObject.Properties) { $dependencyMap[$item.Name] = $item.Value }
$profileManifest.dependencies = $dependencyMap

$bundleList = [System.Collections.Generic.List[string]]::new()
foreach ($bundle in @($profileManifest.dsh.profile.bundles)) {
  if ($bundle -and -not $bundleList.Contains([string]$bundle)) { $bundleList.Add([string]$bundle) }
}
foreach ($bundle in @($repoManifest.dsh.profile.bundles)) {
  if ($bundle -and -not $bundleList.Contains([string]$bundle)) { $bundleList.Add([string]$bundle) }
}
$profileManifest.dsh.profile.bundles = @($bundleList)

$serverManifest = Get-Content -LiteralPath (Join-Path $repoRoot 'mcp\servers.template.json') -Raw | ConvertFrom-Json
$serverManifest.mcpServers.rea.args[0] = (Join-Path $repoRoot 'mcp\node_modules\rea-agents\scripts\rea.mjs').Replace('\', '/')
$existingMcp = if (Test-Path -LiteralPath $mcpConfigPath -PathType Leaf) {
  Get-Content -LiteralPath $mcpConfigPath -Raw | ConvertFrom-Json
} else {
  [pscustomobject]@{}
}
if (-not $existingMcp.mcpServers) { $existingMcp | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) }
$mcpServers = [ordered]@{}
foreach ($item in $existingMcp.mcpServers.PSObject.Properties) { $mcpServers[$item.Name] = $item.Value }
$mcpServers['rea'] = $serverManifest.mcpServers.rea
$existingMcp.mcpServers = $mcpServers

if ($WhatIf) {
  Write-Output "Would copy two repository plugins into: $(Join-Path $DshHome 'plugins')"
  Write-Output "Would merge $(@($repoManifest.dependencies.PSObject.Properties).Count) pinned packages and $(@($repoManifest.dsh.profile.bundles).Count) DSH bundles into: $profileManifestPath"
  Write-Output "Would use the repository pnpm lockfile: $repoLockPath"
  Write-Output "Would install the pinned REA MCP package under: $(Join-Path $repoRoot 'mcp')"
  Write-Output "Would merge the REA server into: $mcpConfigPath"
  if ($SkipMultiZenMcp) { Write-Output 'Would skip the MultiZen MCP profile entry' }
  elseif (Test-Path -LiteralPath $multiZenTokenPath -PathType Leaf) { Write-Output "Would configure MultiZen from the local token file in: $(Join-Path $profileDir 'cordis.patch.yml')" }
  else { Write-Output 'No local MultiZen token file found; the MultiZen MCP profile entry would be skipped' }
  return
}

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) { throw 'Install Git before running the DSH plugin installer.' }
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'plugins\dsh-purge\.git'))) {
  & $git.Source -C $repoRoot submodule update --init --recursive
  if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the dsh-purge upstream submodule.' }
}
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
$corepack = Get-Command corepack -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $SkipPluginInstall -and -not $pnpm -and -not $corepack) { throw 'Install pnpm or Corepack before installing DSH plugins.' }
if (-not $SkipMcpInstall -and -not $npm) { throw 'Install npm before installing the REA MCP server.' }
if (-not $SkipMultiZenMcp -and (Test-Path -LiteralPath $multiZenTokenPath -PathType Leaf) -and -not $node) { throw 'Install Node.js before configuring the MultiZen MCP server.' }

$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$backupDir = Join-Path $DshHome "backups\dsh-vault\$stamp"
New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
New-Item -ItemType Directory -Path $mcpWorkspace -Force | Out-Null
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
foreach ($path in @($profileManifestPath, (Join-Path $profileDir 'pnpm-lock.yaml'), (Join-Path $profileDir 'pnpm-workspace.yaml'), (Join-Path $profileDir 'cordis.patch.yml'), $mcpConfigPath)) {
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    Copy-Item -LiteralPath $path -Destination (Join-Path $backupDir ([IO.Path]::GetFileName($path))) -Force
  }
}

$pluginRoot = Join-Path $DshHome 'plugins'
New-Item -ItemType Directory -Path $pluginRoot -Force | Out-Null
foreach ($pluginName in @('dsh-multizen-launcher', 'dsh-purge')) {
  $source = Join-Path $repoRoot "plugins\$pluginName"
  $target = Join-Path $pluginRoot $pluginName
  if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Missing plugin source: $source" }
  if (-not (Test-Path -LiteralPath (Join-Path $source 'package.json') -PathType Leaf)) { throw "Missing plugin package manifest: $source" }
  if (Test-Path -LiteralPath $target -PathType Container) {
    $pluginBackupDir = Join-Path $backupDir "plugins\$pluginName"
    New-Item -ItemType Directory -Path (Split-Path -Parent $pluginBackupDir) -Force | Out-Null
    Copy-Item -LiteralPath $target -Destination $pluginBackupDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  Get-ChildItem -LiteralPath $source -Force | Where-Object { $_.Name -ne '.git' } | Copy-Item -Destination $target -Recurse -Force
}

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($profileManifestPath, (($profileManifest | ConvertTo-Json -Depth 50) + [Environment]::NewLine), $utf8NoBom)
Copy-Item -LiteralPath $repoLockPath -Destination (Join-Path $profileDir 'pnpm-lock.yaml') -Force
Copy-Item -LiteralPath $repoWorkspacePath -Destination (Join-Path $profileDir 'pnpm-workspace.yaml') -Force

if (-not $SkipPluginInstall) {
  Push-Location $profileDir
  try {
    if ($pnpm) { & $pnpm.Source install --frozen-lockfile }
    else { & $corepack.Source pnpm install --frozen-lockfile }
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
}

if (-not $SkipMcpInstall) {
  & $npm.Source install --prefix (Join-Path $repoRoot 'mcp') --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "REA MCP installation failed with exit code $LASTEXITCODE" }
}

if (-not $SkipMultiZenMcp) {
  if (Test-Path -LiteralPath $multiZenTokenPath -PathType Leaf) {
    & $node.Source (Join-Path $repoRoot 'scripts\update-profile-mcp.mjs') $DshHome $multiZenTokenPath
    if ($LASTEXITCODE -ne 0) { throw "MultiZen MCP configuration failed with exit code $LASTEXITCODE" }
  } else {
    Write-Warning 'MultiZen token file was not found; installed plugins and the REA MCP are ready, but MultiZen was skipped.'
  }
}

$mcpJson = ($existingMcp | ConvertTo-Json -Depth 50) + [Environment]::NewLine
[IO.File]::WriteAllText($mcpConfigPath, $mcpJson, $utf8NoBom)

Write-Output "DSH plugin manifest installed: $profileManifestPath"
Write-Output "REA MCP connected in workspace: $mcpConfigPath"
Write-Output "Previous manifest/config backups: $backupDir"
Write-Output 'Restart DSH to load the updated plugin profile and MCP server.'
