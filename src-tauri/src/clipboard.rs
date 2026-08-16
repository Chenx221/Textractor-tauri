//! 剪贴板线程：轮询剪贴板序列号，变化时读取 Unicode 文本并转发为 Tauri 事件。
//! （原版用 WH_GETMESSAGE 钩子监听 WM_CLIPBOARDUPDATE，这里用轮询实现，更简单可靠。）

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard,
    SetClipboardData,
};
use windows_sys::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

/// 程序自身写入剪贴板时置位，让轮询线程跳过下一次变化（避免重复触发监听线程）。
static SUPPRESS_NEXT: AtomicBool = AtomicBool::new(false);

pub fn suppress_next() {
    SUPPRESS_NEXT.store(true, Ordering::SeqCst);
}

/// 将文本写入系统剪贴板，并抑制随后的轮询重复触发。
pub fn copy_unicode(text: &str) -> Result<(), String> {
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("OpenClipboard failed.".to_string());
        }
        let result = copy_unicode_inner(text);
        CloseClipboard();
        result
    }
}

unsafe fn copy_unicode_inner(text: &str) -> Result<(), String> {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = (wide.len() * 2) as usize;
    let handle = GlobalAlloc(GMEM_MOVEABLE, bytes);
    if handle.is_null() {
        return Err("GlobalAlloc failed.".to_string());
    }
    let ptr = GlobalLock(handle);
    if ptr.is_null() {
        return Err("GlobalLock failed.".to_string());
    }
    std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr as *mut u16, wide.len());
    GlobalUnlock(handle);

    if EmptyClipboard() == 0 {
        return Err("EmptyClipboard failed.".to_string());
    }
    if SetClipboardData(CF_UNICODETEXT as u32, handle).is_null() {
        return Err("SetClipboardData failed.".to_string());
    }
    suppress_next();
    Ok(())
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_seq = unsafe { GetClipboardSequenceNumber() };
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let seq = unsafe { GetClipboardSequenceNumber() };
            if seq == last_seq {
                continue;
            }
            last_seq = seq;

            // 程序自身写入剪贴板：跳过，避免重复触发剪切板监听线程。
            if SUPPRESS_NEXT.swap(false, Ordering::SeqCst) {
                continue;
            }

            if let Some(text) = read_unicode() {
                let _ = app.emit("host-clipboard", text);
            }
        }
    });
}

fn read_unicode() -> Option<String> {
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return None;
        }
        let result = read_unicode_inner();
        CloseClipboard();
        result
    }
}

unsafe fn read_unicode_inner() -> Option<String> {
    let handle = GetClipboardData(CF_UNICODETEXT as u32);
    if handle.is_null() {
        return None;
    }
    let ptr = GlobalLock(handle);
    if ptr.is_null() {
        return None;
    }
    let size = GlobalSize(handle);
    let units = std::slice::from_raw_parts(ptr as *const u16, size / 2);
    let len = units.iter().position(|&c| c == 0).unwrap_or(units.len());
    let text = String::from_utf16_lossy(&units[..len]);
    GlobalUnlock(handle);
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}
