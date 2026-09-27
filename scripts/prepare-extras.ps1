# 准备打包/安装包需要"外挂"进 exe 目录的文件：
#   src-tauri/extras/texthook.dll                          (x64，来自 Chenx221/Textractor release)
#   src-tauri/extras/x86/texthook.dll                      (x86，同上)
#   src-tauri/extras/x86/texthook-injector32.exe           (本仓库 injector32 编译产物)
#   src-tauri/extras/data.lnk                              (指向 %APPDATA%\<identifier> 的快捷方式)
#
# 这些文件被 src-tauri/tauri.release.conf.json 以 bundle.resources 的方式打进 MSI / NSIS，
# 同时也会被 scripts/make-portable.ps1 复制进绿色版压缩包。
#
# 用法：
#   pwsh -File scripts/prepare-extras.ps1                          # 抓最新 release
#   pwsh -File scripts/prepare-extras.ps1 -TexthookTag v260927     # 指定 tag
#   pwsh -File scripts/prepare-extras.ps1 -SkipInjector -SkipShortcut
[CmdletBinding()]
param(
    # Textractor 侧 texthook 的 tag（如 v260927）；留空或 latest = 最新 release
    [string]$TexthookTag = "",
    [string]$Repo = "Chenx221/Textractor",
    [string]$OutDir = "",
    [switch]$SkipInjector,
    [switch]$SkipShortcut
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $root "src-tauri\extras"
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)

$headers = @{
    "User-Agent" = "textractor-tauri-build"
    "Accept"     = "application/vnd.github+json"
}

function Get-GitHubRelease {
    param([string]$Tag)
    $uri = if ([string]::IsNullOrWhiteSpace($Tag) -or $Tag -eq "latest") {
        "https://api.github.com/repos/$Repo/releases/latest"
    } else {
        "https://api.github.com/repos/$Repo/releases/tags/$Tag"
    }
    Write-Host "fetching release metadata: $uri"
    return Invoke-RestMethod -Uri $uri -Headers $headers
}

function Select-TexthookAsset {
    param($Release)
    $candidates = @($Release.assets | Where-Object { $_.name -match '^texthook_.*\.7z$' })
    if ($candidates.Count -eq 0) {
        $names = ($Release.assets | ForEach-Object { $_.name }) -join ", "
        throw "release $($Release.tag_name) 里没有 texthook_*.7z 资产（实际资产：$names）"
    }
    # 工具链偏好：msvc22 > msvc19 > msvc > qt6 > 其它 > 无后缀
    $preference = @{ "msvc22" = 0; "msvc19" = 1; "msvc" = 2; "qt6" = 3 }
    $ranked = $candidates | ForEach-Object {
        $match = [regex]::Match($_.name, '^texthook_\d+(?:_([A-Za-z0-9]+))?\.7z$')
        $key = if ($match.Success -and $match.Groups[1].Success) { $match.Groups[1].Value.ToLower() } else { "" }
        $rank = if ($preference.ContainsKey($key)) { $preference[$key] } else { 9 }
        [pscustomobject]@{ Asset = $_; Rank = $rank }
    } | Sort-Object Rank, { $_.Asset.name }
    return $ranked[0].Asset
}

function Get-SevenZip {
    $cmd = Get-Command 7z.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    # 用 GetEnvironmentVariable 而不是 ${env:...}：StrictMode 下读取未定义的环境变量会抛错。
    foreach ($prefix in @(
            [Environment]::GetEnvironmentVariable("ProgramFiles"),
            [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
        )) {
        if ([string]::IsNullOrWhiteSpace($prefix)) { continue }
        $candidate = Join-Path $prefix "7-Zip\7z.exe"
        if (Test-Path $candidate) { return $candidate }
    }
    throw "找不到 7z.exe：请安装 7-Zip（或把它加入 PATH）"
}

# ---------------------------------------------------------------- 下载 + 解包 ----
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir "x86") | Out-Null

