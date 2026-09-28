param([string]$ExtensionId = '')

$ErrorActionPreference = 'Stop'

$nativeDir = Join-Path $env:LOCALAPPDATA 'EZReader\GitUpdateHost'
$hostName = 'com.ezreader.git_updater'
$git = (Get-Command git.exe -ErrorAction Stop).Source
$repoRoot = (& $git -C $PSScriptRoot rev-parse --show-toplevel 2>$null | Select-Object -First 1)
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) { throw '请从 Git 克隆的 EZ-Reader 文件夹运行此安装程序。' }
$repoRoot = [System.IO.Path]::GetFullPath($repoRoot.Trim())
$extensionRoot = if (Test-Path -LiteralPath (Join-Path $repoRoot 'manifest.json')) {
  $repoRoot
} elseif (Test-Path -LiteralPath (Join-Path $repoRoot 'dist\extension\manifest.json')) {
  Join-Path $repoRoot 'dist\extension'
} else {
  throw '仓库中没有可加载的扩展文件。请在 EZ-Reader 文件夹内运行此安装程序。'
}
if (-not $ExtensionId) {
  $ExtensionId = Read-Host '请输入扩展管理页显示的 EZ-Reader 扩展 ID（32 位 a-p 字符）'
}
if ($extensionId -notmatch '^[a-p]{32}$') {
  throw '扩展 ID 格式无效。请在扩展管理页打开 EZ-Reader 详情并复制 ID。'
}

$candidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compiler = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) { throw '找不到 Windows .NET Framework C# 编译器（csc.exe）。' }

New-Item -ItemType Directory -Path $nativeDir -Force | Out-Null
$hostExe = Join-Path $nativeDir 'NativeUpdateHost.exe'
& $compiler /nologo /target:exe "/out:$hostExe" (Join-Path $PSScriptRoot 'NativeUpdateHost.cs')
if ($LASTEXITCODE -ne 0) { throw '本地更新辅助程序编译失败。' }

$configPath = Join-Path $nativeDir 'config.txt'
[System.IO.File]::WriteAllLines($configPath, @($git, $repoRoot, $extensionRoot), (New-Object System.Text.UTF8Encoding($false)))

$manifestPath = Join-Path $nativeDir 'manifest.json'
$hostManifest = @{
  name = $hostName
  description = 'EZ-Reader Git updater'
  path = $hostExe
  type = 'stdio'
  allowed_origins = @("chrome-extension://$extensionId/")
} | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $hostManifest, (New-Object System.Text.UTF8Encoding($false)))

$registrations = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
)
foreach ($base in $registrations) {
  $key = Join-Path $base $hostName
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $manifestPath
}

Write-Host 'EZ-Reader 本地 Git 更新辅助程序已安装。'
Write-Host "源码仓库：$repoRoot"
Write-Host '请重载 EZ-Reader 扩展。以后点击设置页中的“检查并更新”即可自动更新。'
