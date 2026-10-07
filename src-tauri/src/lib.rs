use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::Manager;

mod proto;
mod hookcode;
mod saved;
mod windowfx;
mod ws;
mod crypto;

#[cfg(target_os = "windows")]
mod host;
#[cfg(target_os = "windows")]
mod clipboard;
#[cfg(target_os = "windows")]
mod icons;
#[cfg(target_os = "windows")]
mod http;
#[cfg(target_os = "windows")]
mod translate;
#[cfg(target_os = "windows")]
mod romanji;
#[cfg(target_os = "windows")]
mod romanji_dict;
#[cfg(target_os = "windows")]
mod texthook;

/// 非 Windows 平台占位：保持命令与前端调用签名一致。
#[cfg(not(target_os = "windows"))]
mod romanji_dict {
    use super::RomanjiDictStatus;

    pub fn status(_app: &tauri::AppHandle) -> Result<RomanjiDictStatus, String> {
        Err("Romanji dictionary is only supported on Windows.".to_string())
    }

    pub fn install(_app: &tauri::AppHandle) -> Result<(), String> {
        Err("Romanji dictionary is only supported on Windows.".to_string())
    }

    pub fn uninstall(_app: &tauri::AppHandle) -> Result<(), String> {
        Err("Romanji dictionary is only supported on Windows.".to_string())
    }
}

/// 非 Windows 平台占位：保持命令与前端调用签名一致。
#[cfg(not(target_os = "windows"))]
mod texthook {
    use super::{TexthookCheck, TexthookStatus, TexthookUpdateResult};

    fn unsupported<T>() -> Result<T, String> {
        Err("texthook runtime update is only supported on Windows.".to_string())
    }

    pub fn status(_app: &tauri::AppHandle) -> Result<TexthookStatus, String> {
        unsupported()
    }

    pub fn check(_app: &tauri::AppHandle, _force: bool) -> Result<TexthookCheck, String> {
        unsupported()
    }

    pub fn install(
        _app: &tauri::AppHandle,
        _tag: Option<String>,
    ) -> Result<TexthookUpdateResult, String> {
        unsupported()
    }
}

/// texthook 当前状态（前端面板用）。
#[derive(Serialize)]
pub struct TexthookStatus {
    /// exe 所在目录。
    pub dir: String,
    /// x64 texthook.dll 的完整路径。
    pub dll_path: String,
    /// x86 texthook.dll 的完整路径。
    pub x86_dll_path: String,
    /// 当前生效的版本 tag（无法判断时为 null）。
    pub tag: Option<String>,
    /// `installed`（运行时更新过）/ `bundled`（随程序自带）/ `unknown`。
    pub source: String,
    /// exe 目录（含 x86 子目录）是否可写；false 表示更新需要管理员权限。
    pub writable: bool,
    /// 上次检查到的上游 tag（不联网，来自缓存）。
    pub upstream_tag: Option<String>,
    /// 上次检查时间（Unix 秒）。
    pub last_check: u64,
}

/// 上游 texthook 的检查结果。
#[derive(Serialize)]
pub struct TexthookCheck {
    /// 上游最新 tag。
    pub tag: String,
    /// 选中的资产名。
    pub asset: String,
    /// 资产大小（字节；命中缓存时为 0）。
    pub size: u64,
    /// 资产下载地址（命中缓存时为空）。
    pub url: String,
    /// 当前生效版本。
    pub current_tag: Option<String>,
    /// 是否需要更新。
    pub has_update: bool,
    /// release notes（截断）。
    pub notes: String,
    /// 结果来自 24h 缓存（未联网）。
    pub cached: bool,
    /// exe 目录是否可写。
    pub writable: bool,
}

/// texthook 更新结果。
#[derive(Serialize)]
pub struct TexthookUpdateResult {
    pub tag: String,
    pub x64_bytes: u64,
    pub x86_bytes: u64,
    pub dll_path: String,
    pub x86_dll_path: String,
}

struct AppState {
    config_path: std::path::PathBuf,
    db: Arc<Mutex<Connection>>,
}

#[derive(Serialize)]
struct SystemInfo {
    is_admin: bool,
    bitness: String,
}

/// 罗马音词典状态（前端据此显示是否已安装 / 体积 / 目录）。
#[derive(Serialize)]
pub struct RomanjiDictStatus {
    pub installed: bool,
    pub path: String,
    pub size_bytes: u64,
    pub version: String,
    /// 已安装但版本与应用所需的词典版本不一致（需重新下载）。
    pub outdated: bool,
    /// 已安装但加载失败的原因（格式不匹配/文件损坏等）。
    pub load_error: Option<String>,
    /// 自定义词典（txt）路径；词典目录未初始化时为 `None`。
    pub user_dict_path: Option<String>,
    /// 自定义词典文件是否已存在。
    pub user_dict_exists: bool,
    /// 自定义词典中生效的词条数。
    pub user_dict_entries: usize,
    /// 自定义词典解析/加载失败的原因。
    pub user_dict_error: Option<String>,
}

#[derive(Serialize)]
struct BuildInfo {
    profile: String,
    version: String,
    arch: String,
    /// 编译时刻（本地时区），形如 `2026-09-30 01:54:03 +08:00`（由 build.rs 注入）。
    built_at: String,
    /// WebView2 运行时（Chromium 内核）版本；非 Windows 或读取失败时为空串。
    webview: String,
}

