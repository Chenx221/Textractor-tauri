# 组装绿色版（便携版）压缩包。
#
#   pwsh -File scripts/make-portable.ps1 -Version 26.9.27
#
# 目录结构（与安装版一致：texthook.dll / x86 必须与 exe 同级）：
#   textractor-tauri/
#     textractor-tauri.exe
#     texthook.dll
#     data.lnk
#     x86/
#       texthook-injector32.exe
#       texthook.dll
#
# 产物：dist-portable/textractor-tauri_<version>_portable_x64.zip
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$BinDir = "",
    [string]$ExtrasDir = "",
    [string]$OutDir = "",
    [string]$ExeName = "textractor-tauri.exe"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($BinDir)) { $BinDir = Join-Path $root "src-tauri\target\release" }
if ([string]::IsNullOrWhiteSpace($ExtrasDir)) { $ExtrasDir = Join-Path $root "src-tauri\extras" }
if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Join-Path $root "dist-portable" }

$exe = Join-Path $BinDir $ExeName
if (-not (Test-Path $exe)) { throw "找不到可执行文件：$exe（先跑 tauri build / cargo build --release）" }

$required = @(
    (Join-Path $ExtrasDir "texthook.dll"),
    (Join-Path $ExtrasDir "x86\texthook.dll"),
    (Join-Path $ExtrasDir "x86\texthook-injector32.exe")
)
$missing = @($required | Where-Object { -not (Test-Path $_) })
if ($missing.Count -gt 0) {
    $list = ($missing | ForEach-Object { "  $_" }) -join [Environment]::NewLine
    throw "extras 不完整，请先运行 scripts/prepare-extras.ps1。缺少：`n$list"
}

$appFolderName = "textractor-tauri"
$staging = Join-Path $OutDir "staging"
$appDir = Join-Path $staging $appFolderName
$zip = Join-Path $OutDir ("{0}_{1}_portable_x64.zip" -f $appFolderName, $Version)

Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $zip -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $appDir "x86") | Out-Null

Copy-Item $exe (Join-Path $appDir $ExeName) -Force
Copy-Item (Join-Path $ExtrasDir "texthook.dll") $appDir -Force
Copy-Item (Join-Path $ExtrasDir "x86\texthook.dll") (Join-Path $appDir "x86") -Force
Copy-Item (Join-Path $ExtrasDir "x86\texthook-injector32.exe") (Join-Path $appDir "x86") -Force

# 记录"自带的是哪个上游版本"，应用内 texthook 更新靠它判断当前版本。
$meta = Join-Path $ExtrasDir "texthook.json"
if (Test-Path $meta) {
    Copy-Item $meta (Join-Path $appDir "texthook-bundled.json") -Force
}

$lnk = Join-Path $ExtrasDir "data.lnk"
if (Test-Path $lnk) {
    Copy-Item $lnk $appDir -Force
} else {
    Write-Warning "没有找到 data.lnk（可加 -SkipShortcut 之外的参数重新生成 extras）"
}

Compress-Archive -Path $appDir -DestinationPath $zip -CompressionLevel Optimal -Force

Write-Host ""
Write-Host "portable package: $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 2)) MiB)"
Get-ChildItem -Path $appDir -Recurse -File | ForEach-Object {
    Write-Host ("  {0,-40} {1,10:N0} bytes" -f $_.FullName.Substring($appDir.Length + 1), $_.Length)
}

# 供 workflow 使用
Write-Output $zip
