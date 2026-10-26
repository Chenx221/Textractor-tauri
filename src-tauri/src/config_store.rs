//! `settings.json` 的读写、诊断日志与故障恢复。
//!
//! 起因：极低概率出现"启动后设置全部回到默认"，现有实现无法事后判断原因
//! （坏文件被改名成 `.bak` 后，`settings.json` 由前端用默认值重写，痕迹就没了）。
//!
//! 本模块的四个目标：
//!
//! 1. **每一次加载都留痕**：`config.log`（JSONL）记录路径、大小、修改/创建时间、
//!    SHA-256、解析结果，以及"上一次退出/保存时文件长什么样"。下次启动时据此
//!    直接判定这次读到的文件是"我们自己写的"还是"被外部动过的"。
//! 2. **写之前先保住上一份好配置**：`settings.json.bak` 只保存**能解析**的内容，
//!    另外按时间保留最近 [`HISTORY_KEEP`] 份快照到 `config-history/`。
//! 3. **不再静默重置**：读到坏文件 / 文件消失 / 读不出来时返回 `damaged`、
//!    `unreadable`，由前端弹窗让用户选恢复来源；用户确认之前前端一律不写盘。
//! 4. **运行时守护**：每 [`WATCH_INTERVAL_SECS`] 秒比对一次文件，发现"不是我们写的"
//!    变化立刻写日志（`external_change`），这样即使在运行中被外部工具改写也能定位。
//!
//! 日志/db 都在同一个配置目录（`app_config_dir()`）里，见 [`Paths`]。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};

use crate::crypto;

pub const CONFIG_FILE: &str = "settings.json";
pub const BACKUP_FILE: &str = "settings.json.bak";
pub const LOG_FILE: &str = "config.log";
pub const HISTORY_DIR: &str = "config-history";

/// 日志上限，超过就滚一份成 `config.log.1`（只留一份历史，够用且不会无限增长）。
const LOG_MAX_BYTES: u64 = 512 * 1024;
/// 历史快照保留份数。
const HISTORY_KEEP: usize = 20;
/// 守护线程的轮询间隔。
const WATCH_INTERVAL_SECS: u64 = 5;

/// 写盘互斥：`save` 与守护线程共用，避免守护线程把刚写下的内容误判成外部改动。
static FILE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
/// 本进程最后一次成功写入的内容指纹（sha256 前 16 个十六进制字符）。
static LAST_WRITTEN: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

// ---------------------------------------------------------------- 路径 ----

/// 配置目录里的几个固定位置，前后端都用它，避免"路径写死在两个地方"。
#[derive(Serialize)]
pub struct Paths {
    pub config: String,
    pub backup: String,
    pub log: String,
    pub dir: String,
    pub history_dir: String,
}

pub fn paths(config_path: &Path) -> Paths {
    Paths {
        config: config_path.display().to_string(),
        backup: backup_path(config_path).display().to_string(),
        log: log_path_for(config_path).display().to_string(),
        dir: config_path
            .parent()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        history_dir: history_dir(config_path).display().to_string(),
    }
}

fn backup_path(config_path: &Path) -> PathBuf {
    config_path.with_file_name(BACKUP_FILE)
}

fn log_path_for(config_path: &Path) -> PathBuf {
    config_path.with_file_name(LOG_FILE)
}

fn history_dir(config_path: &Path) -> PathBuf {
    config_path.with_file_name(HISTORY_DIR)
}

// ------------------------------------------------------------ 时间戳 ----

/// 本地时间 `YYYY-MM-DDTHH:MM:SS.mmm`（Windows 走 `GetLocalTime`；其它平台退回 Unix 秒）。
pub(crate) fn now_stamp() -> String {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::SYSTEMTIME;
        use windows_sys::Win32::System::SystemInformation::GetLocalTime;

        let mut t: SYSTEMTIME = unsafe { std::mem::zeroed() };
        unsafe { GetLocalTime(&mut t) };
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}",
            t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("unix:{}", unix_now())
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 文件名里用的时间戳（Windows 不允许 `:`）。
fn stamp_file() -> String {
    now_stamp().replace(':', "-")
}

