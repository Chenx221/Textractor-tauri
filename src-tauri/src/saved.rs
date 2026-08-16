//! SavedGames.txt / SavedHooks.txt 持久化与自动 attach（等价于原版
//! `ProcessConnected` / `AttachSavedProcesses` / `SaveHooks` 的文件部分）。

use std::path::Path;

const GAME_SAVE_FILE: &str = "SavedGames.txt";
const HOOK_SAVE_FILE: &str = "SavedHooks.txt";

fn append_line(dir: &Path, file: &str, line: &str) {
    let path = dir.join(file);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    // 简单去重：整行已存在则跳过
    if existing.lines().any(|l| l == line) {
        return;
    }
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(line);
    content.push('\n');
    let _ = std::fs::write(&path, content);
}

/// 进程连接时记录（等价于原版把进程路径追加到 SavedGames.txt）。
pub fn record_game(dir: &Path, exe_path: &str) {
    append_line(dir, GAME_SAVE_FILE, exe_path);
}

/// 保存某个进程的 hook 码（等价于原版 SaveHooks）。
pub fn save_hooks(dir: &Path, exe_path: &str, codes: &[String]) {
    if codes.is_empty() {
        return;
    }
    let line = format!("{} , {}", exe_path, codes.join(" , "));
    append_line(dir, HOOK_SAVE_FILE, &line);
}

/// 读取该进程最后一次保存的 hook 码（忽略 "|ctx:ctx2:code" 这类保存的当前线程信息）。
pub fn saved_hook_codes_for(dir: &Path, exe_path: &str) -> Vec<String> {
    let content = match std::fs::read_to_string(dir.join(HOOK_SAVE_FILE)) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let line = match content.lines().rev().find(|l| l.starts_with(exe_path)) {
        Some(l) => l,
        None => return Vec::new(),
    };
    line.split(" , ")
        .skip(1)
        .filter(|part| !part.trim().is_empty() && !part.starts_with('|'))
        .map(|part| part.trim().to_string())
        .collect()
}

/// 进程 exe 全路径（用 sysinfo 枚举）。
pub fn process_exe(pid: u32) -> Option<String> {
    use sysinfo::{Pid, System};
    let mut sys = System::new_all();
    sys.refresh_all();
    sys.process(Pid::from_u32(pid))
        .and_then(|p| p.exe().map(|e| e.to_string_lossy().to_string()))
}

/// 从 SavedGames/SavedHooks 里移除该进程（等价于原版 ForgetProcess）。
pub fn forget(dir: &Path, exe_path: &str) {
    for file in [GAME_SAVE_FILE, HOOK_SAVE_FILE] {
        let path = dir.join(file);
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let kept: Vec<&str> = content.lines().filter(|l| !l.contains(exe_path)).collect();
        let text = if kept.is_empty() {
            String::new()
        } else {
            format!("{}\n", kept.join("\n"))
        };
        let _ = std::fs::write(&path, text);
    }
}

/// 自动 attach：返回需要注入的进程 PID（匹配 SavedGames/SavedHooks 里的 exe 路径）。
pub fn auto_attach_targets(dir: &Path) -> Vec<u32> {
    use sysinfo::System;

    let mut targets = std::collections::HashSet::new();
    if let Ok(content) = std::fs::read_to_string(dir.join(GAME_SAVE_FILE)) {
        for line in content.lines() {
            let line = line.trim();
            if !line.is_empty() {
                targets.insert(line.to_string());
            }
        }
    }
    if let Ok(content) = std::fs::read_to_string(dir.join(HOOK_SAVE_FILE)) {
        for line in content.lines() {
            if let Some(exe) = line.split(" , ").next() {
                let exe = exe.trim();
                if !exe.is_empty() {
                    targets.insert(exe.to_string());
                }
            }
        }
    }

    let mut sys = System::new_all();
    sys.refresh_all();

    let mut pids = Vec::new();
    for (pid, process) in sys.processes() {
        if let Some(exe) = process.exe() {
            let exe = exe.to_string_lossy().to_string();
            if targets.contains(&exe) {
                pids.push(pid.as_u32());
            }
        }
    }
    pids
}
