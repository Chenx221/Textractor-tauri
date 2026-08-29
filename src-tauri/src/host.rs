//! Textractor `texthook.dll` 宿主适配层。
//!
//! 与原版 `ref/host/host.cpp` 的 `Host::Start` / `Host::InjectProcess` 等价：
//! - 以命名管道服务端身份监听 `\\.\pipe\TEXTRACTOR_HOOK`（DLL→宿主）与
//!   `\\.\pipe\TEXTRACTOR_HOST`（宿主→DLL）；
//! - 将 x64 `texthook.dll` 注入目标进程（`CreateRemoteThread(LoadLibraryW)`）；
//! - 把收到的文本 / 控制台输出转发为 Tauri 事件。
//!
//! 协议常量与结构体布局以 `ref/include/const.h`、`ref/include/defs.h`、
//! `ref/include/types.h`（x64，MSVC 默认 8 字节对齐）为准。

use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_PIPE_CONNECTED, BOOL, HANDLE,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Globalization::IsDBCSLeadByteEx;
use windows_sys::Win32::Security::{
    InitializeSecurityDescriptor, SetSecurityDescriptorDacl, SECURITY_ATTRIBUTES,
    SECURITY_DESCRIPTOR,
};
use windows_sys::Win32::Storage::FileSystem::{
    ReadFile, WriteFile, PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND,
};
use windows_sys::Win32::System::Diagnostics::Debug::WriteProcessMemory;
use windows_sys::Win32::System::LibraryLoader::{GetModuleFileNameW, LoadLibraryW};
use windows_sys::Win32::System::Memory::{
    MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, VirtualAllocEx, VirtualFreeEx,
    VirtualQueryEx, FILE_MAP_READ, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, MEMORY_BASIC_INFORMATION,
    MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_MESSAGE,
    PIPE_TYPE_MESSAGE, PIPE_UNLIMITED_INSTANCES,
};
use windows_sys::Win32::System::ProcessStatus::K32GetModuleFileNameExW;
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateRemoteThread, IsWow64Process, OpenProcess, SetEvent, WaitForSingleObject,
    INFINITE, LPTHREAD_START_ROUTINE, PROCESS_ALL_ACCESS, PROCESS_QUERY_INFORMATION,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
};
use windows_sys::core::PCWSTR;

use crate::{hookcode, proto, saved};
use proto::Bitness;

// ---- 管道常量 ----
const HOOK_PIPE: &str = "\\\\.\\pipe\\TEXTRACTOR_HOOK";
const HOST_PIPE: &str = "\\\\.\\pipe\\TEXTRACTOR_HOST";
const PIPE_AVAILABLE_EVENT: &str = "TEXTRACTOR_PIPE_AVAILABLE";
const ITH_DLL: &str = "texthook.dll";
const INJECTOR32: &str = "x86\\texthook-injector32.exe";

// ---- 事件载荷 ----

#[derive(Clone, Serialize)]
pub struct HostText {
    pub handle: u64,
    pub pid: u32,
    pub addr: u64,
    pub ctx: u64,
    pub ctx2: u64,
    pub text: String,
    pub code: Option<String>,
    pub name: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct HostConsole {
    pub message: String,
}

#[derive(Clone, Serialize)]
pub struct HookFound {
    pub pid: u32,
    pub code: String,
    pub text: String,
}

#[derive(Clone, Serialize)]
pub struct HookRemoved {
    pub pid: u32,
    pub address: u64,
}

#[derive(Clone, Serialize)]
pub struct SavedThreadEvent {
    pub handle: u64,
    pub pid: u32,
    pub addr: u64,
    pub ctx: u64,
    pub ctx2: u64,
    pub code: Option<String>,
    pub name: Option<String>,
}

// ---- 线程 / 进程状态 ----

#[derive(Clone, PartialEq, Eq, Hash)]
struct ThreadKey {
    pid: u32,
    addr: u64,
    ctx: u64,
    ctx2: u64,
}

struct TextThread {
    handle: u64,
    hp: Option<proto::HookParam>,
    /// 已解码的宽文本缓冲（等价于原版 `std::wstring buffer`）。
    buffer: String,
    /// DBCS 前导字节配对（等价于原版 `leadByte`）。
    lead_byte: Option<u8>,
    repeating_chars: HashSet<char>,
    force_flush: bool,
    last_push: Instant,
}

struct SharedView {
    mapping: usize,
    view: usize,
    len: usize,
}

struct ProcessRecord {
    bitness: Bitness,
    host_pipe: usize,
    view: Option<SharedView>,
}

static PROCESSES: std::sync::LazyLock<Mutex<HashMap<u32, ProcessRecord>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static THREADS: std::sync::LazyLock<Mutex<HashMap<ThreadKey, TextThread>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static SAVED_THREADS: std::sync::LazyLock<Mutex<HashMap<u32, saved::SavedThread>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static ALREADY_ATTACHED: std::sync::LazyLock<Mutex<HashSet<u32>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));
static PIPE_AVAILABLE: OnceLock<usize> = OnceLock::new();
static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();
static THREAD_COUNTER: AtomicU64 = AtomicU64::new(0);
static SETTINGS: std::sync::LazyLock<Mutex<crate::ThreadSettings>> =
    std::sync::LazyLock::new(|| {
        Mutex::new(crate::ThreadSettings {
            filter_repetition: false,
            flush_delay_spacing: 0,
            flush_delay_ms: 500,
            max_buffer: 3_000,
            limit_string_length: 0,
        })
    });