#[derive(Serialize)]
struct ProcessInfo {
    pid: u32,
    name: String,
    title: String,
    arch: String,
    has_file: bool,
    is_system: bool,
    icon: Option<String>,
}

#[derive(Serialize)]
pub struct HookInfo {
    pub code: String,
    pub address: u64,
    pub is_engine: bool,
    pub name: String,
}

#[derive(Deserialize, Clone, Copy)]
pub struct ThreadSettings {
    pub filter_repetition: bool,
    pub flush_delay_spacing: i32,
    pub flush_delay_ms: u64,
    pub max_buffer: usize,
    pub limit_string_length: usize,
}

/// 保存 hook 时附带的当前查看线程（非控制台/剪贴板），用于自动附加后切换回该线程。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedThreadInput {
    pub ctx: u64,
    pub ctx2: u64,
    pub code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParamInput {
    #[serde(default)]
    pub text: String,
    #[serde(default = "default_codepage")]
    pub codepage: i32,
    #[serde(default)]
    pub pattern: String,
    #[serde(default)]
    pub offset: i32,
    #[serde(default = "default_search_time")]
    pub search_time: i32,
    #[serde(default = "default_max_records")]
    pub max_records: i32,
    #[serde(default)]
    pub module: String,
}

fn default_codepage() -> i32 {
    932
}
fn default_search_time() -> i32 {
    30_000
}
fn default_max_records() -> i32 {
    100_000
}

fn parse_hex_pattern(s: &str) -> Vec<u8> {
    let normalized = s.replace("??", "11");
    let hex: String = normalized.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    (0..hex.len())
        .step_by(2)
        .filter_map(|i| {
            let end = (i + 2).min(hex.len());
            u8::from_str_radix(&hex[i..end], 16).ok()
        })
        .collect()
}

fn to_search_param(input: SearchParamInput) -> proto::SearchParam {
    let mut sp = proto::SearchParam::default();
    sp.codepage = input.codepage;
    sp.offset = input.offset;
    sp.search_time = input.search_time;
    sp.max_records = input.max_records;

    if !input.text.is_empty() {
        sp.text = input.text;
    }
    if !input.pattern.is_empty() {
        let bytes = parse_hex_pattern(&input.pattern);
        let n = bytes.len().min(proto::PATTERN_SIZE);
        sp.pattern[..n].copy_from_slice(&bytes[..n]);
        sp.length = n as i32;
    }
    if !input.module.is_empty() {
        sp.boundary_module = input.module;
    }
    sp
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn get_system_info() -> SystemInfo {
    SystemInfo {
        is_admin: is_admin(),
        bitness: current_bitness(),
    }
}

#[tauri::command]
fn get_build_info() -> BuildInfo {
    BuildInfo {
        profile: if cfg!(debug_assertions) { "debug".to_string() } else { "release".to_string() },
        version: env!("CARGO_PKG_VERSION").to_string(),
        arch: std::env::consts::ARCH.to_string(),
        built_at: env!("BUILD_TIME").to_string(),
        webview: tauri::webview_version().unwrap_or_default(),
    }
}

#[tauri::command]
fn open_devtools(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.open_devtools();
        Ok(())
    } else {
        Err("Main window not found.".to_string())
    }
}

/// 切换无边框悬浮窗（extra window）的显示状态，返回切换后是否可见。
#[tauri::command]
fn toggle_extra_window(app: tauri::AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window("extra")
        .ok_or_else(|| "Extra window not found.".to_string())?;
    let visible = window.is_visible().map_err(|e| e.to_string())?;
    if visible {
        window.hide().map_err(|e| e.to_string())?;
    } else {
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(!visible)
}

/// 隐藏无边框悬浮窗（由悬浮窗自身的关闭按钮调用）。
#[tauri::command]
fn hide_extra_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("extra") {
        let _ = window.hide();
    }
}

/// 为指定窗口应用原生背景效果（none/aero/acrylic/mica）。
#[tauri::command]
fn set_window_effect(
    app: tauri::AppHandle,
    label: String,
    effect: String,
    dark: bool,
    tint: Option<String>,
    tint_alpha: Option<f32>,
) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Window {label} not found."))?;
    windowfx::apply_effect(&window, &effect, dark, tint.as_deref(), tint_alpha)
}

/// 把本地图片读取为 data URI（用于 CSS 背景图）。
#[tauri::command]
fn read_image_data_uri(path: String) -> Result<String, String> {
    windowfx::read_image_data_uri(&path)
}

#[tauri::command]
fn host_start(app: tauri::AppHandle, state: tauri::State<AppState>) {
    #[cfg(target_os = "windows")]
    {
        let config_dir = state
            .config_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        host::start(app.clone(), config_dir);
        clipboard::start(app);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (app, state);
}

#[tauri::command]
fn inject_process(app: tauri::AppHandle, pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        host::inject_process(pid, app);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, pid);
        return Err("Process injection is only supported on Windows.".to_string());
    }
    Ok(())
}

#[tauri::command]
fn detach_process(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        host::detach_process(pid)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
        Ok(())
    }
}

/// 当前已连接的目标进程 PID 列表（窗口重新加载时同步左上角的进程选框）。
#[tauri::command]
fn connected_processes() -> Vec<u32> {
    #[cfg(target_os = "windows")]
    {
        host::connected_pids()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

#[tauri::command]
fn remove_hook(pid: u32, address: u64) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        host::remove_hook(pid, address)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (pid, address);
        Ok(())
    }
}

