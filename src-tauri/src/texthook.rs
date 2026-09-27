//! `texthook.dll` 的运行时更新。
//!
//! 上游 `Chenx221/Textractor` 的 release 只提供 `texthook_<日期>[_工具链].7z`，所以这里
//! 下载 7z 后自行解压（`sevenz-rust2`：纯 Rust，支持 LZMA2 + BCJ2），再把 x64 / x86 两份
//! `texthook.dll` **就地替换**到 exe 同级目录 —— 注入时用的就是这两份文件，替换后重新附加
//! 游戏即可生效（无需重装/升级应用）。
//!
//! 就地替换的代价是：安装在 Program Files 时目录不可写。因此替换前先探测目录可写性，
//! 不可写时返回 `NEED_ADMIN:` 前缀的错误，前端据此提示「以管理员身份重启」。
//!
//! 记账信息（装的是哪个上游 tag、文件哈希）写在**可写的配置目录**里，因为 exe 目录有可能
//! 不可写；再配合安装包自带的 `texthook-bundled.json`，即可判断当前生效的版本到底是
//! “随程序自带的”还是“运行时更新过的”。
//!
//! 核心逻辑都基于传入的目录参数（`exe_dir` / `config_dir`），便于用真实的上游 7z 做
//! 端到端测试；`status` / `check` / `install` 只是从 `AppHandle` 取出目录再调它们。

use std::fs;
use std::io::Cursor;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use windows_sys::Win32::Foundation::{GetLastError, ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION};
use windows_sys::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};

use crate::crypto;
use crate::host;
use crate::http;
use crate::{TexthookCheck, TexthookStatus, TexthookUpdateResult};

/// 上游仓库。
const REPO: &str = "Chenx221/Textractor";
/// GitHub 不接受空 User-Agent。
const USER_AGENT: &str = "Textractor-tauri";
const API_TIMEOUT_MS: i32 = 30_000;
const DOWNLOAD_TIMEOUT_MS: i32 = 300_000;
/// 自动检查的节流间隔：启动时的静默检查最多每天一次（GitHub 未登录 API 限 60 次/小时）。
const CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;
/// release notes 太长，界面只展示前面一段。
const NOTES_LIMIT: usize = 1200;

const DLL_NAME: &str = "texthook.dll";
const X86_DIR: &str = "x86";
/// 本地记账文件（放在配置目录）。
const META_FILE: &str = "texthook.json";
/// 随安装包分发的“自带版本”标记（CI 由 `scripts/prepare-extras.ps1` 生成后打进资源）。
const BUNDLED_META: &str = "texthook-bundled.json";
/// 7z 文件头。
const SEVENZ_MAGIC: [u8; 6] = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];

const IMAGE_FILE_MACHINE_I386: u16 = 0x014c;
const IMAGE_FILE_MACHINE_AMD64: u16 = 0x8664;

/// 同一时刻只允许一个更新流程。
static UPDATING: AtomicBool = AtomicBool::new(false);

// ---------------------------------------------------------------- 数据结构 ----

/// 记账信息（`{config_dir}/texthook.json`）。
#[derive(Serialize, Deserialize, Default, Clone)]
struct Meta {
    /// 运行时更新过的上游 tag（例如 `v260927`）。
    #[serde(default)]
    tag: String,
    #[serde(default)]
    asset: String,
    #[serde(default)]
    x64_sha256: String,
    #[serde(default)]
    x86_sha256: String,
    #[serde(default)]
    installed_at: u64,
    /// 最近一次检查到的上游 tag（用于 24h 节流，避免每次启动都打 API）。
    #[serde(default)]
    upstream_tag: String,
    #[serde(default)]
    upstream_asset: String,
    #[serde(default)]
    last_check: u64,
}

/// 安装包自带的版本标记（键名沿用 PowerShell 生成的样子）。
#[derive(Deserialize)]
struct BundledMeta {
    #[serde(rename = "texthookTag", default)]
    tag: Option<String>,
}

