//! SavedGames.txt / SavedHooks.txt 持久化与自动 attach（等价于原版
//! `AttachSavedProcesses` / `SaveHooks` 的文件部分）。
//!
//! 与原版的差异说明：原版在 `ProcessConnected` 时会把进程路径追加进
//! SavedGames.txt，再由 `Auto attach`（默认关闭）决定是否自动附加；而
//! `Auto attach (saved only)`（默认开启）只自动附加 SavedHooks.txt 里的进程。
//! 本实现没有暴露这两个开关，因此只保留「保存过 hook 才自动附加」的行为：
//! 手动附加不写任何配置文件，也不会在重启后自动附加。

use std::path::Path;

const GAME_SAVE_FILE: &str = "SavedGames.txt";
const HOOK_SAVE_FILE: &str = "SavedHooks.txt";

/// 保存时记录的当前文本线程（等价于原版 SaveHooks 里的 `|ctx:ctx2:code`）。
#[derive(Clone, Debug)]
pub struct SavedThread {
    pub ctx: u64,
    pub ctx2: u64,
    pub code: String,
}

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

/// 保存某个进程的 hook 码（等价于原版 SaveHooks）。
/// `current_thread` 为点击保存时正在查看的文本线程（非控制台/剪贴板），
/// 保存后自动附加会恢复到该线程。
pub fn save_hooks(
    dir: &Path,
    exe_path: &str,
    codes: &[String],
    current_thread: Option<&SavedThread>,
) {
    if codes.is_empty() && current_thread.is_none() {
        return;
    }
    let mut parts: Vec<String> = Vec::with_capacity(1 + codes.len() + 1);
    parts.push(exe_path.to_string());
    parts.extend(codes.iter().cloned());
    if let Some(t) = current_thread {
        parts.push(format!("|{}:{}:{}", t.ctx, t.ctx2, t.code));
    }
    append_line(dir, HOOK_SAVE_FILE, &parts.join(" , "));
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

/// 读取该进程最后一次保存的当前线程信息（`|ctx:ctx2:code`）。
pub fn saved_thread_for(dir: &Path, exe_path: &str) -> Option<SavedThread> {
    let content = std::fs::read_to_string(dir.join(HOOK_SAVE_FILE)).ok()?;
    let line = content.lines().rev().find(|l| l.starts_with(exe_path))?;
    for part in line.split(" , ").skip(1) {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix('|') {
            return parse_saved_thread(rest);
        }
    }
    None
}

/// 解析 `ctx:ctx2:code`。code 本身可能包含 ':'（模块相对形式），只切前两个 ':'。
fn parse_saved_thread(rest: &str) -> Option<SavedThread> {
    let (ctx_s, after_ctx) = rest.split_once(':')?;
    let (ctx2_s, code) = after_ctx.split_once(':')?;
    let ctx = ctx_s.trim().parse::<u64>().ok()?;
    let ctx2 = ctx2_s.trim().parse::<u64>().ok()?;
    let code = code.trim();
    if code.is_empty() {
        return None;
    }
    Some(SavedThread {
        ctx,
        ctx2,
        code: code.to_string(),
    })
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

/// 自动 attach 的目标：返回 SavedHooks.txt 里保存过 hook、且当前正在运行的进程，
/// 按 exe 路径分组为 `(exe, PIDs)`（只匹配保存过 hook 的进程路径 —— 与原版
/// `Auto attach (saved only)` 一致）。
///
/// 之所以返回分组而不是平铺 PID：调用方需要区分「同名进程多开」—— 此时无法确定
/// 该附加哪一个（自动注入会同时附加到多个进程），应跳过并交给用户手动附加。
pub fn auto_attach_targets(dir: &Path) -> Vec<(String, Vec<u32>)> {
    use sysinfo::System;

    let mut targets = std::collections::HashSet::new();
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

    let mut by_exe: std::collections::BTreeMap<String, Vec<u32>> = std::collections::BTreeMap::new();
    for (pid, process) in sys.processes() {
        if let Some(exe) = process.exe() {
            let exe = exe.to_string_lossy().to_string();
            if targets.contains(&exe) {
                by_exe.entry(exe).or_default().push(pid.as_u32());
            }
        }
    }
    by_exe.into_iter().collect()
}