// ---- 工具函数 ----

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn to_wide_path(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// 带 NULL DACL 的安全描述符，允许管理员与非管理员进程互相访问内核对象
/// （等价于 ref/include/types.h 里的 `allAccess`）。
/// 注意：SECURITY_DESCRIPTOR 必须放在堆上（Box），保证指针在移动后仍有效。
struct AllAccess {
    _sd: Box<SECURITY_DESCRIPTOR>,
    sa: SECURITY_ATTRIBUTES,
}

impl AllAccess {
    fn new() -> Self {
        unsafe {
            let mut sd = Box::new(std::mem::zeroed::<SECURITY_DESCRIPTOR>());
            let sd_ptr = &mut *sd as *mut SECURITY_DESCRIPTOR as *mut c_void;
            InitializeSecurityDescriptor(sd_ptr, 1);
            SetSecurityDescriptorDacl(sd_ptr, 1, std::ptr::null(), 0);
            let sa = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd_ptr,
                bInheritHandle: 0,
            };
            Self { _sd: sd, sa }
        }
    }

    fn ptr(&self) -> *const SECURITY_ATTRIBUTES {
        &self.sa
    }
}

fn signal_pipe_available(sa: *const SECURITY_ATTRIBUTES) {
    let handle = *PIPE_AVAILABLE.get_or_init(|| {
        let name = to_wide(PIPE_AVAILABLE_EVENT);
        unsafe { CreateEventW(sa, 0, 0, name.as_ptr()) as usize }
    });
    unsafe { SetEvent(handle as HANDLE) };
}

fn create_hook_pipe(sa: *const SECURITY_ATTRIBUTES) -> HANDLE {
    let name = to_wide(HOOK_PIPE);
    unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_INBOUND,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE,
            PIPE_UNLIMITED_INSTANCES,
            0,
            proto::PIPE_BUFFER_SIZE as u32,
            u32::MAX,
            sa,
        )
    }
}

fn create_host_pipe(sa: *const SECURITY_ATTRIBUTES) -> HANDLE {
    let name = to_wide(HOST_PIPE);
    unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_OUTBOUND,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE,
            PIPE_UNLIMITED_INSTANCES,
            proto::PIPE_BUFFER_SIZE as u32,
            0,
            u32::MAX,
            sa,
        )
    }
}

fn emit_console(app: &AppHandle, message: impl Into<String>) {
    let _ = app.emit("host-console", HostConsole {
        message: message.into(),
    });
}

fn exe_dir() -> Option<PathBuf> {
    unsafe {
        let mut buf = vec![0u16; 32_768];
        let len = GetModuleFileNameW(std::ptr::null_mut(), buf.as_mut_ptr(), buf.len() as u32);
        if len == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        PathBuf::from(path).parent().map(|p| p.to_path_buf())
    }
}

fn format_hex(bytes: &[u8]) -> String {
    let mut s = String::new();
    for chunk in bytes.chunks(2) {
        let v = if chunk.len() == 2 {
            u16::from_le_bytes([chunk[0], chunk[1]])
        } else {
            chunk[0] as u16
        };
        s.push_str(&format!("{:04X} ", v));
    }
    s
}

fn is_dbc_lead(codepage: u32, byte: u8) -> bool {
    unsafe { IsDBCSLeadByteEx(codepage, byte) != 0 }
}