#[tauri::command]
fn insert_hook(app: tauri::AppHandle, pid: u32, code: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        host::insert_hook(&app, pid, code)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, pid, code);
        Err("Hook management is only supported on Windows.".to_string())
    }
}

#[tauri::command]
fn find_hooks(pid: u32, param: SearchParamInput) -> Result<(), String> {
    let sp = to_search_param(param);
    #[cfg(target_os = "windows")]
    {
        host::find_hooks(pid, sp)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (pid, sp);
        Err("Hook search is only supported on Windows.".to_string())
    }
}

#[tauri::command]
fn set_thread_settings(settings: ThreadSettings) {
    #[cfg(target_os = "windows")]
    host::set_thread_settings(settings);
    #[cfg(not(target_os = "windows"))]
    let _ = settings;
}

#[tauri::command]
fn list_hooks(pid: u32) -> Vec<HookInfo> {
    #[cfg(target_os = "windows")]
    {
        host::list_hooks(pid)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
        Vec::new()
    }
}

#[tauri::command(rename_all = "camelCase")]
fn save_hooks(
    pid: u32,
    codes: Vec<String>,
    current_thread: Option<SavedThreadInput>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let current = current_thread.map(|t| (t.ctx, t.ctx2, t.code));
        host::save_hooks(pid, codes, current)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (pid, codes, current_thread);
        Ok(())
    }
}

#[tauri::command]
fn auto_attach(app: tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    host::auto_attach(&app);
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

#[tauri::command]
fn configure_game(pid: u32) -> Result<(), String> {
    let exe = saved::process_exe(pid).ok_or_else(|| "Cannot resolve process path.".to_string())?;
    let exe_path = std::path::PathBuf::from(&exe);
    let dir = exe_path
        .parent()
        .ok_or_else(|| "Invalid executable path.".to_string())?;
    let config = dir.join("TextractorConfig.txt");
    if !config.exists() {
        std::fs::write(
            &config,
            "see https://github.com/Artikash/Textractor/wiki/Game-configuration-file\n",
        )
        .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    open_with_default(&config)?;
    #[cfg(not(target_os = "windows"))]
    let _ = config;
    Ok(())
}

#[tauri::command]
fn forget_game(state: tauri::State<AppState>, pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = host::detach_process(pid);
    }
    let exe = saved::process_exe(pid).ok_or_else(|| "Cannot resolve process path.".to_string())?;
    let dir = state
        .config_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    saved::forget(&dir, &exe);
    Ok(())
}

#[tauri::command]
fn save_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_own_pid() -> u32 {
    std::process::id()
}

#[tauri::command]
fn copy_to_clipboard(text: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        clipboard::copy_unicode(&text)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = text;
        Ok(())
    }
}

#[tauri::command]
async fn translate_text(
    state: tauri::State<'_, AppState>,
    request: translate::TranslateRequest,
) -> Result<translate::TranslateResult, String> {
    #[cfg(target_os = "windows")]
    {
        let db = state.db.clone();
        tauri::async_runtime::spawn_blocking(move || translate::translate(&db, request))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, request);
        Err("Translation is only supported on Windows.".to_string())
    }
}

/// 把日文转为罗马音（供“罗马音标注”增强扩展使用，仅影响显示）。
#[tauri::command]
async fn romanize_ja(text: String) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || romanji::romanize_ja(&text))
            .await
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = text;
        Ok(String::new())
    }
}

/// 罗马音词典状态（是否已安装 / 目录 / 体积）。
#[tauri::command]
fn romanji_dict_status(app: tauri::AppHandle) -> Result<RomanjiDictStatus, String> {
    romanji_dict::status(&app)
}

/// 下载并安装罗马音词典（预编译包约 10MB，解压后约 46MB）。
#[tauri::command]
async fn romanji_dict_install(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || romanji_dict::install(&app))
        .await
        .map_err(|e| e.to_string())?
}

/// 删除已安装的罗马音词典（删除后罗马音标注不再可用）。
#[tauri::command]
async fn romanji_dict_uninstall(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || romanji_dict::uninstall(&app))
        .await
        .map_err(|e| e.to_string())?
}

/// 创建（若不存在）并用默认编辑器打开自定义罗马音词典，返回其路径。
#[tauri::command]
fn romanji_user_dict_open() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let path = romanji::ensure_user_dict_file()?;
        open_with_default(&path)?;
        Ok(path.to_string_lossy().to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Romanji custom dictionary is only supported on Windows.".to_string())
    }
}

/// 重新加载罗马音词典 + 自定义词典（改完自定义词典后点“重载”，无需重启）。
#[tauri::command]
async fn romanji_user_dict_reload() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(romanji::reload)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// texthook.dll 的本地状态（当前版本 / 来源 / 目录是否可写）。不联网。
#[tauri::command]
fn texthook_status(app: tauri::AppHandle) -> Result<TexthookStatus, String> {
    texthook::status(&app)
}

/// 检查上游 `Chenx221/Textractor` 是否有更新的 texthook。
/// `force = false` 时 24 小时内的结果直接走缓存（启动时的静默检查用）。
#[tauri::command]
async fn texthook_check(
    app: tauri::AppHandle,
    force: Option<bool>,
) -> Result<TexthookCheck, String> {
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || texthook::check(&app, force))
        .await
        .map_err(|e| e.to_string())?
}