$release = Get-GitHubRelease -Tag $TexthookTag
$asset = Select-TexthookAsset -Release $release
Write-Host "using $($release.tag_name): $($asset.name) ($([math]::Round($asset.size / 1KB)) KiB)"

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("texthook-" + [guid]::NewGuid().ToString("N"))
$archive = Join-Path $temp $asset.name
$extracted = Join-Path $temp "extract"
New-Item -ItemType Directory -Force -Path $extracted | Out-Null

try {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive -Headers $headers
    $sevenZip = Get-SevenZip
    & $sevenZip x $archive "-o$extracted" -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "7z 解压失败：$archive" }

    $dlls = @(Get-ChildItem -Path $extracted -Recurse -Filter texthook.dll -File)
    $x64 = $dlls | Where-Object { $_.Directory.Name -ieq "x64" } | Select-Object -First 1
    $x86 = $dlls | Where-Object { $_.Directory.Name -ieq "x86" } | Select-Object -First 1
    if (-not $x64) { throw "解包后找不到 x64\texthook.dll（资产：$($asset.name)）" }
    if (-not $x86) { throw "解包后找不到 x86\texthook.dll（资产：$($asset.name)）" }

    Copy-Item $x64.FullName (Join-Path $OutDir "texthook.dll") -Force
    Copy-Item $x86.FullName (Join-Path $OutDir "x86\texthook.dll") -Force
    Write-Host "texthook.dll (x64): $([math]::Round($x64.Length / 1KB)) KiB"
    Write-Host "x86\texthook.dll:  $([math]::Round($x86.Length / 1KB)) KiB"
}
finally {
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}

$meta = [ordered]@{ texthookTag = $release.tag_name; texthookAsset = $asset.name }
$meta | ConvertTo-Json | Set-Content -Path (Join-Path $OutDir "texthook.json") -Encoding utf8

# ------------------------------------------------------------ 32 位注入器 ----
if (-not $SkipInjector) {
    Push-Location $root
    try {
        # 目标可能已装好（CI 里由 rust-toolchain action 添加）；失败不致命，交给 cargo 报错。
        if (Get-Command rustup -ErrorAction SilentlyContinue) {
            & rustup target add i686-pc-windows-msvc | Out-Host
        }
        else {
            Write-Warning "没有找到 rustup：请确认已安装 i686-pc-windows-msvc 目标"
        }
        & cargo build --release --manifest-path injector32\Cargo.toml --target i686-pc-windows-msvc
        if ($LASTEXITCODE -ne 0) { throw "cargo build injector32 失败" }
    }
    finally {
        Pop-Location
    }
    $injector = Join-Path $root "injector32\target\i686-pc-windows-msvc\release\texthook-injector32.exe"
    if (-not (Test-Path $injector)) { throw "找不到 32 位注入器产物：$injector" }
    Copy-Item $injector (Join-Path $OutDir "x86\texthook-injector32.exe") -Force
    Write-Host "x86\texthook-injector32.exe: $([math]::Round((Get-Item $injector).Length / 1KB)) KiB"
}

# ------------------------------------------------------------ data.lnk ----
if (-not $SkipShortcut) {
    $lnkPath = Join-Path $OutDir "data.lnk"
    Remove-Item $lnkPath -Force -ErrorAction SilentlyContinue
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($lnkPath)
    # 指向应用的数据目录（app_config_dir() = %APPDATA%\<identifier>），Explorer 会展开环境变量。
    $shortcut.TargetPath = "%APPDATA%\cyou.chenx221.textractor-tauri"
    $shortcut.Description = "Textractor data folder"
    $shortcut.Save()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
    if (-not (Test-Path $lnkPath)) { throw "data.lnk 创建失败" }
    Write-Host "data.lnk -> %APPDATA%\cyou.chenx221.textractor-tauri"
}

Write-Host ""
Write-Host "extras ready at $OutDir"
Get-ChildItem -Path $OutDir -Recurse -File | ForEach-Object {
    Write-Host ("  {0,-42} {1,10:N0} bytes" -f $_.FullName.Substring($OutDir.Length + 1), $_.Length)
}