/// 按 hook 元数据解码，并处理 DBCS 前导字节配对。
fn decode_with_lead(hp: &proto::HookParam, bytes: &[u8], lead: &mut Option<u8>) -> String {
    if hp.type_flags & proto::USING_UNICODE != 0 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }

    let codepage = if hp.codepage != 0 { hp.codepage } else { 932 };
    // DBCS 前导字节配对：仅当本次只来了 1 个字节时进行。
    if bytes.len() == 1 {
        let b = bytes[0];
        if let Some(lb) = lead.take() {
            let paired = [lb, b];
            return decode_multibyte(hp, &paired);
        }
        if is_dbc_lead(codepage, b) {
            *lead = Some(b);
            return String::new();
        }
    }
    decode_multibyte(hp, bytes)
}

fn decode_multibyte(hp: &proto::HookParam, bytes: &[u8]) -> String {
    let enc = if hp.type_flags & proto::USING_UTF8 != 0 {
        encoding_rs::UTF_8
    } else {
        proto::codepage_to_encoding(hp.codepage)
    };
    let (cow, _, _) = enc.decode(bytes);
    cow.into_owned()
}

/// 检测文本重复（等价于原版 `RemoveRepetition`）。
fn remove_repetition(chars: &[char]) -> Option<Vec<char>> {
    let end = chars.len();
    for length in (7..=end / 3).rev() {
        let a = &chars[end - 3 * length..end - 2 * length];
        let b = &chars[end - 2 * length..end - length];
        let c = &chars[end - length..end];
        if a == b && b == c {
            let last = &chars[end - length..end];
            return Some(remove_repetition(last).unwrap_or_else(|| last.to_vec()));
        }
    }
    None
}

fn filter_repetition(t: &mut TextThread) {
    let chars: Vec<char> = t.buffer.chars().collect();
    if chars.is_empty() {
        return;
    }
    if chars.iter().all(|c| t.repeating_chars.contains(c)) {
        t.buffer.clear();
        return;
    }
    if let Some(kept) = remove_repetition(&chars) {
        t.repeating_chars = kept.iter().copied().collect();
        t.buffer = kept.into_iter().collect();
        t.force_flush = true;
    }
}

fn push_thread(t: &mut TextThread, bytes: &[u8]) {
    let settings = *SETTINGS.lock().unwrap();

    let decoded = match &t.hp {
        Some(hp) if hp.type_flags & proto::HEX_DUMP != 0 => format_hex(bytes),
        Some(hp) => decode_with_lead(hp, bytes, &mut t.lead_byte),
        None => decode_heuristic(bytes),
    };
    if decoded.is_empty() {
        return;
    }

    let using_string = t
        .hp
        .as_ref()
        .map(|hp| hp.type_flags & proto::USING_STRING != 0)
        .unwrap_or(false);
    if settings.flush_delay_spacing != 0 && !t.buffer.is_empty() && using_string {
        match settings.flush_delay_spacing {
            1 => t.buffer.push_str("\u{200b} "),
            2 => t.buffer.push('\n'),
            _ => {}
        }
    }

    t.buffer.push_str(&decoded);

    let full_string = t
        .hp
        .as_ref()
        .map(|hp| hp.type_flags & proto::FULL_STRING != 0)
        .unwrap_or(false);
    if full_string {
        t.buffer.push('\n');
    }
    t.last_push = Instant::now();

    if settings.filter_repetition {
        filter_repetition(t);
    }

    if settings.flush_delay_ms == 0 && full_string {
        t.force_flush = true;
    }
}

/// 无 hook 元数据时的启发式解码。
fn decode_heuristic(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    if bytes.len() % 2 == 0 {
        let mut zeros = 0usize;
        let mut total = 0usize;
        for &b in bytes.iter().skip(1).step_by(2) {
            total += 1;
            if b == 0 {
                zeros += 1;
            }
        }
        if total > 0 && zeros * 3 > total {
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            return String::from_utf16_lossy(&units);
        }
    }
    let (cow, _, _) = encoding_rs::SHIFT_JIS.decode(bytes);
    cow.into_owned()
}

fn process_bitness(pid: u32) -> Bitness {
    PROCESSES
        .lock()
        .unwrap()
        .get(&pid)
        .map(|r| r.bitness)
        .unwrap_or(Bitness::X64)
}

