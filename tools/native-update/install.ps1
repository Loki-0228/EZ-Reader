$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($repoRoot -ne 'D:\EZ-Reader') {
  throw '此更新辅助程序仅为 D:\EZ-Reader 这个源码仓库注册。'
}
$nativeDir = Join-Path $env:LOCALAPPDATA 'EZReader\GitUpdateHost'
$hostName = 'com.ezreader.git_updater'
$extensionId = Read-Host '请输入扩展管理页显示的 EZ-Reader 扩展 ID（32 位 a-p 字符）'
if ($extensionId -notmatch '^[a-p]{32}$') {
  throw '扩展 ID 格式无效。请在扩展管理页打开 EZ-Reader 详情并复制 ID。'
}

$git = (Get-Command git.exe -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
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
[System.IO.File]::WriteAllLines(
  $configPath,
  @($git, $node),
  (New-Object System.Text.UTF8Encoding($false))
)

$manifestPath = Join-Path $nativeDir 'manifest.json'
$hostManifest = @{
  name = $hostName
  description = 'EZ-Reader Git and dist/extension updater'
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
Write-Host '请重载 EZ-Reader 扩展后，在设置页使用“检测本地更新”。'
