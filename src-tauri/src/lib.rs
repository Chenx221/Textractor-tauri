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

struct AppState {
    config_path: std::path::PathBuf,
    db: Arc<Mutex<Connection>>,
}

#[derive(Serialize)]
struct SystemInfo {
    is_admin: bool,
    bitness: String,
}

#[derive(Serialize)]
struct BuildInfo {
    profile: String,
    version: String,
    arch: String,
    built_at: String,
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
        built_at: env!("BUILD_DATE").to_string(),
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

#[tauri::command]
fn load_config(state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
    let content = std::fs::read_to_string(&state.config_path).unwrap_or_else(|_| "{}".to_string());
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_config(state: tauri::State<AppState>, config: serde_json::Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&state.config_path, content).map_err(|e| e.to_string())
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
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
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
            host_start,
            inject_process,
            detach_process,
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