/// 从共享内存读取 hook（需在持有 PROCESSES 锁时调用，避免与断开时的 unmap 竞争）。
fn get_hook(pid: u32, addr: u64) -> Option<proto::HookParam> {
    let procs = PROCESSES.lock().unwrap();
    let rec = procs.get(&pid)?;
    let view = rec.view.as_ref()?;
    let bitness = rec.bitness;
    unsafe {
        let data = std::slice::from_raw_parts(view.view as *const u8, view.len);
        proto::read_text_hook(data, bitness, addr)
    }
}

fn send(pid: u32, bytes: &[u8]) -> bool {
    let procs = PROCESSES.lock().unwrap();
    let Some(rec) = procs.get(&pid) else {
        return false;
    };
    let mut written = 0u32;
    unsafe {
        WriteFile(
            rec.host_pipe as HANDLE,
            bytes.as_ptr(),
            bytes.len() as u32,
            &mut written,
            std::ptr::null_mut(),
        ) != 0
    }
}

fn detect_bitness(pid: u32) -> Bitness {
    unsafe {
        let p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if p.is_null() {
            return Bitness::X64;
        }
        let mut wow: BOOL = 0;
        let ok = IsWow64Process(p, &mut wow);
        CloseHandle(p);
        if ok != 0 && wow != 0 {
            Bitness::X86
        } else {
            Bitness::X64
        }
    }
}

/// 查询地址所属的模块基址与文件名（用于把 hook 地址转成模块相对形式）。
fn module_of(pid: u32, addr: u64) -> Option<(u64, String)> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut mbi: MEMORY_BASIC_INFORMATION = std::mem::zeroed();
        let ok = VirtualQueryEx(
            process,
            addr as *const c_void,
            &mut mbi,
            std::mem::size_of::<MEMORY_BASIC_INFORMATION>(),
        );
        if ok == 0 || mbi.AllocationBase.is_null() {
            CloseHandle(process);
            return None;
        }
        let mut buf = [0u16; 260];
        let len = K32GetModuleFileNameExW(
            process,
            mbi.AllocationBase as *mut c_void,
            buf.as_mut_ptr(),
            buf.len() as u32,
        );
        CloseHandle(process);
        if len == 0 {
            return None;
        }
        let name = String::from_utf16_lossy(&buf[..len as usize]);
        let name = name.rsplit('\\').next().unwrap_or(&name).to_string();
        Some((mbi.AllocationBase as u64, name))
    }
}

/// 生成 hook code，优先转成模块相对（rva）形式：`@偏移:模块名`。
fn hook_code(hp: &proto::HookParam, pid: u32) -> String {
    let mut hp = hp.clone();
    if hp.type_flags & proto::MODULE_OFFSET == 0 {
        if let Some((base, name)) = module_of(pid, hp.address) {
            hp.type_flags |= proto::MODULE_OFFSET;
            hp.address -= base;
            hp.module = name;
        }
    }
    hookcode::generate(&hp)
}

fn map_hook_section(pid: u32, bitness: Bitness) -> Option<SharedView> {
    let name = to_wide(&format!("VNR_SECTION_{}", pid));
    unsafe {
        let mapping = OpenFileMappingW(FILE_MAP_READ, 0, name.as_ptr());
        if mapping.is_null() {
            return None;
        }
        let len = proto::MAX_HOOK * bitness.text_hook_size();
        let view = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, len);
        if view.Value.is_null() {
            CloseHandle(mapping);
            return None;
        }
        Some(SharedView {
            mapping: mapping as usize,
            view: view.Value as usize,
            len,
        })
    }
}

fn unmap(view: &SharedView) {
    unsafe {
        UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
            Value: view.view as *mut c_void,
        });
        CloseHandle(view.mapping as HANDLE);
    }
}

fn remove_threads_by_addr(pid: u32, addr: u64) {
    let mut threads = THREADS.lock().unwrap();
    threads.retain(|k, _| !(k.pid == pid && k.addr == addr));
}

// ---- 管道接收 ----