fn to_unix(t: SystemTime) -> Option<u64> {
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())
}

/// 本地日期（`YYYY-MM-DD`）。Windows 用 `GetLocalTime`；其它平台退回 UTC。
///
/// 从 `lib.rs` 移到这里，供坏文件备份命名使用（测试仍在 `lib.rs` 里）。
#[cfg(target_os = "windows")]
pub(crate) fn local_date() -> String {
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;

    let mut now: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut now) };
    format!("{:04}-{:02}-{:02}", now.wYear, now.wMonth, now.wDay)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn local_date() -> String {
    // Howard Hinnant 的 civil_from_days：把 Unix 天数换算成公历日期。
    let secs = unix_now();
    let days = (secs / 86_400) as i64;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 };
    format!("{year:04}-{month:02}-{day:02}")
}

// ------------------------------------------------------------- 校验 ----

fn sha(data: &[u8]) -> String {
    let digest = crypto::sha256_digest(data);
    let mut out = String::with_capacity(16);
    for b in digest.iter().take(8) {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// 只做"会不会让前端崩掉"的形状检查，别的一律交给 `mergeConfig` 补默认值。
///
/// `mergeConfig` 里会 `.filter()` / 遍历 `extensions`，这一项坏掉就是未捕获异常
/// ——异常之后前端既不会用上配置、也永远不会再保存，看起来就是"设置再也不生效"。
fn check_shape(v: &Value) -> Result<(), String> {
    let obj = v.as_object().ok_or("顶层不是 JSON 对象")?;
    if let Some(ext) = obj.get("extensions") {
        let arr = ext.as_array().ok_or("extensions 不是数组")?;
        for (i, item) in arr.iter().enumerate() {
            let o = item
                .as_object()
                .ok_or_else(|| format!("extensions[{i}] 不是对象"))?;
            if let Some(settings) = o.get("settings") {
                if !settings.is_object() {
                    return Err(format!("extensions[{i}].settings 不是对象"));
                }
            }
        }
    }
    Ok(())
}

fn parse_config(bytes: &[u8]) -> Result<Value, (&'static str, String)> {
    if bytes.is_empty() {
        return Err(("invalid_json", "文件是 0 字节".to_string()));
    }
    let value: Value =
        serde_json::from_slice(bytes).map_err(|e| ("invalid_json", e.to_string()))?;
    if !value.is_object() {
        return Err(("not_object", "顶层不是 JSON 对象".to_string()));
    }
    check_shape(&value).map_err(|e| ("bad_shape", e))?;
    Ok(value)
}

// --------------------------------------------------------- 文件快照 ----

/// 某一时刻磁盘上 `settings.json` 的样子，也用来描述备份/历史快照。
#[derive(Serialize, Clone, Default)]
pub struct FileState {
    pub exists: bool,
    pub len: u64,
    /// 修改时间（Unix 秒，0 = 未知），前端负责格式化。
    pub mtime: u64,
    /// 创建时间（Unix 秒）。Windows 上"删除后重建"会换一个新的创建时间。
    pub created: u64,
    pub sha: String,
    /// missing | unreadable | invalid_json | not_object | bad_shape | ok
    pub parse: String,
    /// 解析失败的原因（给用户看）。
    pub reason: String,
}

fn inspect(path: &Path) -> FileState {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => {
            return FileState {
                parse: "missing".to_string(),
                ..Default::default()
            }
        }
    };
    let mtime = meta.modified().ok().and_then(to_unix).unwrap_or(0);
    let created = meta.created().ok().and_then(to_unix).unwrap_or(0);
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            return FileState {
                exists: true,
                len: meta.len(),
                mtime,
                created,
                sha: String::new(),
                parse: "unreadable".to_string(),
                reason: e.to_string(),
            }
        }
    };
    let mut state = FileState {
        exists: true,
        len: bytes.len() as u64,
        mtime,
        created,
        sha: sha(&bytes),
        parse: "ok".to_string(),
        reason: String::new(),
    };
    if let Err((kind, reason)) = parse_config(&bytes) {
        state.parse = kind.to_string();
        state.reason = reason;
    }
    state
}