/// 下载并就地更新 texthook.dll（x64 + x86）。目录不可写时返回 `NEED_ADMIN:` 开头的错误。
#[tauri::command]
async fn texthook_update(
    app: tauri::AppHandle,
    tag: Option<String>,
) -> Result<TexthookUpdateResult, String> {
    tauri::async_runtime::spawn_blocking(move || texthook::install(&app, tag))
        .await
        .map_err(|e| e.to_string())?
}

/// 启动 WebSocket 服务端（监听指定端口，向已连接客户端广播文本）。
#[tauri::command]
fn ws_start_server(port: u16) -> Result<(), String> {
    ws::start_server(port)
}

/// 停止 WebSocket 服务端。
#[tauri::command]
fn ws_stop_server() {
    ws::stop_server();
}

/// 向所有已连接的 WebSocket 客户端广播一条文本。
#[tauri::command]
fn ws_broadcast(text: String) {
    ws::broadcast(&text);
}

/// 启动 WebSocket 客户端（连接到指定服务器，收到的文本以事件转发）。
#[tauri::command]
fn ws_start_client(app: tauri::AppHandle, url: String) -> Result<(), String> {
    ws::start_client(app, &url)
}

/// 停止 WebSocket 客户端。
#[tauri::command]
fn ws_stop_client() {
    ws::stop_client();
}