fn handle_message(pid: u32, msg: &[u8], app: &AppHandle) {
    if msg.len() < 4 {
        return;
    }
    let cmd = i32::from_le_bytes([msg[0], msg[1], msg[2], msg[3]]);
    match cmd {
        proto::HOST_NOTIFICATION_TEXT => {
            let raw = &msg[4..];
            let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
            emit_console(app, String::from_utf8_lossy(&raw[..end]).to_string());
        }
        proto::HOST_NOTIFICATION_FOUND_HOOK => {
            let bitness = process_bitness(pid);
            if let Some((hp, text)) = proto::parse_hook_found(msg, bitness) {
                let code = hook_code(&hp, pid);
                let _ = app.emit("host-hook-found", HookFound { pid, code, text });
            }
        }
        proto::HOST_NOTIFICATION_RMVHOOK => {
            if let Some(address) = proto::parse_hook_removed(msg) {
                remove_threads_by_addr(pid, address);
                let _ = app.emit("host-hook-removed", HookRemoved { pid, address });
            }
        }
        _ => {
            if msg.len() <= 32 {
                return;
            }
            let Some((thread_pid, addr, ctx, ctx2)) = proto::read_thread_param(msg) else {
                return;
            };
            let key = ThreadKey {
                pid: thread_pid,
                addr,
                ctx,
                ctx2,
            };
            // 自动附加后若匹配保存的当前线程，则发出事件让前端切换视图
            // （等价于原版 ThreadAdded 里的 savedMatch 逻辑）。
            let saved_thread = SAVED_THREADS.lock().unwrap().get(&thread_pid).cloned();
            let mut saved_match = false;
            let mut saved_event: Option<SavedThreadEvent> = None;
            {
                let mut threads = THREADS.lock().unwrap();
                let is_new = !threads.contains_key(&key);
                let thread = threads.entry(key.clone()).or_insert_with(|| TextThread {
                    handle: THREAD_COUNTER.fetch_add(1, Ordering::SeqCst) + 1,
                    hp: get_hook(thread_pid, addr),
                    buffer: String::new(),
                    lead_byte: None,
                    repeating_chars: HashSet::new(),
                    force_flush: false,
                    last_push: Instant::now(),
                });
                push_thread(thread, &msg[32..]);

                if is_new {
                    if let Some(st) = saved_thread {
                        if let Some(hp) = &thread.hp {
                            let code = hook_code(hp, thread_pid);
                            if (st.ctx & 0xFFFF) == (ctx & 0xFFFF)
                                && st.ctx2 == ctx2
                                && st.code == code
                            {
                                saved_match = true;
                                let name = if hp.name.is_empty() {
                                    None
                                } else {
                                    Some(hp.name.clone())
                                };
                                saved_event = Some(SavedThreadEvent {
                                    handle: thread.handle,
                                    pid: thread_pid,
                                    addr,
                                    ctx,
                                    ctx2,
                                    code: Some(code),
                                    name,
                                });
                            }
                        }
                    }
                }
            }
            if saved_match {
                SAVED_THREADS.lock().unwrap().remove(&thread_pid);
            }
            if let Some(ev) = saved_event {
                let _ = app.emit("host-saved-thread", ev);
            }
        }
    }
}

