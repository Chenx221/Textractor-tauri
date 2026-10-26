//! 从 GitHub Release 拉取本应用的更新日志。
//!
//! 为什么不用 tauri-plugin-updater 返回的 `body`：那条内容是构建时由
//! `tauri-action` 写进 `latest.json` 的 `notes`，也就是 `.github/workflows/release.yml`
//! 里 `releaseBody` 那段固定文本（安装包清单 + WebView2 提示），发版之后也不会变。
//! 真正的更新日志是发布后在 Release 页面上编辑的，只有走 GitHub API 才能拿到。
//!
//! 调用时机很少（打开"关于"、手动检查更新），所以在进程内按版本号缓存一份，
//! 避免反复消耗 GitHub 未登录 API 的 60 次/小时配额。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

/// 本应用仓库（与 `tauri.conf.json` 里 updater 的 endpoint 一致）。
const REPO: &str = "Chenx221/Textractor-tauri";
/// GitHub 不接受空 User-Agent。
const USER_AGENT: &str = "Textractor-tauri";
const TIMEOUT_MS: i32 = 15_000;

/// 一个 Release 里我们关心的字段。
#[derive(Serialize, Clone)]
pub struct ReleaseNotes {
    pub tag: String,
    pub name: String,
    /// Markdown 正文（Release 页面上显示的那段）。
    pub body: String,
    pub published_at: String,
    /// Release 页面地址，前端提供"在 GitHub 上查看"。
    pub url: String,
}

fn cache() -> &'static Mutex<HashMap<String, ReleaseNotes>> {
    static CACHE: OnceLock<Mutex<HashMap<String, ReleaseNotes>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 只允许 tag 里出现这些字符，避免把版本号直接拼进 URL 时注入路径。
fn safe_tag(tag: &str) -> Option<&str> {
    let ok = !tag.is_empty()
        && tag.len() <= 64
        && tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if ok {
        Some(tag)
    } else {
        None
    }
}

/// 由 semver 反推发布 tag。
///
/// 发布用的是日期式 tag（`v261007`），版本号是 `26.10.7`（见 `scripts/set-version.mjs`：
/// 年取后两位 + 月日各补两位），所以主猜测是 `v` + `YY` + `MM` + `DD`；再兜底几个常见写法，
/// 最后退回 `releases/latest`。猜错也只是多一次 404，不会把结果搞乱。
fn tag_candidates(version: &str) -> Vec<String> {
    let raw = version.trim().trim_start_matches('v');
    let mut out = Vec::new();
    let parts: Vec<&str> = raw.split('.').collect();
    if parts.len() == 3 {
        if let (Ok(y), Ok(m), Ok(d)) = (
            parts[0].parse::<u32>(),
            parts[1].parse::<u32>(),
            parts[2].parse::<u32>(),
        ) {
            // 年份看起来像 20xx 才当成日期式发布。
            if (20..=99).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d) {
                out.push(format!("v{y:02}{m:02}{d:02}"));
            }
        }
    }
    out.push(format!("v{raw}"));
    out.push(raw.to_string());
    out
}

#[cfg(target_os = "windows")]
fn get_json(url: &str) -> Result<serde_json::Value, String> {
    let headers = vec![
        format!("User-Agent: {USER_AGENT}"),
        "Accept: application/vnd.github+json".to_string(),
        "X-GitHub-Api-Version: 2022-11-28".to_string(),
    ];
    let bytes = crate::http::http_request("GET", url, &headers, &[], TIMEOUT_MS)?;
    serde_json::from_slice(&bytes).map_err(|e| format!("GitHub 返回内容无法解析：{e}"))
}

#[cfg(target_os = "windows")]
fn parse_release(value: &serde_json::Value) -> Option<ReleaseNotes> {
    // 404 / 403（限流）时 GitHub 返回 {"message": "..."}，没有 tag_name。
    let tag = value.get("tag_name")?.as_str()?.to_string();
    let text = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    Some(ReleaseNotes {
        tag,
        name: text("name"),
        body: text("body"),
        published_at: text("published_at"),
        url: text("html_url"),
    })
}

#[cfg(target_os = "windows")]
fn fetch_uncached(version: Option<&str>) -> Result<ReleaseNotes, String> {
    {
        let mut errors: Vec<String> = Vec::new();
        if let Some(version) = version {
            for tag in tag_candidates(version) {
                if safe_tag(&tag).is_none() {
                    continue;
                }
                let url = format!("https://api.github.com/repos/{REPO}/releases/tags/{tag}");
                match get_json(&url) {
                    Ok(value) => {
                        if let Some(notes) = parse_release(&value) {
                            return Ok(notes);
                        }
                        errors.push(format!("{tag}: 没有这个 tag"));
                    }
                    Err(err) => errors.push(format!("{tag}: {err}")),
                }
            }
        }
        // 兜底：最新发布（例如手工检查更新时并不知道确切版本）。
        let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
        match get_json(&url) {
            Ok(value) => match parse_release(&value) {
                Some(notes) => Ok(notes),
                None => Err(format!(
                    "GitHub 上没有找到可用的 Release（{}）",
                    errors.join("；")
                )),
            },
            Err(err) => Err(err),
        }
    }
}

/// 拿某个版本的更新日志；`version` 为空时取最新 Release。
#[tauri::command]
pub fn release_notes(version: Option<String>) -> Result<ReleaseNotes, String> {
    #[cfg(target_os = "windows")]
    {
        let key = version.clone().unwrap_or_else(|| "__latest__".to_string());
        if let Ok(cache) = cache().lock() {
            if let Some(hit) = cache.get(&key) {
                return Ok(hit.clone());
            }
        }
        let notes = fetch_uncached(version.as_deref())?;
        if let Ok(mut cache) = cache().lock() {
            // 顺手把"最新"也按版本号记一份，避免两条路径各请求一次。
            cache.insert(key, notes.clone());
            cache.insert(notes.tag.clone(), notes.clone());
        }
        Ok(notes)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = version;
        Err("Release notes are only fetched on Windows.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{safe_tag, tag_candidates};

    #[test]
    fn maps_version_to_date_tag() {
        assert_eq!(tag_candidates("26.10.7")[0], "v261007");
        assert_eq!(tag_candidates("26.9.27")[0], "v260927");
        // 非日期式版本没有 6 位紧凑形式，直接按 vX.Y.Z 猜。
        assert_eq!(tag_candidates("1.2.3")[0], "v1.2.3");
        assert_eq!(tag_candidates("v26.10.7")[0], "v261007");
    }

    #[test]
    fn rejects_unsafe_tags() {
        assert!(safe_tag("v261007").is_some());
        assert!(safe_tag("v26.10.7").is_some());
        assert!(safe_tag("v1/../../etc").is_none());
        assert!(safe_tag("").is_none());
    }
}