// ------------------------------------------------------------- 日志 ----

/// 追加一行 JSONL 诊断日志。失败一律忽略（诊断不能反过来影响功能）。
pub(crate) fn append_log(path: &Path, event: &str, win: &str, extra: Value) {
    let mut obj = match extra {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    obj.insert("t".to_string(), Value::String(now_stamp()));
    obj.insert("ts".to_string(), json!(unix_now()));
    obj.insert("ev".to_string(), Value::String(event.to_string()));
    if !win.is_empty() {
        obj.insert("win".to_string(), Value::String(win.to_string()));
    }
    obj.insert("pid".to_string(), json!(std::process::id()));

    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > LOG_MAX_BYTES {
            let _ = std::fs::rename(path, path.with_extension("log.1"));
        }
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = file.write_all(format!("{}\n", Value::Object(obj)).as_bytes());
        let _ = file.flush();
    }
}

/// 日志里最近一条"内容可追溯"的记录（save 成功 / exit / restore）。
fn last_content_event(log_path: &Path) -> (Option<Value>, Option<Value>) {
    let text = std::fs::read_to_string(log_path).unwrap_or_default();
    let mut content: Option<Value> = None;
    let mut exit: Option<Value> = None;
    for line in text.lines().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match v.get("ev").and_then(|e| e.as_str()) {
            Some("exit") => {
                if content.is_none() {
                    content = Some(v.clone());
                }
                if exit.is_none() {
                    exit = Some(v);
                }
            }
            Some("save")
                if content.is_none() && v.get("ok").and_then(|b| b.as_bool()) == Some(true) =>
            {
                content = Some(v);
            }
            Some("restore") if content.is_none() => {
                content = Some(v);
            }
            _ => {}
        }
        if content.is_some() && exit.is_some() {
            break;
        }
    }
    (content, exit)
}

/// 这次启动读到的文件，和日志里最后一次记录相比是什么关系。
///
/// 这是"到底谁的锅"的关键判定：
/// - `clean`：和上次退出/保存时一模一样 → 文件没被动过；
/// - `missing_after_exit`：上次退出时还在，现在没了 → 被外部删除；
/// - `modified_while_closed`：内容变了但还能解析 → 被外部改写（或被旧版本覆盖）；
/// - `external_corruption`：内容变了且解析不了 → 外部损坏，不是我们写的。
fn verdict_for(log_path: &Path, file: &FileState) -> (String, String) {
    let (content, _exit) = last_content_event(log_path);
    let Some(last) = content else {
        return (
            "unknown".to_string(),
            "日志里没有更早的记录（第一次运行带日志的版本）".to_string(),
        );
    };
    let prev_sha = last
        .get("sha")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let prev_len = last.get("len").and_then(|s| s.as_u64()).unwrap_or(0);
    let prev_ts = last.get("ts").and_then(|s| s.as_u64()).unwrap_or(0);
    let when = last
        .get("t")
        .and_then(|s| s.as_str())
        .unwrap_or("未知时间")
        .to_string();

    if !file.exists {
        return (
            "missing_after_exit".to_string(),
            format!("上次记录（{when}）时文件有 {prev_len} 字节（{prev_sha}），现在文件不存在。"),
        );
    }
    let recreated = if prev_ts > 0 && file.created > prev_ts + 2 {
        "；文件创建时间晚于上次记录，说明它被删除后重建过"
    } else {
        ""
    };
    if prev_sha != file.sha {
        if file.parse == "ok" {
            return (
                "modified_while_closed".to_string(),
                format!(
                    "配置在本次启动前被外部改动过：{when} 时是 {prev_len} 字节（{prev_sha}），现在是 {} 字节（{}）{}。",
                    file.len, file.sha, recreated
                ),
            );
        }
        return (
            "external_corruption".to_string(),
            format!(
                "配置在本次启动前被外部改动，且现在无法解析（{}）：{when} 时是 {prev_len} 字节（{prev_sha}），现在是 {} 字节（{}）{}。",
                file.reason, file.len, file.sha, recreated
            ),
        );
    }
    (
        "clean".to_string(),
        format!("与上次记录（{when}）完全一致（{} 字节）。", file.len),
    )
}

