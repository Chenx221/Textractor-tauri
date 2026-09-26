//! 通用 HTTP 客户端（WinHTTP）：供翻译后端调用外部翻译 API，绕开 WebView2 的 CORS 限制。

use std::ffi::c_void;

use windows_sys::Win32::Foundation::{GetLastError, BOOL};
use windows_sys::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryDataAvailable,
    WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetTimeouts,
};
use windows_sys::Win32::System::Diagnostics::Debug::{
    FormatMessageW, FORMAT_MESSAGE_FROM_SYSTEM, FORMAT_MESSAGE_IGNORE_INSERTS,
};

const WINHTTP_ACCESS_TYPE_DEFAULT_PROXY: u32 = 0;
const WINHTTP_FLAG_SECURE: u32 = 0x0080_0000;
const HTTPS_PORT: u16 = 443;

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 把 GetLastError 转成可读描述（含错误码），便于排查 WinHTTP 失败原因。
fn last_error_desc() -> String {
    unsafe {
        let code = GetLastError();
        let mut buf = vec![0u16; 512];
        let len = FormatMessageW(
            FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
            std::ptr::null(),
            code,
            0,
            buf.as_mut_ptr(),
            buf.len() as u32,
            std::ptr::null_mut(),
        );
        if len > 0 {
            let msg = String::from_utf16_lossy(&buf[..len as usize]);
            format!("{code} ({})", msg.trim_end_matches(['\r', '\n', ' ']))
        } else {
            format!("{code}")
        }
    }
}

fn split_url(url: &str) -> Option<(String, String)> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let slash = rest.find('/');
    match slash {
        Some(i) => Some((rest[..i].to_string(), rest[i..].to_string())),
        None => Some((rest.to_string(), "/".to_string())),
    }
}

/// 默认 User-Agent（请求头未显式指定 `User-Agent` 时使用）。
pub const DEFAULT_USER_AGENT: &str = "Textractor/1.0";

/// 进程级复用的 WinHTTP 会话句柄（按 User-Agent 缓存）：避免每次翻译请求都重新
/// 建立 TLS 会话/连接。
///
/// User-Agent 只能在 `WinHttpOpen` 里设定 —— 通过 `WinHttpSendRequest` 传
/// `User-Agent` 头不可靠，故按 UA 分别缓存会话（不同 Provider 可用不同 UA，
/// 例如 bing2 免费接口需要 Edge 的 UA）。
fn session_for(agent: &str) -> usize {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static SESSIONS: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
    let mut sessions = SESSIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    if let Some(handle) = sessions.get(agent) {
        return *handle;
    }
    let wide = to_wide(agent);
    let handle = unsafe {
        WinHttpOpen(
            wide.as_ptr(),
            WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
            std::ptr::null(),
            std::ptr::null(),
            0,
        ) as usize
    };
    sessions.insert(agent.to_string(), handle);
    handle
}

/// 取出请求头里的 `User-Agent`，返回 (agent, 其余请求头)。
fn split_user_agent(headers: &[String]) -> (String, Vec<String>) {
    let mut agent = DEFAULT_USER_AGENT.to_string();
    let mut rest = Vec::with_capacity(headers.len());
    for header in headers {
        match header.split_once(':') {
            Some((name, value)) if name.trim().eq_ignore_ascii_case("user-agent") => {
                agent = value.trim().to_string();
            }
            _ => rest.push(header.clone()),
        }
    }
    (agent, rest)
}

/// 发送 HTTP 请求并返回响应体。`headers` 每项形如 `"Name: Value"`。
pub fn http_request(
    method: &str,
    url: &str,
    headers: &[String],
    body: &[u8],
    timeout_ms: i32,
) -> Result<Vec<u8>, String> {
    unsafe {
        let (host, path) = split_url(url).ok_or_else(|| "Invalid URL.".to_string())?;

        let host_w = to_wide(&host);
        let path_w = to_wide(&path);
        let method_w = to_wide(method);

        let (agent, headers) = split_user_agent(headers);
        let session = session_for(&agent) as *mut c_void;
        if session.is_null() {
            return Err("WinHttpOpen failed.".to_string());
        }

        let connect = WinHttpConnect(session, host_w.as_ptr(), HTTPS_PORT, 0);
        if connect.is_null() {
            return Err(format!("WinHttpConnect failed: {}", last_error_desc()));
        }

        let request = WinHttpOpenRequest(
            connect,
            method_w.as_ptr(),
            path_w.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            WINHTTP_FLAG_SECURE,
        );
        if request.is_null() {
            WinHttpCloseHandle(connect);
            return Err(format!("WinHttpOpenRequest failed: {}", last_error_desc()));
        }
        WinHttpSetTimeouts(request, timeout_ms, timeout_ms, timeout_ms, timeout_ms);

        let header_str = headers.join("\r\n");
        let header_w = if header_str.is_empty() {
            Vec::new()
        } else {
            to_wide(&format!("{}\r\n", header_str))
        };
        // dwHeadersLength 是不含结尾 NUL 的字符数（to_wide 会额外追加一个 NUL）。
        // 之前多算了 1，导致 WinHTTP 把 NUL 当 header 内容解析 → SendRequest 静默失败。
        let header_len = header_w.len().saturating_sub(1) as u32;

        let sent = WinHttpSendRequest(
            request,
            if header_w.is_empty() { std::ptr::null() } else { header_w.as_ptr() },
            header_len,
            if body.is_empty() { std::ptr::null() } else { body.as_ptr() as *const c_void },
            body.len() as u32,
            body.len() as u32,
            0,
        );
        if sent == 0 {
            WinHttpCloseHandle(request);
            WinHttpCloseHandle(connect);
            return Err(format!("WinHttpSendRequest failed: {}", last_error_desc()));
        }

        let received = WinHttpReceiveResponse(request, std::ptr::null_mut());
        if received == 0 {
            WinHttpCloseHandle(request);
            WinHttpCloseHandle(connect);
            return Err(format!("WinHttpReceiveResponse failed: {}", last_error_desc()));
        }

        let mut response = Vec::new();
        loop {
            let mut available = 0u32;
            if WinHttpQueryDataAvailable(request, &mut available) == 0 {
                break;
            }
            if available == 0 {
                break;
            }
            let mut chunk = vec![0u8; available as usize];
            let mut read = 0u32;
            let ok: BOOL = WinHttpReadData(
                request,
                chunk.as_mut_ptr() as *mut c_void,
                available,
                &mut read,
            );
            if ok == 0 || read == 0 {
                break;
            }
            response.extend_from_slice(&chunk[..read as usize]);
        }

        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connect);
        Ok(response)
    }
}