/// release 里的一个资产。
#[derive(Clone, Deserialize)]
struct Asset {
    name: String,
    #[serde(default)]
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

struct ReleaseInfo {
    tag: String,
    notes: String,
    asset: Asset,
}

#[derive(Clone, Serialize)]
struct StageEvent {
    stage: &'static str,
}

// ---------------------------------------------------------------- 小工具 ----

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `v260927` / `260927` → `260927`（用于比较版本新旧）。
fn version_number(tag: &str) -> Option<u64> {
    let digits: String = tag
        .trim()
        .trim_start_matches(['v', 'V'])
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_file_hex(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    Some(hex(&crypto::sha256_digest(&bytes)))
}

/// 目录是否可写（就地替换前先探一下，避免下载完才发现没权限）。
fn dir_writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".textractor-write-test");
    match fs::write(&probe, b"") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 更新需要的两个目录（exe 目录 + x86 子目录）是否都可写。
fn targets_writable(exe_dir: &Path) -> bool {
    dir_writable(exe_dir) && dir_writable(&exe_dir.join(X86_DIR))
}

fn meta_path(config_dir: &Path) -> PathBuf {
    config_dir.join(META_FILE)
}

fn read_meta(config_dir: &Path) -> Meta {
    fs::read_to_string(meta_path(config_dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_meta(config_dir: &Path, meta: &Meta) -> Result<(), String> {
    fs::create_dir_all(config_dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    let text = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    fs::write(meta_path(config_dir), text).map_err(|e| format!("写入 {META_FILE} 失败：{e}"))
}

/// x64 / x86 两份 DLL 的路径（注入时用的就是它们）。
fn dll_paths(exe_dir: &Path) -> (PathBuf, PathBuf) {
    (exe_dir.join(DLL_NAME), exe_dir.join(X86_DIR).join(DLL_NAME))
}

fn bundled_tag(exe_dir: &Path) -> Option<String> {
    let text = fs::read_to_string(exe_dir.join(BUNDLED_META)).ok()?;
    let meta: BundledMeta = serde_json::from_str(&text).ok()?;
    meta.tag.filter(|t| !t.is_empty())
}

/// 当前生效的 texthook 版本：`(tag, 来源)`。
///
/// 先看记账 + 文件哈希是否吻合（吻合说明就是运行时更新进去的那份）；不吻合说明文件被
/// 安装包覆盖过（或用户手工替换过），此时以安装包自带的标记为准。
fn current_version(exe_dir: &Path, config_dir: &Path) -> (Option<String>, &'static str) {
    let (x64, x86) = dll_paths(exe_dir);
    if !x64.is_file() {
        return (None, "unknown");
    }
    let meta = read_meta(config_dir);
    if !meta.tag.is_empty() && !meta.x64_sha256.is_empty() {
        let x64_ok = sha256_file_hex(&x64).as_deref() == Some(meta.x64_sha256.as_str());
        let x86_ok =
            !x86.is_file() || sha256_file_hex(&x86).as_deref() == Some(meta.x86_sha256.as_str());
        if x64_ok && x86_ok {
            return (Some(meta.tag), "installed");
        }
    }
    match bundled_tag(exe_dir) {
        Some(tag) => (Some(tag), "bundled"),
        None => (None, "unknown"),
    }
}

fn app_dirs(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let exe_dir = host::exe_dir().ok_or_else(|| "无法定位程序所在目录".to_string())?;
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
    Ok((exe_dir, config_dir))
}

// ---------------------------------------------------------------- 网络 ----

/// 取上游 release（`tag` 为空 = latest）。
fn fetch_release(tag: Option<&str>) -> Result<ReleaseInfo, String> {
    let url = match tag {
        Some(t) if !t.trim().is_empty() => format!(
            "https://api.github.com/repos/{REPO}/releases/tags/{}",
            t.trim()
        ),
        _ => format!("https://api.github.com/repos/{REPO}/releases/latest"),
    };
    let headers = vec![
        format!("User-Agent: {USER_AGENT}"),
        "Accept: application/vnd.github+json".to_string(),
    ];
    let bytes = http::http_request("GET", &url, &headers, &[], API_TIMEOUT_MS)?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析 release 信息失败：{e}"))?;
    // 限流 / 404 等情况 GitHub 也返回 JSON：{"message": "..."}
    if let Some(message) = value.get("message").and_then(|m| m.as_str()) {
        return Err(format!("GitHub API：{message}"));
    }
    let tag_name = value
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "release 信息里缺少 tag_name".to_string())?
        .to_string();
    let notes = value
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .chars()
        .take(NOTES_LIMIT)
        .collect::<String>();
    let assets: Vec<Asset> = value
        .get("assets")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let asset =
        pick_asset(&assets).ok_or_else(|| format!("release {tag_name} 里没有 texthook_*.7z 资产"))?;
    Ok(ReleaseInfo {
        tag: tag_name,
        notes,
        asset,
    })
}

/// 从资产列表里挑 texthook 压缩包（工具链偏好与 CI 脚本一致）。
fn pick_asset(assets: &[Asset]) -> Option<Asset> {
    let mut best: Option<(u8, Asset)> = None;
    for asset in assets {
        let lower = asset.name.to_ascii_lowercase();
        if !lower.starts_with("texthook_") || !lower.ends_with(".7z") {
            continue;
        }
        // texthook_260927_msvc22.7z -> "msvc22"
        let middle = &asset.name["texthook_".len()..asset.name.len() - ".7z".len()];
        let toolchain = middle
            .split_once('_')
            .map(|(_, rest)| rest.to_ascii_lowercase())
            .unwrap_or_default();
        let rank = match toolchain.as_str() {
            "msvc22" => 0,
            "msvc19" => 1,
            "msvc" => 2,
            "qt6" => 3,
            "" => 4,
            _ => 9,
        };
        let replace = match &best {
            Some((current, existing)) => {
                rank < *current || (rank == *current && asset.name < existing.name)
            }
            None => true,
        };
        if replace {
            best = Some((rank, asset.clone()));
        }
    }
    best.map(|(_, asset)| asset)
}

// ---------------------------------------------------------------- 解压 ----

/// PE 文件的 machine 字段（用于确认 x64/x86 没弄反）。
fn pe_machine(data: &[u8]) -> Option<u16> {
    if data.len() < 0x40 || &data[..2] != b"MZ" {
        return None;
    }
    let offset = u32::from_le_bytes([data[0x3c], data[0x3d], data[0x3e], data[0x3f]]) as usize;
    if data.len() < offset + 6 || &data[offset..offset + 4] != b"PE\0\0" {
        return None;
    }
    Some(u16::from_le_bytes([data[offset + 4], data[offset + 5]]))
}

/// 从 7z 里取出 `x64/texthook.dll` 与 `x86/texthook.dll`。
fn extract_dlls(archive: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut reader =
        sevenz_rust2::ArchiveReader::new(Cursor::new(archive), sevenz_rust2::Password::empty())
            .map_err(|e| format!("打开 7z 失败：{e}"))?;
    let mut x64: Option<Vec<u8>> = None;
    let mut x86: Option<Vec<u8>> = None;
    let mut read_error: Option<String> = None;

    reader
        .for_each_entries(|entry, reader| {
            if entry.is_directory() {
                return Ok(true);
            }
            // 7z 里可能是 `x64\texthook.dll`，也可能用正斜杠。
            let name = entry.name().replace('\\', "/").to_ascii_lowercase();
            let parts: Vec<&str> = name.split('/').collect();
            if parts.len() < 2 || parts[parts.len() - 1] != DLL_NAME {
                return Ok(true);
            }
            let slot = match parts[parts.len() - 2] {
                "x64" => &mut x64,
                "x86" => &mut x86,
                _ => return Ok(true),
            };
            let mut buf = Vec::new();
            match reader.read_to_end(&mut buf) {
                Ok(_) => *slot = Some(buf),
                Err(e) => {
                    read_error = Some(e.to_string());
                    return Ok(false);
                }
            }
            Ok(true)
        })
        .map_err(|e| format!("解压 7z 失败：{e}"))?;

    if let Some(err) = read_error {
        return Err(format!("读取 7z 内容失败：{err}"));
    }
    let x64 = x64.ok_or_else(|| "压缩包里没有 x64/texthook.dll".to_string())?;
    let x86 = x86.ok_or_else(|| "压缩包里没有 x86/texthook.dll".to_string())?;
    Ok((x64, x86))
}

// ---------------------------------------------------------------- 就地替换 ----

/// 就地替换文件：先写 `<name>.new`，再用 `MoveFileExW(REPLACE_EXISTING)` 顶替。
/// 这样目标被游戏占用时只会失败，不会留下半截文件。
fn replace_file(bytes: &[u8], target: &Path) -> Result<(), String> {
    let tmp = target.with_extension("dll.new");
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    fs::write(&tmp, bytes).map_err(|e| format!("写入 {} 失败：{e}", tmp.display()))?;

    let tmp_w: Vec<u16> = tmp.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let dst_w: Vec<u16> = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let ok = unsafe {
        MoveFileExW(
            tmp_w.as_ptr(),
            dst_w.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        let _ = fs::remove_file(&tmp);
        let code = unsafe { GetLastError() };
        return Err(match code {
            ERROR_ACCESS_DENIED => format!(
                "NEED_ADMIN: 替换 {} 失败：拒绝访问（需要管理员权限，或文件被占用）",
                target.display()
            ),
            ERROR_SHARING_VIOLATION => format!(
                "替换 {} 失败：文件正在被占用，请先关闭游戏或分离已附加的进程",
                target.display()
            ),
            _ => format!("替换 {} 失败：Win32 错误 {code}", target.display()),
        });
    }
    Ok(())
}

// ---------------------------------------------------------------- 流程 ----

fn emit_stage(app: Option<&AppHandle>, stage: &'static str) {
    if let Some(app) = app {
        let _ = app.emit("texthook-update-progress", StageEvent { stage });
    }
}

/// 检查上游是否有更新的 texthook（`force = false` 时 24h 内直接走缓存）。
fn check_with(exe_dir: &Path, config_dir: &Path, force: bool) -> Result<TexthookCheck, String> {
    let meta = read_meta(config_dir);
    let now = now_secs();
    let cached = !force
        && !meta.upstream_tag.is_empty()
        && now.saturating_sub(meta.last_check) < CHECK_INTERVAL_SECS;

    let (tag, asset, size, url, notes) = if cached {
        (
            meta.upstream_tag.clone(),
            meta.upstream_asset,
            0,
            String::new(),
            String::new(),
        )
    } else {
        let release = fetch_release(None)?;
        let mut updated = meta;
        updated.upstream_tag = release.tag.clone();
        updated.upstream_asset = release.asset.name.clone();
        updated.last_check = now;
        write_meta(config_dir, &updated)?;
        (
            release.tag,
            release.asset.name,
            release.asset.size,
            release.asset.browser_download_url,
            release.notes,
        )
    };

    let (current_tag, _) = current_version(exe_dir, config_dir);
    let has_update = match (
        version_number(&tag),
        current_tag.as_deref().and_then(version_number),
    ) {
        // 本地版本未知（例如开发构建没带标记）→ 允许用户手动更新
        (Some(_), None) => true,
        (Some(up), Some(cur)) => up > cur,
        _ => false,
    };

    Ok(TexthookCheck {
        tag,
        asset,
        size,
        url,
        current_tag,
        has_update,
        notes,
        cached,
        writable: targets_writable(exe_dir),
    })
}

/// 下载并就地安装（核心流程；目录由参数给出，便于测试）。
fn install_with(
    app: Option<&AppHandle>,
    tag: Option<String>,
    exe_dir: &Path,
    config_dir: &Path,
) -> Result<TexthookUpdateResult, String> {
    // 先探可写性：不可写就别下载了，直接让前端提示提权。
    if !targets_writable(exe_dir) {
        return Err(format!(
            "NEED_ADMIN: 安装目录不可写（{}），请以管理员身份重启后再更新。",
            exe_dir.display()
        ));
    }

    let release = fetch_release(tag.as_deref())?;
    emit_stage(app, "downloading");
    let headers = vec![format!("User-Agent: {USER_AGENT}")];
    let url = if release.asset.browser_download_url.is_empty() {
        format!(
            "https://github.com/{REPO}/releases/download/{}/{}",
            release.tag, release.asset.name
        )
    } else {
        release.asset.browser_download_url.clone()
    };
    let archive = http::http_request("GET", &url, &headers, &[], DOWNLOAD_TIMEOUT_MS)?;
    if archive.len() < 1024 || archive[..6] != SEVENZ_MAGIC {
        return Err(format!(
            "下载失败：返回内容不是 7z 压缩包（{} 字节）",
            archive.len()
        ));
    }

    emit_stage(app, "extracting");
    let (x64_bytes, x86_bytes) = extract_dlls(&archive)?;

    // 防止上游换了打包方式导致 x64/x86 弄反。
    match pe_machine(&x64_bytes) {
        Some(IMAGE_FILE_MACHINE_AMD64) => {}
        other => {
            return Err(format!(
                "x64/texthook.dll 架构异常（machine={other:?}），已中止更新"
            ))
        }
    }
    match pe_machine(&x86_bytes) {
        Some(IMAGE_FILE_MACHINE_I386) => {}
        other => {
            return Err(format!(
                "x86/texthook.dll 架构异常（machine={other:?}），已中止更新"
            ))
        }
    }

    emit_stage(app, "installing");
    // 已注入的进程会把 dll 映射在内存里导致替换失败，先分离。
    let detached = host::detach_all();
    if detached > 0 {
        if let Some(app) = app {
            host::console(
                app,
                format!("texthook 更新：已分离 {detached} 个进程以便替换 texthook.dll"),
            );
        }
    }

    let (x64_path, x86_path) = dll_paths(exe_dir);
    replace_file(&x64_bytes, &x64_path)?;
    replace_file(&x86_bytes, &x86_path)?;

    let now = now_secs();
    let meta = Meta {
        tag: release.tag.clone(),
        asset: release.asset.name.clone(),
        x64_sha256: hex(&crypto::sha256_digest(&x64_bytes)),
        x86_sha256: hex(&crypto::sha256_digest(&x86_bytes)),
        installed_at: now,
        upstream_tag: release.tag.clone(),
        upstream_asset: release.asset.name.clone(),
        last_check: now,
    };
    write_meta(config_dir, &meta)?;

    if let Some(app) = app {
        host::console(
            app,
            format!("texthook 已更新到 {}（{}）", release.tag, release.asset.name),
        );
    }
    emit_stage(app, "done");

    Ok(TexthookUpdateResult {
        tag: release.tag,
        x64_bytes: x64_bytes.len() as u64,
        x86_bytes: x86_bytes.len() as u64,
        dll_path: x64_path.to_string_lossy().to_string(),
        x86_dll_path: x86_path.to_string_lossy().to_string(),
    })
}

// ---------------------------------------------------------------- 对外 API ----

/// 本地状态（不联网）。
pub fn status(app: &AppHandle) -> Result<TexthookStatus, String> {
    let (exe_dir, config_dir) = app_dirs(app)?;
    let (x64, x86) = dll_paths(&exe_dir);
    let meta = read_meta(&config_dir);
    let (tag, source) = current_version(&exe_dir, &config_dir);
    Ok(TexthookStatus {
        writable: targets_writable(&exe_dir),
        dir: exe_dir.to_string_lossy().to_string(),
        dll_path: x64.to_string_lossy().to_string(),
        x86_dll_path: x86.to_string_lossy().to_string(),
        tag,
        source: source.to_string(),
        upstream_tag: (!meta.upstream_tag.is_empty()).then_some(meta.upstream_tag),
        last_check: meta.last_check,
    })
}

/// 检查上游是否有更新的 texthook。
pub fn check(app: &AppHandle, force: bool) -> Result<TexthookCheck, String> {
    let (exe_dir, config_dir) = app_dirs(app)?;
    check_with(&exe_dir, &config_dir, force)
}

/// 下载并就地安装 texthook（阻塞调用，调用方放到 blocking 线程）。
pub fn install(app: &AppHandle, tag: Option<String>) -> Result<TexthookUpdateResult, String> {
    if UPDATING.swap(true, Ordering::SeqCst) {
        return Err("已有更新任务在进行中".to_string());
    }
    let result = app_dirs(app)
        .and_then(|(exe_dir, config_dir)| install_with(Some(app), tag, &exe_dir, &config_dir));
    UPDATING.store(false, Ordering::SeqCst);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_version_numbers() {
        assert_eq!(version_number("v260927"), Some(260927));
        assert_eq!(version_number("v260927_msvc22"), Some(260927));
        assert_eq!(version_number("1.2.3"), Some(1));
        assert_eq!(version_number("latest"), None);
    }

    #[test]
    fn picks_msvc22_asset() {
        let assets = vec![
            Asset {
                name: "texthook_260927_qt6.7z".into(),
                browser_download_url: String::new(),
                size: 0,
            },
            Asset {
                name: "texthook_260927.7z".into(),
                browser_download_url: String::new(),
                size: 0,
            },
            Asset {
                name: "texthook_260927_msvc22.7z".into(),
                browser_download_url: String::new(),
                size: 0,
            },
            Asset {
                name: "Textractor_260927.7z".into(),
                browser_download_url: String::new(),
                size: 0,
            },
        ];
        assert_eq!(pick_asset(&assets).unwrap().name, "texthook_260927_msvc22.7z");
    }

    #[test]
    fn reads_pe_machine() {
        // 最小合法 PE 头：MZ + e_lfanew=0x40 + PE\0\0 + machine
        let mut data = vec![0u8; 0x50];
        data[..2].copy_from_slice(b"MZ");
        data[0x3c..0x40].copy_from_slice(&0x40u32.to_le_bytes());
        data[0x40..0x44].copy_from_slice(b"PE\0\0");
        data[0x44..0x46].copy_from_slice(&IMAGE_FILE_MACHINE_AMD64.to_le_bytes());
        assert_eq!(pe_machine(&data), Some(IMAGE_FILE_MACHINE_AMD64));
        assert_eq!(pe_machine(b"not a pe"), None);
    }

    #[test]
    fn replaces_existing_file_in_place() {
        let dir = temp_dir("textractor-texthook-replace-test");
        let target = dir.join(DLL_NAME);
        fs::write(&target, b"old").unwrap();
        replace_file(b"new-content", &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new-content");
        // 临时文件不应残留
        assert!(!target.with_extension("dll.new").exists());
        // 目标不存在（含父目录不存在）时也要能创建
        let fresh = dir.join("sub").join(DLL_NAME);
        replace_file(b"fresh", &fresh).unwrap();
        assert_eq!(fs::read(&fresh).unwrap(), b"fresh");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 记账 + 当前版本判断：装过之后识别为 `installed`，文件被安装包覆盖则退回 `bundled`。
    #[test]
    fn reports_installed_and_bundled_versions() {
        let root = temp_dir("textractor-texthook-version-test");
        let exe_dir = root.join("app");
        let config_dir = root.join("cfg");
        fs::create_dir_all(exe_dir.join(X86_DIR)).unwrap();
        fs::create_dir_all(&config_dir).unwrap();

        let x64 = b"x64-payload".to_vec();
        let x86 = b"x86-payload".to_vec();
        fs::write(exe_dir.join(DLL_NAME), &x64).unwrap();
        fs::write(exe_dir.join(X86_DIR).join(DLL_NAME), &x86).unwrap();
        fs::write(
            exe_dir.join(BUNDLED_META),
            r#"{"texthookTag":"v260101","texthookAsset":"texthook_260101_msvc22.7z"}"#,
        )
        .unwrap();

        // 没有任何记账 = 随程序自带
        assert_eq!(
            current_version(&exe_dir, &config_dir),
            (Some("v260101".to_string()), "bundled")
        );

        // 记账与文件吻合 = 运行时更新过
        write_meta(
            &config_dir,
            &Meta {
                tag: "v260927".into(),
                asset: "texthook_260927_msvc22.7z".into(),
                x64_sha256: hex(&crypto::sha256_digest(&x64)),
                x86_sha256: hex(&crypto::sha256_digest(&x86)),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            current_version(&exe_dir, &config_dir),
            (Some("v260927".to_string()), "installed")
        );

        // 文件被安装包覆盖 → 记账失效，退回自带版本
        fs::write(exe_dir.join(DLL_NAME), b"overwritten-by-installer").unwrap();
        assert_eq!(
            current_version(&exe_dir, &config_dir),
            (Some("v260101".to_string()), "bundled")
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// 只读/不存在的目录 → 应返回 NEED_ADMIN 前缀（前端据此提示提权）。
    /// 默认忽略（会访问 Z: 盘），运行：`cargo test --lib texthook -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn reports_need_admin_for_unwritable_dir() {
        let exe_dir = PathBuf::from("Z:\\definitely\\not\\writable");
        let config_dir = temp_dir("textractor-texthook-admin-test");
        // TexthookUpdateResult 没有 Debug，不能用 unwrap_err()。
        let err = match install_with(None, None, &exe_dir, &config_dir) {
            Ok(result) => panic!("expected failure, got {}", result.tag),
            Err(err) => err,
        };
        println!("error: {err}");
        assert!(err.starts_with("NEED_ADMIN"), "unexpected error: {err}");
        let _ = fs::remove_dir_all(&config_dir);
    }

    /// 联网测试（默认忽略）：真实下载上游 7z 并解出两份 DLL，校验架构与体积。
    /// 运行：`cargo test --lib texthook -- --ignored --nocapture`
    /// 本地已下载过 7z 时可用 `TEXTACTOR_TEXTHOOK_TEST_7Z` 跳过下载。
    #[test]
    #[ignore]
    fn downloads_and_extracts_upstream_archive() {
        let archive = match std::env::var("TEXTACTOR_TEXTHOOK_TEST_7Z") {
            Ok(path) => fs::read(path).expect("failed to read the archive"),
            Err(_) => {
                let release = fetch_release(None).expect("failed to query the release");
                println!("upstream tag: {} asset: {}", release.tag, release.asset.name);
                let headers = vec![format!("User-Agent: {USER_AGENT}")];
                http::http_request(
                    "GET",
                    &release.asset.browser_download_url,
                    &headers,
                    &[],
                    DOWNLOAD_TIMEOUT_MS,
                )
                .expect("download failed")
            }
        };
        assert_eq!(archive[..6], SEVENZ_MAGIC, "not a 7z payload");

        let (x64, x86) = extract_dlls(&archive).expect("extract failed");
        println!("x64: {} bytes, x86: {} bytes", x64.len(), x86.len());
        assert_eq!(pe_machine(&x64), Some(IMAGE_FILE_MACHINE_AMD64));
        assert_eq!(pe_machine(&x86), Some(IMAGE_FILE_MACHINE_I386));
        assert!(x64.len() > 100_000);
        assert!(x86.len() > 100_000);
    }

    /// 联网测试（默认忽略）：完整跑一遍「查上游 → 下载 → 解压 → 就地替换 → 记账 →
    /// 再检查（走缓存）」，目标用临时目录，不会碰真实的 texthook.dll。
    /// 这是最关键的一条端到端验证，运行：`cargo test --lib texthook -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn installs_from_upstream_into_temp_dir() {
        let root = temp_dir("textractor-texthook-install-test");
        let exe_dir = root.join("app");
        let config_dir = root.join("cfg");
        fs::create_dir_all(exe_dir.join(X86_DIR)).unwrap();
        fs::create_dir_all(&config_dir).unwrap();

        // 模拟安装包自带的旧版本 + 自带版本标记
        fs::write(exe_dir.join(DLL_NAME), b"bundled-old").unwrap();
        fs::write(exe_dir.join(X86_DIR).join(DLL_NAME), b"bundled-old").unwrap();
        fs::write(
            exe_dir.join(BUNDLED_META),
            r#"{"texthookTag":"v250101","texthookAsset":"texthook_250101_msvc22.7z"}"#,
        )
        .unwrap();
        assert_eq!(
            current_version(&exe_dir, &config_dir),
            (Some("v250101".to_string()), "bundled")
        );

        // 未指定 tag = 上游最新
        let result = install_with(None, None, &exe_dir, &config_dir).expect("install failed");
        println!(
            "installed {} (x64 {} bytes / x86 {} bytes)",
            result.tag, result.x64_bytes, result.x86_bytes
        );

        let x64 = fs::read(exe_dir.join(DLL_NAME)).unwrap();
        let x86 = fs::read(exe_dir.join(X86_DIR).join(DLL_NAME)).unwrap();
        assert_eq!(x64.len() as u64, result.x64_bytes);
        assert_eq!(x86.len() as u64, result.x86_bytes);
        assert_eq!(pe_machine(&x64), Some(IMAGE_FILE_MACHINE_AMD64));
        assert_eq!(pe_machine(&x86), Some(IMAGE_FILE_MACHINE_I386));
        // 替换用的临时文件不应残留
        assert!(!exe_dir.join(DLL_NAME).with_extension("dll.new").exists());

        // 记账写下来了，并且能被识别为“运行时更新过”
        assert_eq!(
            current_version(&exe_dir, &config_dir),
            (Some(result.tag.clone()), "installed")
        );
        // 再查一次（24h 缓存内，不联网）：应报告已是最新
        let check = check_with(&exe_dir, &config_dir, false).expect("check failed");
        assert!(check.cached, "expected a cached result");
        assert!(!check.has_update, "should be up to date after install");

        let _ = fs::remove_dir_all(&root);
    }
}