// ------------------------------------------------------------- 写盘 ----

/// 原子写：写临时文件 → `FlushFileBuffers` → `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`。
///
/// 少了 `sync_all` 这一句，断电/蓝屏时 NTFS 可能只提交了"改名"的元数据而没提交内容，
/// 于是 `settings.json` 变成一个 0 字节文件 —— 这正是"配置全丢"最典型的来源。
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}.{}.tmp", std::process::id(), seq));
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    #[cfg(target_os = "windows")]
    {
        if let Err(err) = replace_file(&tmp, path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(err);
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    std::fs::rename(&tmp, path)
}

#[cfg(target_os = "windows")]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let wide = |p: &Path| -> Vec<u16> {
        p.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let (src, dst) = (wide(from), wide(to));
    let ok = unsafe {
        MoveFileExW(
            src.as_ptr(),
            dst.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// 把当前文件当作"上一份好配置"存下来（只有能解析时才收），并留一份历史快照。
fn rotate(config_path: &Path, next: &[u8]) {
    let current = match std::fs::read(config_path) {
        Ok(b) => b,
        Err(_) => return,
    };
    if current == next || parse_config(&current).is_err() {
        return;
    }
    let _ = write_atomic(&backup_path(config_path), &current);
    save_history(config_path, &current);
}

fn save_history(config_path: &Path, bytes: &[u8]) {
    let dir = history_dir(config_path);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let name = format!("{}_{}.json", stamp_file(), sha(bytes));
    let _ = write_atomic(&dir.join(name), bytes);
    prune_history(&dir);
}

fn prune_history(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
        .filter(|n| n.ends_with(".json"))
        .collect();
    if names.len() <= HISTORY_KEEP {
        return;
    }
    names.sort();
    let drop_count = names.len() - HISTORY_KEEP;
    for name in names.into_iter().take(drop_count) {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

/// 把损坏的配置文件改名为 `原名.<日期>.bak`（当日重名追加序号），返回备份路径。
///
/// 仍然保留原行为：**先把坏文件挪走**，这样后续用默认值重写时不会覆盖掉证据。
pub(crate) fn backup_corrupt_config(path: &Path) -> Option<PathBuf> {
    if !path.is_file() {
        return None;
    }
    let file_name = path.file_name()?.to_string_lossy().to_string();
    let dir = path.parent()?;
    let stamp = local_date();
    let mut candidate = dir.join(format!("{file_name}.{stamp}.bak"));
    let mut index = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{file_name}.{stamp}-{index}.bak"));
        index += 1;
    }
    std::fs::rename(path, &candidate).ok().map(|()| candidate)
}

// ------------------------------------------------------- 保存 / 恢复 ----

pub(crate) fn save(config_path: &Path, config: &Value, win: &str) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    let digest = sha(&content);
    let log_path = log_path_for(config_path);
    // 顺带记一下"这份配置里有多少扩展"，日志里一眼就能看出是不是被清空了。
    let ext_count = config
        .get("extensions")
        .and_then(|e| e.as_array())
        .map(|a| a.len())
        .unwrap_or(0);

    let _guard = FILE_LOCK.lock();
    rotate(config_path, &content);
    match write_atomic(config_path, &content) {
        Ok(()) => {
            if let Ok(mut last) = LAST_WRITTEN.lock() {
                *last = Some(digest.clone());
            }
            append_log(
                &log_path,
                "save",
                win,
                json!({ "ok": true, "len": content.len(), "sha": digest, "ext": ext_count }),
            );
            Ok(())
        }
        Err(err) => {
            append_log(
                &log_path,
                "save",
                win,
                json!({ "ok": false, "len": content.len(), "ext": ext_count, "err": err.to_string() }),
            );
            Err(format!("保存配置失败：{err}"))
        }
    }
}

/// 从备份或历史快照恢复，返回恢复后的配置对象。
pub(crate) fn restore(config_path: &Path, source: &str, win: &str) -> Result<Value, String> {
    let bytes = if source == "backup" {
        std::fs::read(backup_path(config_path)).map_err(|e| format!("读取备份失败：{e}"))?
    } else if let Some(name) = source.strip_prefix("history:") {
        if name.contains('/') || name.contains('\\') || name.contains("..") {
            return Err("非法的历史快照名".to_string());
        }
        std::fs::read(history_dir(config_path).join(name))
            .map_err(|e| format!("读取历史快照失败：{e}"))?
    } else {
        return Err(format!("未知的恢复来源：{source}"));
    };

    let value = parse_config(&bytes).map_err(|(_, reason)| format!("恢复源本身不可用：{reason}"))?;
    let content = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    let digest = sha(&content);

    let _guard = FILE_LOCK.lock();
    rotate(config_path, &content);
    write_atomic(config_path, &content).map_err(|e| format!("写入配置失败：{e}"))?;
    if let Ok(mut last) = LAST_WRITTEN.lock() {
        *last = Some(digest.clone());
    }
    append_log(
        &log_path_for(config_path),
        "restore",
        win,
        json!({ "source": source, "len": content.len(), "sha": digest }),
    );
    Ok(value)
}

// --------------------------------------------------------- 结构定义 ----

#[derive(Serialize)]
pub struct BackupInfo {
    /// 备份可用（存在且能解析）时才为 true。
    pub exists: bool,
    pub len: u64,
    /// 备份文件的修改时间（Unix 秒，前端负责格式化）。
    pub mtime: u64,
    pub parse: String,
}

#[derive(Serialize)]
pub struct HistoryEntry {
    pub name: String,
    pub stamp: String,
    pub len: u64,
    pub parse: String,
}

#[derive(Serialize)]
pub struct ConfigLoad {
    /// ok | first_run | recovered | damaged | unreadable
    pub status: String,
    pub config: Option<Value>,
    pub detail: String,
    pub path: String,
    pub log_path: String,
    pub file: FileState,
    pub backup: BackupInfo,
    pub history: Vec<HistoryEntry>,
    pub verdict: String,
    pub verdict_detail: String,
}

fn backup_info(config_path: &Path) -> BackupInfo {
    let state = inspect(&backup_path(config_path));
    BackupInfo {
        exists: state.exists && state.parse == "ok",
        len: state.len,
        mtime: state.mtime,
        parse: state.parse,
    }
}

fn history_entries(config_path: &Path) -> Vec<HistoryEntry> {
    let dir = history_dir(config_path);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    names.reverse();
    names
        .into_iter()
        .take(10)
        .map(|name| {
            let state = inspect(&dir.join(&name));
            let stamp = name.split('_').next().unwrap_or(&name).replace('T', " ");
            HistoryEntry {
                name,
                stamp,
                len: state.len,
                parse: state.parse,
            }
        })
        .collect()
}

// -------------------------------------------------------------- 命令 ----

/// 读取配置。
///
/// 与旧实现的区别：**读到坏文件/文件消失时不会自己重置**，而是把判定和可恢复的
/// 来源一起返回，由前端弹窗让用户确认。只有"确实没有配置文件且从没有过记录"才
/// 按首次运行处理。
#[tauri::command]
pub fn load_config(
    window: tauri::WebviewWindow,
    state: tauri::State<crate::AppState>,
) -> Result<ConfigLoad, String> {
    let win = window.label().to_string();
    let is_main = win == "main";
    let config_path = state.config_path.clone();
    let log_path = log_path_for(&config_path);

    let file = inspect(&config_path);
    let (verdict, verdict_detail) = verdict_for(&log_path, &file);

    append_log(
        &log_path,
        "load",
        &win,
        json!({
            "path": config_path.display().to_string(),
            "exists": file.exists,
            "len": file.len,
            "mtime": file.mtime,
            "created": file.created,
            "sha": file.sha,
            "parse": file.parse,
            "reason": file.reason,
            "verdict": verdict,
        }),
    );

    let mut status = "ok";
    let mut detail = String::new();
    let mut config: Option<Value> = None;

    match file.parse.as_str() {
        "ok" => {
            // 再读一遍是为了拿到真正的对象；这一遍失败说明文件在两次读取之间被改动，
            // 此时**绝不能**按"正常"返回，否则前端会拿默认值继续并写盘。
            match std::fs::read(&config_path)
                .map_err(|e| e.to_string())
                .and_then(|b| parse_config(&b).map_err(|(_, reason)| reason))
            {
                Ok(value) => config = Some(value),
                Err(reason) => {
                    status = "damaged";
                    detail = format!("配置文件在读取过程中发生了变化：{reason}");
                }
            }
        }
        "missing" => {
            // 有上一份好配置就直接恢复，不拿"默认值"覆盖用户的世界。
            if is_main && backup_info(&config_path).exists {
                match restore(&config_path, "backup", &win) {
                    Ok(value) => {
                        config = Some(value);
                        status = "recovered";
                        detail = "启动时没有找到 settings.json，已从备份恢复。".to_string();
                    }
                    Err(err) => {
                        status = "damaged";
                        detail = format!("配置文件不存在，且从备份恢复失败：{err}");
                    }
                }
            } else if verdict == "missing_after_exit" {
                // 上次退出时还在、现在没了，又没有备份可用 —— 必须让用户知道。
                status = "damaged";
                detail = "配置文件在本次启动前被删除（上次退出时它还在），且没有可用备份。".to_string();
            } else {
                status = "first_run";
                detail = "没有找到配置文件（首次运行）。".to_string();
            }
        }
        "unreadable" => {
            status = "unreadable";
            detail = format!("配置文件无法读取：{}", file.reason);
        }
        _ => {
            status = "damaged";
            detail = format!("配置文件无法解析：{}", file.reason);
            if is_main {
                if let Some(kept) = backup_corrupt_config(&config_path) {
                    append_log(
                        &log_path,
                        "damaged_kept",
                        &win,
                        json!({ "kept": kept.display().to_string() }),
                    );
                }
            }
        }
    }

    let backup = backup_info(&config_path);
    Ok(ConfigLoad {
        status: status.to_string(),
        config,
        detail,
        path: config_path.display().to_string(),
        log_path: log_path.display().to_string(),
        file,
        backup,
        history: history_entries(&config_path),
        verdict,
        verdict_detail,
    })
}

/// 写入配置。只有主窗口会真正落盘（副窗口只读，避免两个写者互相覆盖）。
#[tauri::command]
pub fn save_config(
    window: tauri::WebviewWindow,
    state: tauri::State<crate::AppState>,
    config: Value,
) -> Result<(), String> {
    let win = window.label().to_string();
    if win != "main" {
        return Ok(());
    }
    save(&state.config_path, &config, &win)
}

/// 用户明确选择"放弃现有配置、用默认值"：把现有文件另存，之后前端写入默认值。
#[tauri::command]
pub fn config_accept_defaults(
    window: tauri::WebviewWindow,
    state: tauri::State<crate::AppState>,
) -> Result<(), String> {
    let win = window.label().to_string();
    if win != "main" {
        return Ok(());
    }
    let config_path = &state.config_path;
    let log_path = log_path_for(config_path);
    let kept = if config_path.is_file() {
        backup_corrupt_config(config_path)
    } else {
        None
    };
    append_log(
        &log_path,
        "accept_defaults",
        &win,
        json!({ "kept": kept.as_ref().map(|p| p.display().to_string()) }),
    );
    Ok(())
}

/// 从 `backup` 或 `history:<文件名>` 恢复配置。
#[tauri::command]
pub fn config_restore(
    window: tauri::WebviewWindow,
    state: tauri::State<crate::AppState>,
    source: String,
) -> Result<Value, String> {
    let win = window.label().to_string();
    if win != "main" {
        return Err("只有主窗口可以恢复配置".to_string());
    }
    restore(&state.config_path, &source, &win)
}

/// 最近的日志行（默认 300），供界面里的"配置日志"窗口展示。
#[tauri::command]
pub fn config_log_tail(state: tauri::State<crate::AppState>, lines: Option<u32>) -> Vec<String> {
    let path = log_path_for(&state.config_path);
    let limit = lines.unwrap_or(300).clamp(1, 5000) as usize;
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(limit);
    all[start..].iter().map(|l| l.to_string()).collect()
}

/// 配置相关的几个路径（设置界面里"打开配置目录"用）。
#[tauri::command]
pub fn config_paths(state: tauri::State<crate::AppState>) -> Paths {
    paths(&state.config_path)
}

/// 退出时留一条记录：退出瞬间文件是什么样，供下次启动比对。
pub fn log_exit(config_path: &Path, win: &str) {
    let state = inspect(config_path);
    append_log(
        &log_path_for(config_path),
        "exit",
        win,
        json!({
            "exists": state.exists,
            "len": state.len,
            "mtime": state.mtime,
            "sha": state.sha,
            "parse": state.parse,
        }),
    );
}

/// 启动时留一条记录：版本 / 进程 / 目录 / 文件现状。
pub fn log_start(config_path: &Path, version: &str) {
    let state = inspect(config_path);
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    append_log(
        &log_path_for(config_path),
        "start",
        "main",
        json!({
            "version": version,
            "exe": exe,
            "user": std::env::var("USERNAME").unwrap_or_default(),
            "dir": config_path.parent().map(|p| p.display().to_string()).unwrap_or_default(),
            "exists": state.exists,
            "len": state.len,
            "sha": state.sha,
            "parse": state.parse,
        }),
    );
}

/// 守护线程：文件变了但不是我们写的，就记一条 `external_change`。
///
/// 有了它，"运行中被杀软/同步盘/清理工具改写"这类事故会直接留下时间点。
pub fn start_watchdog(config_path: PathBuf) {
    std::thread::spawn(move || {
        let log_path = log_path_for(&config_path);
        let mut last_len = 0u64;
        let mut last_mtime = 0u64;
        let mut primed = false;
        loop {
            std::thread::sleep(Duration::from_secs(WATCH_INTERVAL_SECS));
            let guard = FILE_LOCK.lock();
            let state = inspect(&config_path);
            if !primed {
                last_len = state.len;
                last_mtime = state.mtime;
                primed = true;
                drop(guard);
                continue;
            }
            if state.len != last_len || state.mtime != last_mtime {
                let ours = LAST_WRITTEN.lock().ok().and_then(|l| l.clone());
                if ours.as_deref() != Some(state.sha.as_str()) {
                    append_log(
                        &log_path,
                        "external_change",
                        "watch",
                        json!({
                            "exists": state.exists,
                            "len": state.len,
                            "mtime": state.mtime,
                            "sha": state.sha,
                            "parse": state.parse,
                            "ours": ours,
                        }),
                    );
                }
                last_len = state.len;
                last_mtime = state.mtime;
            }
            drop(guard);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "textractor-config-{}-{}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).expect("read file")).expect("parse json")
    }

    /// 保存两次后，`settings.json.bak` 必须是**上一份能解析的内容**。
    #[test]
    fn save_rotates_previous_good_config_into_backup() {
        let dir = tmp_dir("rotate");
        let path = dir.join(CONFIG_FILE);
        save(&path, &json!({ "language": "zh-CN" }), "main").unwrap();
        save(&path, &json!({ "language": "en" }), "main").unwrap();

        assert_eq!(read_json(&path)["language"], "en");
        assert_eq!(
            read_json(&backup_path(&path))["language"],
            "zh-CN",
            "备份里应该是上一份配置"
        );
        let history = history_entries(&path);
        assert!(!history.is_empty(), "应该留下历史快照");
        assert_eq!(history[0].parse, "ok");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 当前文件是坏的时候，**绝不能**把它写进备份（否则就再没有好副本可救了）。
    #[test]
    fn corrupt_current_file_is_never_used_as_backup() {
        let dir = tmp_dir("corrupt");
        let path = dir.join(CONFIG_FILE);
        save(&path, &json!({ "language": "zh-CN" }), "main").unwrap();
        save(&path, &json!({ "language": "en" }), "main").unwrap();
        let good = std::fs::read(backup_path(&path)).unwrap();

        std::fs::write(&path, b"{ this is not json").unwrap();
        save(&path, &json!({ "language": "en" }), "main").unwrap();

        assert_eq!(
            good,
            std::fs::read(backup_path(&path)).unwrap(),
            "坏文件不应该覆盖上一份好备份"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 从备份恢复：内容回到上一份，日志里留下 `restore`。
    #[test]
    fn restore_from_backup_rewrites_config() {
        let dir = tmp_dir("restore");
        let path = dir.join(CONFIG_FILE);
        save(&path, &json!({ "language": "zh-CN" }), "main").unwrap();
        save(&path, &json!({ "language": "en" }), "main").unwrap();

        let restored = restore(&path, "backup", "main").unwrap();
        assert_eq!(restored["language"], "zh-CN");
        assert_eq!(read_json(&path)["language"], "zh-CN");

        let log = std::fs::read_to_string(log_path_for(&path)).unwrap();
        assert!(log.contains("\"ev\":\"restore\""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 判定：文件被外部改写 / 被删除，都要能被认出来（这正是"查原因"的关键）。
    #[test]
    fn verdict_detects_external_changes() {
        let dir = tmp_dir("verdict");
        let path = dir.join(CONFIG_FILE);
        let log = log_path_for(&path);
        save(&path, &json!({ "language": "zh-CN" }), "main").unwrap();

        // 启动前被外部改写
        std::fs::write(&path, br#"{"language":"en"}"#).unwrap();
        let (verdict, detail) = verdict_for(&log, &inspect(&path));
        assert_eq!(verdict, "modified_while_closed", "{detail}");

        // 启动前被删掉
        std::fs::remove_file(&path).unwrap();
        let (verdict, detail) = verdict_for(&log, &inspect(&path));
        assert_eq!(verdict, "missing_after_exit", "{detail}");

        // 没被动过
        let dir2 = tmp_dir("verdict-clean");
        let path2 = dir2.join(CONFIG_FILE);
        save(&path2, &json!({ "language": "zh-CN" }), "main").unwrap();
        let (verdict, _) = verdict_for(&log_path_for(&path2), &inspect(&path2));
        assert_eq!(verdict, "clean");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    /// 形状检查只拦"会让前端崩掉"的东西，不拦别的。
    #[test]
    fn shape_check_only_rejects_crashy_shapes() {
        assert!(check_shape(&json!({})).is_ok());
        assert!(check_shape(&json!({ "extensions": [] })).is_ok());
        assert!(check_shape(&json!({ "extensions": [{ "id": "a", "settings": {} }] })).is_ok());
        // mergeConfig 里 `.filter()` / `ext.kind` 会直接抛异常的形状
        assert!(check_shape(&json!({ "extensions": {} })).is_err());
        assert!(check_shape(&json!({ "extensions": [null] })).is_err());
        assert!(check_shape(&json!({ "extensions": [{ "settings": "x" }] })).is_err());
        // 顶层不是对象
        assert!(check_shape(&json!([])).is_err());
    }

    /// 0 字节文件按"损坏"处理，而不是"没有配置"（避免静默走默认值）。
    #[test]
    fn empty_file_is_classified_as_corrupt() {
        let dir = tmp_dir("empty");
        let path = dir.join(CONFIG_FILE);
        std::fs::write(&path, b"").unwrap();
        assert_eq!(inspect(&path).parse, "invalid_json");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