fn reader_loop(pid: u32, hook_pipe: usize, app: AppHandle) {
    let mut buf = vec![0u8; proto::PIPE_BUFFER_SIZE];
    loop {
        let mut read = 0u32;
        let ok = unsafe {
            ReadFile(
                hook_pipe as HANDLE,
                buf.as_mut_ptr(),
                proto::PIPE_BUFFER_SIZE as u32,
                &mut read,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            break;
        }
        if read >= 4 {
            handle_message(pid, &buf[..read as usize], &app);
        }
    }

    unsafe {
        DisconnectNamedPipe(hook_pipe as HANDLE);
        CloseHandle(hook_pipe as HANDLE);
    }

    // 清理该进程的线程与进程记录。
    THREADS.lock().unwrap().retain(|k, _| k.pid != pid);
    SAVED_THREADS.lock().unwrap().remove(&pid);
    if let Some(rec) = PROCESSES.lock().unwrap().remove(&pid) {
        unsafe { CloseHandle(rec.host_pipe as HANDLE) };
        if let Some(view) = &rec.view {
            unmap(view);
        }
    }
    let _ = app.emit("host-disconnected", pid);
}

fn accept_loop(app: AppHandle) {
    loop {
        let all = AllAccess::new();
        let hook_pipe = create_hook_pipe(all.ptr());
        let host_pipe = create_host_pipe(all.ptr());
        if hook_pipe == INVALID_HANDLE_VALUE || host_pipe == INVALID_HANDLE_VALUE {
            unsafe {
                if hook_pipe != INVALID_HANDLE_VALUE {
                    CloseHandle(hook_pipe);
                }
                if host_pipe != INVALID_HANDLE_VALUE {
                    CloseHandle(host_pipe);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
            continue;
        }

        signal_pipe_available(all.ptr());

        // 等待 DLL 连接 hook 管道（DLL 会先连 HOST_PIPE 再连 HOOK_PIPE，
        // 两条管道实例都已在上方创建，故不会错配）。
        let connected = unsafe { ConnectNamedPipe(hook_pipe, std::ptr::null_mut()) };
        if connected == 0 {
            let err = unsafe { GetLastError() };
            if err != ERROR_PIPE_CONNECTED {
                unsafe {
                    DisconnectNamedPipe(hook_pipe);
                    CloseHandle(hook_pipe);
                    CloseHandle(host_pipe);
                }
                continue;
            }
        }

        // 读首个 4 字节：目标进程 PID。
        let mut pid_buf = [0u8; 4];
        let mut read = 0u32;
        let ok = unsafe {
            ReadFile(
                hook_pipe,
                pid_buf.as_mut_ptr(),
                4,
                &mut read,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 || read != 4 {
            unsafe {
                DisconnectNamedPipe(hook_pipe);
                CloseHandle(hook_pipe);
                CloseHandle(host_pipe);
            }
            continue;
        }
        let pid = u32::from_le_bytes(pid_buf);
        let bitness = detect_bitness(pid);
        let view = map_hook_section(pid, bitness);

        PROCESSES.lock().unwrap().insert(
            pid,
            ProcessRecord {
                bitness,
                host_pipe: host_pipe as usize,
                view,
            },
        );
        ALREADY_ATTACHED.lock().unwrap().insert(pid);
        let _ = app.emit("host-connected", pid);

        // 恢复已保存的 hook 与当前线程（等价于原版 ProcessConnected）。
        // 注意：不在此处写 SavedGames.txt，手动附加不会触发后续自动附加。
        if let Some(dir) = CONFIG_DIR.get() {
            if let Some(exe) = saved::process_exe(pid) {
                let codes = saved::saved_hook_codes_for(dir, &exe);
                for code in codes {
                    if let Some(hp) = hookcode::parse(&code) {
                        let cmd = proto::build_insert_hook_cmd(&hp, bitness);
                        send(pid, &cmd);
                    }
                }
                if let Some(st) = saved::saved_thread_for(dir, &exe) {
                    SAVED_THREADS.lock().unwrap().insert(pid, st);
                }
            }
        }

        let reader_app = app.clone();
        let hook_pipe = hook_pipe as usize;
        std::thread::spawn(move || reader_loop(pid, hook_pipe, reader_app));
    }
}

fn flush_loop(app: AppHandle) {
    loop {
        std::thread::sleep(Duration::from_millis(100));
        let now = Instant::now();
        let settings = *SETTINGS.lock().unwrap();
        let mut to_emit: Vec<(ThreadKey, u64, String, Option<String>, Option<String>)> = Vec::new();
        {
            let mut threads = THREADS.lock().unwrap();
            for (key, t) in threads.iter_mut() {
                if t.buffer.is_empty() {
                    continue;
                }
                let age_ms = now.duration_since(t.last_push).as_millis() as u64;
                let should_flush = t.force_flush
                    || t.buffer.chars().count() > settings.max_buffer
                    || age_ms > settings.flush_delay_ms;
                if !should_flush {
                    continue;
                }
                // limitStringLength：0=关闭；超过限制则丢弃（原版行为）。
                let over_limit = settings.limit_string_length != 0
                    && t.buffer.chars().count() > settings.limit_string_length;
                if !over_limit {
                    let code = t.hp.as_ref().map(|hp| hook_code(hp, key.pid));
                    let name = t
                        .hp
                        .as_ref()
                        .filter(|hp| !hp.name.is_empty())
                        .map(|hp| hp.name.clone());
                    to_emit.push((
                        key.clone(),
                        t.handle,
                        std::mem::take(&mut t.buffer),
                        code,
                        name,
                    ));
                } else {
                    t.buffer.clear();
                }
                t.force_flush = false;
            }
        }
        for (key, handle, text, code, name) in to_emit {
            let _ = app.emit("host-text", HostText {
                handle,
                pid: key.pid,
                addr: key.addr,
                ctx: key.ctx,
                ctx2: key.ctx2,
                text,
                code,
                name,
            });
        }
    }
}

// ---- 公共 API ----

/// 启动宿主：管道服务 + flush 线程（幂等）。
pub fn start(app: AppHandle, config_dir: PathBuf) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = CONFIG_DIR.set(config_dir);
    let flush_app = app.clone();
    std::thread::spawn(move || flush_loop(flush_app));
    std::thread::spawn(move || accept_loop(app));
}

/// 把 `texthook.dll` 注入目标进程。
pub fn inject_process(pid: u32, app: AppHandle) {
    std::thread::spawn(move || {
        if pid == std::process::id() {
            emit_console(&app, "Cannot inject into self.");
            return;
        }
        // 已连接的进程不重复注入（避免 LoadLibrary 只增加引用计数而不重新初始化 DLL）。
        if PROCESSES.lock().unwrap().contains_key(&pid) {
            emit_console(&app, "Process already connected.");
            return;
        }

        let process = unsafe { OpenProcess(PROCESS_ALL_ACCESS, 0, pid) };
        if process.is_null() {
            emit_console(&app, "INJECT_FAILED: cannot open process.");
            return;
        }

        // 判断目标位宽：32 位目标需要 32 位辅助注入器。
        let mut wow64: BOOL = 0;
        let is_32bit = unsafe {
            IsWow64Process(process, &mut wow64) != 0 && wow64 != 0
        };

        if is_32bit {
            unsafe { CloseHandle(process) };
            try_spawn_32bit_injector(pid, &app);
            return;
        }

        let Some(dir) = exe_dir() else {
            unsafe { CloseHandle(process) };
            emit_console(&app, "INJECT_FAILED: cannot locate executable directory.");
            return;
        };
        let dll = dir.join(ITH_DLL);
        if !dll.exists() {
            unsafe { CloseHandle(process) };
            emit_console(
                &app,
                format!("texthook.dll not found at {}", dll.display()),
            );
            return;
        }

        let wide = to_wide_path(&dll.to_string_lossy());
        let size = wide.len() * 2;

        unsafe {
            let remote = VirtualAllocEx(
                process,
                std::ptr::null(),
                size,
                MEM_COMMIT | MEM_RESERVE,
                PAGE_READWRITE,
            );
            if remote.is_null() {
                CloseHandle(process);
                emit_console(&app, "INJECT_FAILED: VirtualAllocEx failed.");
                return;
            }

            let mut written = 0usize;
            let ok = WriteProcessMemory(
                process,
                remote,
                wide.as_ptr() as *const c_void,
                size,
                &mut written,
            );
            if ok == 0 || written != size {
                VirtualFreeEx(process, remote, 0, MEM_RELEASE);
                CloseHandle(process);
                emit_console(&app, "INJECT_FAILED: WriteProcessMemory failed.");
                return;
            }

            let load_library: unsafe extern "system" fn(PCWSTR) -> windows_sys::Win32::Foundation::HMODULE =
                LoadLibraryW;
            let start_addr: LPTHREAD_START_ROUTINE = std::mem::transmute(load_library);
            let thread = CreateRemoteThread(
                process,
                std::ptr::null(),
                0,
                start_addr,
                remote,
                0,
                std::ptr::null_mut(),
            );
            if thread.is_null() {
                let err = GetLastError();
                if err == ERROR_ACCESS_DENIED {
                    emit_console(&app, "NEED_64_BIT");
                } else {
                    emit_console(&app, "INJECT_FAILED: CreateRemoteThread failed.");
                }
            } else {
                WaitForSingleObject(thread, INFINITE);
                CloseHandle(thread);
            }

            VirtualFreeEx(process, remote, 0, MEM_RELEASE);
            CloseHandle(process);
        }
    });
}

/// 32 位目标：spawn `x86/texthook-injector32.exe`（32 位辅助注入器）。
fn try_spawn_32bit_injector(pid: u32, app: &AppHandle) {
    let Some(dir) = exe_dir() else {
        emit_console(app, "32-bit target requires x86/texthook-injector32.exe");
        return;
    };
    let injector = dir.join(INJECTOR32);
    if !injector.exists() {
        emit_console(
            app,
            "32-bit target requires x86/texthook-injector32.exe (not found).",
        );
        return;
    }
    match std::process::Command::new(&injector)
        .arg(pid.to_string())
        .spawn()
    {
        Ok(_) => {}
        Err(e) => emit_console(app, format!("Failed to start 32-bit injector: {e}")),
    }
}

pub fn detach_process(pid: u32) -> Result<(), String> {
    if send(pid, &proto::build_detach_cmd()) {
        Ok(())
    } else {
        Err("Process not connected.".to_string())
    }
}

/// 对所有已连接进程发送 detach（退出程序时调用）。
pub fn detach_all() {
    let pids: Vec<u32> = PROCESSES.lock().unwrap().keys().copied().collect();
    for pid in pids {
        let _ = send(pid, &proto::build_detach_cmd());
    }
    // 给 DLL 一点时间处理 detach 并卸载自身，避免程序退出后 hook 残留。
    std::thread::sleep(std::time::Duration::from_millis(500));
}

pub fn insert_hook(app: &AppHandle, pid: u32, code: String) -> Result<(), String> {
    let Some(hp) = hookcode::parse(&code) else {
        return Err("Invalid hook code.".to_string());
    };
    let bitness = process_bitness(pid);
    let cmd = proto::build_insert_hook_cmd(&hp, bitness);
    if send(pid, &cmd) {
        Ok(())
    } else {
        let _ = app.emit("host-console", HostConsole {
            message: "INVALID_CODE".to_string(),
        });
        Err("Process not connected.".to_string())
    }
}

pub fn remove_hook(pid: u32, address: u64) -> Result<(), String> {
    if send(pid, &proto::build_remove_hook_cmd(address)) {
        Ok(())
    } else {
        Err("Process not connected.".to_string())
    }
}

pub fn find_hooks(pid: u32, sp: proto::SearchParam) -> Result<(), String> {
    let bitness = process_bitness(pid);
    let cmd = proto::build_find_hook_cmd(&sp, bitness);
    if send(pid, &cmd) {
        Ok(())
    } else {
        Err("Process not connected.".to_string())
    }
}

/// 更新 TextThread 相关设置（filterRepetition、flush 间距等）。
pub fn set_thread_settings(settings: crate::ThreadSettings) {
    *SETTINGS.lock().unwrap() = settings;
}

/// 返回当前进程中已知线程的 hook 码（用于 Remove hooks / Save hooks）。
pub fn list_hooks(pid: u32) -> Vec<crate::HookInfo> {
    let threads = THREADS.lock().unwrap();
    let mut hooks: Vec<crate::HookInfo> = threads
        .iter()
        .filter(|(k, _)| k.pid == pid)
        .filter_map(|(k, t)| t.hp.as_ref().map(|hp| (k.addr, hp)))
        .map(|(address, hp)| crate::HookInfo {
            code: hook_code(hp, pid),
            address,
            is_engine: hp.type_flags & proto::HOOK_ENGINE != 0,
            name: if hp.name.is_empty() { String::new() } else { hp.name.clone() },
        })
        .collect();
    hooks.sort_by(|a, b| a.code.cmp(&b.code));
    hooks.dedup_by(|a, b| a.address == b.address);
    hooks
}

pub fn save_hooks(
    pid: u32,
    codes: Vec<String>,
    current_thread: Option<(u64, u64, String)>,
) -> Result<(), String> {
    let Some(dir) = CONFIG_DIR.get() else {
        return Err("Config dir not initialized.".to_string());
    };
    let Some(exe) = saved::process_exe(pid) else {
        return Err("Cannot resolve process path.".to_string());
    };
    let current_thread = current_thread.map(|(ctx, ctx2, code)| saved::SavedThread {
        ctx,
        ctx2,
        code,
    });
    saved::save_hooks(dir, &exe, &codes, current_thread.as_ref());
    Ok(())
}

/// 定时扫描已保存进程并自动附加（等价于原版每 10 秒一次 `AttachSavedProcesses`，
/// 启动后先立即扫一次）。
pub fn auto_attach(app: &AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        if let Some(dir) = CONFIG_DIR.get() {
            let pids = saved::auto_attach_targets(dir);
            for pid in pids {
                // 与原版 alreadyAttached 一致：本会话内已连接过（或仍连接）的 PID
                // 不再重复注入，避免手动 detach 后被立刻自动重新附加。
                let already = ALREADY_ATTACHED.lock().unwrap().contains(&pid)
                    || PROCESSES.lock().unwrap().contains_key(&pid);
                if !already {
                    inject_process(pid, app.clone());
                }
            }
        }
        std::thread::sleep(Duration::from_secs(10));
    });
}
