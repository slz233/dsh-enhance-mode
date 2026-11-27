# 重新对齐官方 standard 的插件清单（DSH 升级后跑一次）。
#
# 用法：右键"使用 PowerShell 运行"，或
#   powershell -ExecutionPolicy Bypass -File scripts\sync-standard.ps1
#
# Desktop 版把官方预设打在 app.asar 里，普通 node 读不到 asar，
# 所以这里用宿主自带的 electron（ELECTRON_RUN_AS_NODE=1）跑同一个脚本。

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'sync-standard.mjs'

$candidates = @()
if ($env:DSH_NODE_EXECUTABLE) { $candidates += $env:DSH_NODE_EXECUTABLE }
$candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe')
$candidates += (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe')

$exe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $exe) {
  Write-Host '[sync-standard] 找不到 DeepSeek Harness 可执行文件。' -ForegroundColor Red
  Write-Host '  在 DSH 的 shell 里跑更容易：$env:DSH_NODE_EXECUTABLE 会自动存在。'
  exit 1
}

$env:ELECTRON_RUN_AS_NODE = '1'
try {
  & $exe $script
  exit $LASTEXITCODE
} finally {
  Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}