#[cfg(target_os = "windows")]
fn open_with_default(path: &std::path::Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let file: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let operation: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        Err("Failed to open file with default editor.".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
fn launch_game(path: String) -> Result<(), String> {
    let exe = std::path::PathBuf::from(&path);
    let dir = exe
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    std::process::Command::new(&exe)
        .current_dir(dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn list_fonts() -> Vec<String> {
    use windows_sys::Win32::Foundation::LPARAM;
    use windows_sys::Win32::Graphics::Gdi::{
        EnumFontFamiliesExW, GetDC, ReleaseDC, LOGFONTW, TEXTMETRICW,
    };

    static FONTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

    unsafe extern "system" fn enum_cb(
        lplf: *const LOGFONTW,
        _lptm: *const TEXTMETRICW,
        _dwtype: u32,
        _lparam: LPARAM,
    ) -> i32 {
        if let Some(lf) = lplf.as_ref() {
            let face = &lf.lfFaceName;
            let len = face.iter().position(|&c| c == 0).unwrap_or(face.len());
            let name = String::from_utf16_lossy(&face[..len]);
            let name = name.trim().to_string();
            if !name.is_empty() && !name.starts_with('@') {
                if let Ok(mut guard) = FONTS.lock() {
                    if !guard.contains(&name) {
                        guard.push(name);
                    }
                }
            }
        }
        1
    }

    unsafe {
        if let Ok(mut guard) = FONTS.lock() {
            guard.clear();
        }
        let hdc = GetDC(std::ptr::null_mut());
        if !hdc.is_null() {
            let mut lf: LOGFONTW = std::mem::zeroed();
            lf.lfCharSet = 1; // DEFAULT_CHARSET
            EnumFontFamiliesExW(hdc, &lf, Some(enum_cb), 0, 0);
            ReleaseDC(std::ptr::null_mut(), hdc);
        }
        let mut fonts = FONTS.lock().map(|g| g.clone()).unwrap_or_default();
        fonts.sort();
        fonts
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn list_fonts() -> Vec<String> {
    Vec::new()
}

#[tauri::command]
fn list_processes() -> Vec<ProcessInfo> {
    use sysinfo::System;

    let mut sys = System::new_all();
    sys.refresh_all();

    #[cfg(target_os = "windows")]
    let titles = process_win::window_titles();

    let mut out: Vec<ProcessInfo> = sys
        .processes()
        .iter()
        .map(|(pid, process)| {
            let pid = pid.as_u32();
            let name = process.name().to_string_lossy().to_string();
            let title = {
                #[cfg(target_os = "windows")]
                {
                    titles.get(&pid).cloned().unwrap_or_default()
                }
                #[cfg(not(target_os = "windows"))]
                {
                    String::new()
                }
            };
            let arch = {
                #[cfg(target_os = "windows")]
                {
                    process_win::process_arch(pid).to_string()
                }
                #[cfg(not(target_os = "windows"))]
                {
                    String::from("x64")
                }
            };
            let has_file = process.exe().map(|p| p.exists()).unwrap_or(false);
            let is_system = is_system_process(process);
            let icon = {
                #[cfg(target_os = "windows")]
                {
                    process
                        .exe()
                        .and_then(|p| icons::process_icon_data_uri(&p.to_string_lossy()))
                }
                #[cfg(not(target_os = "windows"))]
                {
                    None
                }
            };
            ProcessInfo { pid, name, title, arch, has_file, is_system, icon }
        })
        .collect();

    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.pid.cmp(&b.pid))
    });
    out
}

#[tauri::command]
fn restart_as_admin(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Debug 构建依赖 `tauri dev` 的 dev server，无法脱离后独立运行；
        // 因此只在打包后的 release 构建中执行真正的提权重启。
        if cfg!(debug_assertions) {
            return Err("Restart as admin is only available in a packaged build.".to_string());
        }
        restart_elevated()?;
        app.exit(0);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        return Err("Restart as admin is only supported on Windows.".to_string());
    }
    Ok(())
}

/// 读取配置文件。
///
/// 文件缺失时返回空对象（首次启动）；**文件存在但无法解析时**，先把原文件
/// 备份成 `settings.json.<日期>.bak`，再返回错误 —— 前端拿到错误后会用默认
/// 配置继续运行，并在 300ms 防抖后把默认配置写回 `settings.json`（即“重置”），
/// 所以备份必须发生在这次覆盖写之前。备份采用**改名**而不是复制：重置后
/// `settings.json` 由前端重新写出，坏文件只留下一份，不会每次启动都堆积。
#[tauri::command]
fn load_config(state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
    let content = match std::fs::read_to_string(&state.config_path) {
        Ok(text) => text,
        // 文件不存在（或读不了）：按“没有配置”处理，不覆盖、不报错。
        Err(_) => return Ok(serde_json::Value::Object(serde_json::Map::new())),
    };
    match serde_json::from_str::<serde_json::Value>(&content) {
        // 只有 JSON 对象才是有效配置；其它（数组/数字/null/空文件）同样按损坏处理。
        Ok(value) if value.is_object() => Ok(value),
        parsed => {
            let reason = match parsed {
                Err(err) => err.to_string(),
                Ok(_) => "config file is not a JSON object".to_string(),
            };
            let backup = backup_corrupt_config(&state.config_path);
            match backup {
                Some(path) => Err(format!("{reason} (backed up to {})", path.display())),
                None => Err(reason),
            }
        }
    }
}

/// 把损坏的配置文件改名为 `原名.<日期>.bak`，返回备份路径（失败时 `None`）。
/// 当日已有备份时追加序号（`...-1.bak`、`...-2.bak`），不覆盖旧备份。
fn backup_corrupt_config(path: &std::path::Path) -> Option<std::path::PathBuf> {
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

/// 本地日期（`YYYY-MM-DD`）。Windows 用 `GetLocalTime` 取本地时区；
/// 其它平台没有标准库时区支持，退回 UTC。
#[cfg(target_os = "windows")]
fn local_date() -> String {
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;

    let mut now: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut now) };
    format!("{:04}-{:02}-{:02}", now.wYear, now.wMonth, now.wDay)
}

#[cfg(not(target_os = "windows"))]
fn local_date() -> String {
    // Howard Hinnant 的 civil_from_days：把 Unix 天数换算成公历日期。
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
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

/// 写入配置。
///
/// 先写同目录的临时文件再原子替换，避免写入过程中断电/被杀进程留下半截
/// JSON（下一次启动就会因解析失败而被“重置”，正是丢配置的常见原因）。
/// 临时文件名带进程号 + 递增序号，两个窗口同时保存也不会互相踩。
#[tauri::command]
fn save_config(state: tauri::State<AppState>, config: serde_json::Value) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};

    static SAVE_SEQ: AtomicU64 = AtomicU64::new(0);

    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    let seq = SAVE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = state
        .config_path
        .with_extension(format!("json.{}.{seq}.tmp", std::process::id()));
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &state.config_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

#[tauri::command]
fn cache_get(
    state: tauri::State<AppState>,
    service: String,
    source: String,
    target: String,
    original: String,
) -> Result<Option<String>, String> {
    use rusqlite::OptionalExtension;

    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT translated_text FROM translation_cache \
             WHERE service = ?1 AND source_lang = ?2 AND target_lang = ?3 AND original_text = ?4",
        )
        .map_err(|e| e.to_string())?;
    stmt.query_row(rusqlite::params![service, source, target, original], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn cache_put(
    state: tauri::State<AppState>,
    service: String,
    source: String,
    target: String,
    original: String,
    translated: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO translation_cache \
         (service, source_lang, target_lang, original_text, translated_text) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![service, source, target, original, translated],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- 翻译缓存管理（设置 → 翻译缓存） ----

/// 缓存统计：条数、占用空间、按翻译服务的分布。
#[derive(Serialize)]
struct CacheStats {
    entries: i64,
    bytes: u64,
    services: Vec<CacheServiceCount>,
}

#[derive(Serialize)]
struct CacheServiceCount {
    service: String,
    count: i64,
}

/// 缓存中的一行（id 为 SQLite rowid，用于编辑/删除）。
#[derive(Serialize)]
struct CacheRow {
    id: i64,
    service: String,
    source_lang: String,
    target_lang: String,
    original_text: String,
    translated_text: String,
}

#[derive(Serialize)]
struct CachePage {
    rows: Vec<CacheRow>,
    total: i64,
}

/// 把搜索词包成 LIKE 模式（转义 `%` `_` `\`，配合 SQL 里的 `ESCAPE '\'`）。
fn like_pattern(query: &str) -> String {
    let mut pattern = String::with_capacity(query.len() + 2);
    pattern.push('%');
    for ch in query.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(ch);
    }
    pattern.push('%');
    pattern
}

/// 缓存查询的 WHERE 子句：`?1` 搜索词、`?2` LIKE 模式、`?3` 翻译服务（各为空串时不过滤）。
const CACHE_FILTER: &str = "(?1 = '' OR original_text LIKE ?2 ESCAPE '\\' \
                            OR translated_text LIKE ?2 ESCAPE '\\') \
                            AND (?3 = '' OR service = ?3)";

#[tauri::command]
fn cache_stats(state: tauri::State<AppState>) -> Result<CacheStats, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let entries: i64 = db
        .query_row("SELECT COUNT(*) FROM translation_cache", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT service, COUNT(*) FROM translation_cache \
             GROUP BY service ORDER BY COUNT(*) DESC, service ASC",
        )
        .map_err(|e| e.to_string())?;
    let services = stmt
        .query_map([], |row| {
            Ok(CacheServiceCount {
                service: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    // 库文件大小（含未回收的空闲页）；读不到就报 0。
    let path = state
        .config_path
        .parent()
        .map(|dir| dir.join("translation_cache.db"))
        .unwrap_or_else(|| std::path::PathBuf::from("translation_cache.db"));
    let bytes = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    Ok(CacheStats {
        entries,
        bytes,
        services,
    })
}

/// 分页查缓存（按最近写入排序）：`filter` 匹配原文/译文，`service` 过滤翻译服务。
fn query_cache_page(
    conn: &rusqlite::Connection,
    filter: &str,
    service: &str,
    offset: u32,
    limit: u32,
) -> Result<CachePage, String> {
    let like = like_pattern(filter);
    let limit = limit.clamp(1, 200);

    let mut stmt = conn
        .prepare(&format!(
            "SELECT rowid, service, source_lang, target_lang, original_text, translated_text \
             FROM translation_cache WHERE {CACHE_FILTER} \
             ORDER BY rowid DESC LIMIT ?4 OFFSET ?5"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            rusqlite::params![filter, like, service, limit, offset],
            |row| {
                Ok(CacheRow {
                    id: row.get(0)?,
                    service: row.get(1)?,
                    source_lang: row.get(2)?,
                    target_lang: row.get(3)?,
                    original_text: row.get(4)?,
                    translated_text: row.get(5)?,
                })
            },
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let total: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM translation_cache WHERE {CACHE_FILTER}"),
            rusqlite::params![filter, like, service],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(CachePage { rows, total })
}

/// 删除匹配的缓存行（两个过滤都为空串时删除全部），返回删除行数。
fn delete_cache_matching(
    conn: &rusqlite::Connection,
    filter: &str,
    service: &str,
) -> Result<usize, String> {
    let like = like_pattern(filter);
    conn.execute(
        &format!("DELETE FROM translation_cache WHERE {CACHE_FILTER}"),
        rusqlite::params![filter, like, service],
    )
    .map_err(|e| e.to_string())
}

/// 分页列出缓存（按最近写入排序）：`query` 匹配原文/译文，`service` 过滤翻译服务。
#[tauri::command]
fn cache_list(
    state: tauri::State<AppState>,
    query: Option<String>,
    service: Option<String>,
    offset: u32,
    limit: u32,
) -> Result<CachePage, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    query_cache_page(
        &db,
        query.unwrap_or_default().trim(),
        service.unwrap_or_default().trim(),
        offset,
        limit,
    )
}

/// 新增一条缓存（已存在同键条目则覆盖）。
#[tauri::command]
fn cache_insert(
    state: tauri::State<AppState>,
    service: String,
    source: String,
    target: String,
    original: String,
    translated: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO translation_cache \
         (service, source_lang, target_lang, original_text, translated_text) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![service, source, target, original, translated],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 修改一条缓存的译文（原文/语言属于主键，不在此处改）。
#[tauri::command]
fn cache_update(state: tauri::State<AppState>, id: i64, translated: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "UPDATE translation_cache SET translated_text = ?2 WHERE rowid = ?1",
        rusqlite::params![id, translated],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除若干条缓存，返回实际删除的行数。
#[tauri::command]
fn cache_delete(state: tauri::State<AppState>, ids: Vec<i64>) -> Result<usize, String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let mut removed = 0usize;
    {
        let mut stmt = tx
            .prepare("DELETE FROM translation_cache WHERE rowid = ?1")
            .map_err(|e| e.to_string())?;
        for id in ids {
            removed += stmt
                .execute(rusqlite::params![id])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(removed)
}

/// 清空缓存：两个过滤都为空时清空全部（并 VACUUM 回收空间），否则只删匹配项。
#[tauri::command]
fn cache_clear(
    state: tauri::State<AppState>,
    query: Option<String>,
    service: Option<String>,
) -> Result<usize, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let filter = query.unwrap_or_default().trim().to_string();
    let service = service.unwrap_or_default().trim().to_string();
    let removed = delete_cache_matching(&db, &filter, &service)?;
    if filter.is_empty() && service.is_empty() {
        // VACUUM 不能在事务里执行（这里没有事务），用于把清空后的空间还给系统。
        let _ = db.execute_batch("VACUUM");
    }
    Ok(removed)
}

#[cfg(target_os = "windows")]
fn is_system_process(process: &sysinfo::Process) -> bool {
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".to_string());
    let windir = windir.to_lowercase();
    match process.exe() {
        None => true,
        Some(exe) => exe.to_string_lossy().to_lowercase().starts_with(&windir),
    }
}

#[cfg(not(target_os = "windows"))]
fn is_system_process(_process: &sysinfo::Process) -> bool {
    false
}

fn current_bitness() -> String {
    match std::env::consts::ARCH {
        "x86_64" | "aarch64" => "64".to_string(),
        "x86" | "arm" => "32".to_string(),
        other => other.to_string(),
    }
}

#[cfg(target_os = "windows")]
fn is_admin() -> bool {
    unsafe { windows_sys::Win32::UI::Shell::IsUserAnAdmin() != 0 }
}

#[cfg(not(target_os = "windows"))]
fn is_admin() -> bool {
    false
}

#[cfg(target_os = "windows")]
fn restart_elevated() -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let file: Vec<u16> = exe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let operation: Vec<u16> = "runas".encode_utf16().chain(std::iter::once(0)).collect();

    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };

    if result as isize <= 32 {
        return Err("Failed to launch the elevated process.".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
mod process_win {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    // windows-sys 0.61 起基础类型 BOOL 移到 `core` 模块。
    use windows_sys::core::BOOL;
    use windows_sys::Win32::System::Threading::{
        IsWow64Process, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible,
    };

    static TITLES: Mutex<Option<HashMap<u32, String>>> = Mutex::new(None);

    unsafe extern "system" fn enum_cb(hwnd: HWND, _lparam: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return 1;
        }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return 1;
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        let copied = GetWindowTextW(hwnd, buf.as_mut_ptr(), len + 1);
        if copied <= 0 {
            return 1;
        }
        let title = String::from_utf16_lossy(&buf[..copied as usize]);
        let title = title.trim().to_string();
        if title.is_empty() {
            return 1;
        }
        if let Ok(mut guard) = TITLES.lock() {
            let map = guard.get_or_insert_with(HashMap::new);
            map.entry(pid).or_insert(title);
        }
        1
    }

    pub fn window_titles() -> HashMap<u32, String> {
        unsafe {
            if let Ok(mut guard) = TITLES.lock() {
                *guard = Some(HashMap::new());
            }
            EnumWindows(Some(enum_cb), 0);
            TITLES
                .lock()
                .ok()
                .and_then(|mut g| g.take())
                .unwrap_or_default()
        }
    }

    pub fn process_arch(pid: u32) -> &'static str {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return host_arch();
            }
            let mut wow64: i32 = 0;
            let ok = IsWow64Process(handle, &mut wow64);
            windows_sys::Win32::Foundation::CloseHandle(handle);
            if ok == 0 {
                return host_arch();
            }
            if wow64 != 0 {
                "x86"
            } else {
                "x64"
            }
        }
    }

    fn host_arch() -> &'static str {
        if cfg!(target_pointer_width = "64") {
            "x64"
        } else {
            "x86"
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            let config_path = config_dir.join("settings.json");
            let db_path = config_dir.join("translation_cache.db");
            let db = Connection::open(&db_path)?;
            db.execute_batch(
                "CREATE TABLE IF NOT EXISTS translation_cache (
                    service TEXT NOT NULL,
                    source_lang TEXT NOT NULL,
                    target_lang TEXT NOT NULL,
                    original_text TEXT NOT NULL,
                    translated_text TEXT NOT NULL,
                    PRIMARY KEY (service, source_lang, target_lang, original_text)
                );",
            )?;
            app.manage(AppState {
                config_path,
                db: Arc::new(Mutex::new(db)),
            });
            // 罗马音词典改为运行时从数据目录加载（不再内嵌，减小可执行文件体积）。
            #[cfg(target_os = "windows")]
            if let Ok(data_dir) = app.path().app_config_dir() {
                romanji::init(data_dir.join("dict").join("lindera-ipadic"));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_system_info,
            get_build_info,
            open_devtools,
            toggle_extra_window,
            hide_extra_window,
            set_window_effect,
            read_image_data_uri,
            list_processes,
            launch_game,
            list_fonts,
            restart_as_admin,
            load_config,
            save_config,
            cache_get,
            cache_put,
            cache_stats,
            cache_list,
            cache_insert,
            cache_update,
            cache_delete,
            cache_clear,
            host_start,
            inject_process,
            detach_process,
            connected_processes,
            remove_hook,
            insert_hook,
            find_hooks,
            list_hooks,
            save_hooks,
            auto_attach,
            configure_game,
            forget_game,
            set_thread_settings,
            save_text_file,
            read_text_file,
            get_own_pid,
            copy_to_clipboard,
            translate_text,
            romanize_ja,
            romanji_dict_status,
            romanji_dict_install,
            romanji_dict_uninstall,
            romanji_user_dict_open,
            romanji_user_dict_reload,
            texthook_status,
            texthook_check,
            texthook_update,
            ws_start_server,
            ws_stop_server,
            ws_broadcast,
            ws_start_client,
            ws_stop_client
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::WindowEvent { label, event, .. } => {
                    // 悬浮窗（extra window）被隐藏后仍是一个存活窗口，会导致关闭主窗口后
                    // 进程迟迟不退出；这里在主窗口请求关闭时直接退出整个应用。
                    if label == "main" && matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                        app.exit(0);
                    }
                }
                tauri::RunEvent::Exit => {
                    #[cfg(target_os = "windows")]
                    host::detach_all();
                    #[cfg(target_os = "windows")]
                    ws::shutdown();
                }
                _ => {}
            }
        });
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::{backup_corrupt_config, local_date};

    /// `sysinfo` 升级后的运行时冒烟测试：确认仍能枚举到进程及其名称
    /// （避免"编译通过但列表为空/字段丢失"这类行为变化）。
    #[test]
    fn sysinfo_enumerates_processes() {
        let mut system = sysinfo::System::new_all();
        system.refresh_all();
        let processes = system.processes();
        assert!(
            !processes.is_empty(),
            "sysinfo returned an empty process list"
        );
        assert!(
            processes.values().any(|p| !p.name().is_empty()),
            "no process with a name"
        );
        assert!(
            processes.values().any(|p| p.exe().is_some()),
            "no process exposes an executable path"
        );
    }

    /// 损坏的配置文件应被改名成 `原名.<日期>.bak`（而不是直接丢掉），
    /// 且同一天的第二次备份不会覆盖第一次。
    #[test]
    fn backup_corrupt_config_keeps_a_dated_copy() {
        let dir = std::env::temp_dir().join(format!(
            "textractor-config-backup-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        std::fs::write(&path, "{ not json").unwrap();
        let first = backup_corrupt_config(&path).expect("backup should be created");
        assert!(!path.exists(), "the original file should be moved away");
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "{ not json");
        assert_eq!(
            first.file_name().unwrap().to_string_lossy(),
            format!("settings.json.{}.bak", local_date())
        );

        std::fs::write(&path, "still not json").unwrap();
        let second = backup_corrupt_config(&path).expect("second backup should be created");
        assert_ne!(first, second, "the earlier backup must not be overwritten");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "still not json");

        // 文件不存在时不应产生备份（首次启动不是“重置”）。
        let _ = std::fs::remove_file(&path);
        assert!(backup_corrupt_config(&path).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    /// 建一个与运行时同结构的空缓存库（内存库，不碰真实文件）。
    fn empty_cache() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE translation_cache (
                service TEXT NOT NULL,
                source_lang TEXT NOT NULL,
                target_lang TEXT NOT NULL,
                original_text TEXT NOT NULL,
                translated_text TEXT NOT NULL,
                PRIMARY KEY (service, source_lang, target_lang, original_text)
            );",
        )
        .unwrap();
        conn
    }

    fn insert(conn: &rusqlite::Connection, service: &str, original: &str, translated: &str) {
        conn.execute(
            "INSERT OR REPLACE INTO translation_cache \
             (service, source_lang, target_lang, original_text, translated_text) \
             VALUES (?1, 'ja', 'zh-CN', ?2, ?3)",
            rusqlite::params![service, original, translated],
        )
        .unwrap();
    }

    #[test]
    fn lists_filters_and_pages() {
        let conn = empty_cache();
        insert(&conn, "google", "こんにちは", "你好");
        insert(&conn, "deepl", "ありがとう", "谢谢");
        insert(&conn, "google", "100% 完了", "100% 完成");

        // 无过滤：全部返回，最近写入的排在最前。
        let page = query_cache_page(&conn, "", "", 0, 10).unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(page.rows[0].original_text, "100% 完了");

        // 命中原文 / 译文。
        assert_eq!(
            query_cache_page(&conn, "ありがとう", "", 0, 10).unwrap().total,
            1
        );
        let hit = query_cache_page(&conn, "谢谢", "", 0, 10).unwrap();
        assert_eq!(hit.total, 1);
        assert_eq!(hit.rows[0].service, "deepl");

        // `%` 按普通字符处理，而不是 LIKE 通配符。
        let pct = query_cache_page(&conn, "%", "", 0, 10).unwrap();
        assert_eq!(pct.total, 1);
        assert_eq!(pct.rows[0].original_text, "100% 完了");

        // 分页。
        assert_eq!(query_cache_page(&conn, "", "", 0, 2).unwrap().rows.len(), 2);
        assert_eq!(query_cache_page(&conn, "", "", 2, 2).unwrap().rows.len(), 1);
        assert_eq!(query_cache_page(&conn, "", "", 99, 2).unwrap().rows.len(), 0);
    }

    #[test]
    fn filters_by_service() {
        let conn = empty_cache();
        insert(&conn, "google", "a", "A-1");
        insert(&conn, "deepl", "b", "B-1");
        insert(&conn, "deepl", "c", "C-1");

        let by_service = query_cache_page(&conn, "", "deepl", 0, 10).unwrap();
        assert_eq!(by_service.total, 2);
        assert!(by_service.rows.iter().all(|row| row.service == "deepl"));

        // 服务 + 文本搜索叠加。
        let combined = query_cache_page(&conn, "c", "deepl", 0, 10).unwrap();
        assert_eq!(combined.total, 1);
        assert_eq!(combined.rows[0].original_text, "c");
        assert_eq!(query_cache_page(&conn, "a", "deepl", 0, 10).unwrap().total, 0);

        // 按服务删除只删该服务的条目。
        assert_eq!(delete_cache_matching(&conn, "", "deepl").unwrap(), 2);
        let rest = query_cache_page(&conn, "", "", 0, 10).unwrap();
        assert_eq!(rest.total, 1);
        assert_eq!(rest.rows[0].service, "google");
    }

    #[test]
    fn deletes_matching_rows_or_everything() {
        let conn = empty_cache();
        insert(&conn, "google", "a", "A-1");
        insert(&conn, "deepl", "b", "B-1");
        insert(&conn, "deepl", "c", "C-1");

        // 过滤的是原文/译文，不是服务名。
        assert_eq!(delete_cache_matching(&conn, "deepl", "").unwrap(), 0);
        assert_eq!(delete_cache_matching(&conn, "B-1", "").unwrap(), 1);
        assert_eq!(query_cache_page(&conn, "", "", 0, 10).unwrap().total, 2);
        // 空过滤 = 清空全部。
        assert_eq!(delete_cache_matching(&conn, "", "").unwrap(), 2);
        assert_eq!(query_cache_page(&conn, "", "", 0, 10).unwrap().total, 0);
    }
}
