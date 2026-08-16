//! 32 位 texthook.dll 注入器。
//!
//! 由 64 位宿主在遇到 32 位目标时 spawn：`texthook-injector32.exe <pid>`。
//! 它会注入自己所在目录（x86/）下的 `texthook.dll`，DLL 随后连接回宿主的命名管道。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
use windows_sys::Win32::System::Diagnostics::Debug::WriteProcessMemory;
use windows_sys::Win32::System::LibraryLoader::{GetModuleFileNameW, LoadLibraryW};
use windows_sys::Win32::System::Memory::{
    VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE,
};
use windows_sys::Win32::System::Threading::{
    CreateRemoteThread, OpenProcess, WaitForSingleObject, INFINITE, LPTHREAD_START_ROUTINE,
    PROCESS_ALL_ACCESS,
};
use windows_sys::core::PCWSTR;

fn main() {
    let pid: u32 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if pid == 0 {
        std::process::exit(1);
    }
    if inject(pid) {
        std::process::exit(0);
    } else {
        std::process::exit(2);
    }
}

fn inject(pid: u32) -> bool {
    unsafe {
        let process = OpenProcess(PROCESS_ALL_ACCESS, 0, pid);
        if process.is_null() {
            return false;
        }

        let mut buf = vec![0u16; 32_768];
        let len = GetModuleFileNameW(std::ptr::null_mut(), buf.as_mut_ptr(), buf.len() as u32);
        if len == 0 {
            CloseHandle(process);
            return false;
        }
        let exe = String::from_utf16_lossy(&buf[..len as usize]);
        let dll = PathBuf::from(exe)
            .parent()
            .map(|p| p.join("texthook.dll"))
            .unwrap_or_default();
        if !dll.exists() {
            CloseHandle(process);
            return false;
        }

        let wide: Vec<u16> = dll
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let size = wide.len() * 2;

        let remote = VirtualAllocEx(
            process,
            std::ptr::null(),
            size,
            MEM_COMMIT | MEM_RESERVE,
            PAGE_READWRITE,
        );
        if remote.is_null() {
            CloseHandle(process);
            return false;
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
            return false;
        }

        let load_library: unsafe extern "system" fn(PCWSTR) -> windows_sys::Win32::Foundation::HMODULE =
            LoadLibraryW;
        let start: LPTHREAD_START_ROUTINE = std::mem::transmute(load_library);
        let thread = CreateRemoteThread(
            process,
            std::ptr::null(),
            0,
            start,
            remote,
            0,
            std::ptr::null_mut(),
        );
        if thread.is_null() {
            let _ = GetLastError();
            VirtualFreeEx(process, remote, 0, MEM_RELEASE);
            CloseHandle(process);
            return false;
        }
        WaitForSingleObject(thread, INFINITE);
        CloseHandle(thread);
        VirtualFreeEx(process, remote, 0, MEM_RELEASE);
        CloseHandle(process);
        true
    }
}
