//! 翻译后端：查 SQLite 缓存 → 未命中调用翻译提供商 → 写缓存 → 返回译文。
//!
//! `TranslateResult` 带 `from_cache` 标记，前端据此展示“来自缓存”。
//! `TranslateRequest.skip_cache` 为 true 时跳过缓存读取（“重新翻译”），
//! 但仍会把新译文写回缓存，便于后续命中。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::crypto::{
    base64_encode, hmac_sha1_base64, hmac_sha256, md5_digest, md5_hex, sha256_hex,
};
use crate::http::http_request;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateRequest {
    pub provider: String,
    pub source: String,
    pub target: String,
    pub text: String,
    #[serde(default)]
    pub settings: Value,
    #[serde(default)]
    pub timeout_ms: Option<i32>,
    #[serde(default)]
    pub context: Vec<String>,
    /// 跳过缓存读取（“重新翻译”），仍然写入缓存。
    #[serde(default)]
    pub skip_cache: bool,
}

#[derive(Serialize)]
pub struct TranslateResult {
    pub translation: String,
    pub from_cache: bool,
}

fn get_str(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn to_string(body: Vec<u8>) -> Result<String, String> {
    String::from_utf8(body).map_err(|e| e.to_string())
}

/// HTML 实体反转义（translate-pa / 免费接口返回实体文本）。
/// 单次扫描、`&amp;` 最后匹配，避免 `&amp;quot;` 被二次解析（对齐 C++ HTML::Unescape）。
fn html_unescape(s: &str) -> String {
    const ENTITIES: &[(&str, char)] = &[
        ("&lt;", '<'),
        ("&gt;", '>'),
        ("&apos;", '\''),
        ("&#39;", '\''),
        ("&#x27;", '\''),
        ("&#X27;", '\''),
        ("&quot;", '"'),
        ("&amp;", '&'),
    ];
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            if let Some((ent, ch)) = ENTITIES.iter().find(|(ent, _)| s[i..].starts_with(ent)) {
                out.push(*ch);
                i += ent.len();
                continue;
            }
        }
        // 普通字符按 char 边界推进（兼容多字节 UTF-8）。
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn json_path<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for key in path {
        // 数字字符串按数组下标访问，否则按对象 key 访问。
        cur = match key.parse::<usize>() {
            Ok(idx) => cur.get(idx),
            Err(_) => cur.get(*key),
        }?;
    }
    Some(cur)
}

fn json_str(v: &Value, path: &[&str]) -> Option<String> {
    json_path(v, path).and_then(|x| x.as_str()).map(|s| s.to_string())
}

fn json_err(resp: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(resp) {
        if let Some(msg) = json_str(&v, &["error", "message"])
            .or_else(|| json_str(&v, &["Response", "Error", "Message"]))
            .or_else(|| json_str(&v, &["message"]))
            .or_else(|| v.get("error").and_then(|x| x.as_str()).map(|s| s.to_string()))
        {
            return msg;
        }
    }
    resp.to_string()
}

/// 主入口：查缓存 → 翻译 → 写缓存。
pub fn translate(
    db: &Mutex<rusqlite::Connection>,
    request: TranslateRequest,
) -> Result<TranslateResult, String> {
    // 1. 查缓存（先释放锁再请求）；“重新翻译”时跳过读取，强制请求提供商。
    if !request.skip_cache {
        let conn = db.lock().map_err(|e| e.to_string())?;
        if let Some(cached) = cache_get(&conn, &request)? {
            return Ok(TranslateResult {
                translation: cached,
                from_cache: true,
            });
        }
    }

    // 2. 调用提供商。
    let translated = call_provider(&request)?;

    // 3. 写缓存。
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        cache_put(&conn, &request, &translated)?;
    }

    Ok(TranslateResult {
        translation: translated,
        from_cache: false,
    })
}

fn cache_get(
    conn: &rusqlite::Connection,
    request: &TranslateRequest,
) -> Result<Option<String>, String> {
    use rusqlite::OptionalExtension;
    let mut stmt = conn
        .prepare(
            "SELECT translated_text FROM translation_cache \
             WHERE service = ?1 AND source_lang = ?2 AND target_lang = ?3 AND original_text = ?4",
        )
        .map_err(|e| e.to_string())?;
    stmt.query_row(
        rusqlite::params![request.provider, request.source, request.target, request.text],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn cache_put(
    conn: &rusqlite::Connection,
    request: &TranslateRequest,
    translated: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO translation_cache \
         (service, source_lang, target_lang, original_text, translated_text) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            request.provider,
            request.source,
            request.target,
            request.text,
            translated
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn timeout_of(request: &TranslateRequest) -> i32 {
    request.timeout_ms.unwrap_or(10_000).clamp(1_000, 300_000)
}

fn call_provider(request: &TranslateRequest) -> Result<String, String> {
    match request.provider.as_str() {
        "google" => google_translate(request),
        "google2" => google_translate2(request),
        "deepl" => deepl_translate(request),
        "openai" => openai_translate(request),
        "baidu" => baidu_translate(request),
        "aliyun" => aliyun_translate(request),
        "bing" => bing_translate(request),
        "bing2" => bing_translate2(request),
        "claude" => claude_translate(request),
        "deepseek" => deepseek_translate(request),
        "gemini" => gemini_translate(request),
        "lingocloud" => lingocloud_translate(request),
        "tencent" => tencent_translate(request),
        "tencenttransmart" => tencent_transmart_translate(request),
        other => Err(format!("Unknown provider: {other}")),
    }
}

// ---- Google Translate（免费，无需密钥） ----

fn google_translate(request: &TranslateRequest) -> Result<String, String> {
    // 2026-08: translate.googleapis.com 的 gtx 免费端点已被 Google 禁用（HTTP 429 返回 HTML），
    // 对齐 C++ 参考实现（googletranslate.cpp）无 authKey 分支，改用 translate-pa 接口。
    // 请求体新结构: [[[texts...], from, to], "te_lib"]（from/to 移到文本数组外层）。
    let payload = serde_json::json!([[[request.text], request.source, request.target], "te_lib"]);
    let url = "https://translate-pa.googleapis.com/v1/translateHtml";
    let headers = vec![
        "X-Goog-API-Key: AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520".to_string(),
        "Content-Type: application/json+protobuf".to_string(),
    ];
    let body = http_request("POST", url, &headers, payload.to_string().as_bytes(), timeout_of(request))?;
    let text = to_string(body)?;
    if text.is_empty() {
        return Err("Google empty response.".to_string());
    }
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    // 新响应结构: [["译文1","译文2",...], ["en","en",...]]
    // 译文中的 HTML 特殊字符会被转义成实体（如 &quot; &lt;），需反转义（对齐 C++ HTML::Unescape）。
    json.get(0)
        .and_then(|x| x.as_array())
        .and_then(|arr| arr.first())
        .and_then(|x| x.as_str())
        .map(html_unescape)
        .ok_or_else(|| format!("Google parse error: {text}"))
}

// ---- Google Translate2（google.com 免费端点） ----

fn google_translate2(request: &TranslateRequest) -> Result<String, String> {
    let inner = serde_json::json!([[request.text, request.source, request.target, 1, null, 2]]);
    let req = serde_json::json!([[[["MkEWBc", inner.to_string(), null, "generic"]]]]);
    let body = format!("f.req={}&", percent_encode(&req.to_string()));
    let url = "https://translate.google.com/_/TranslateWebserverUi/data/batchexecute?rpcids=MkEWBc";
    let headers = vec!["Content-Type: application/x-www-form-urlencoded;charset=UTF-8".to_string()];
    let resp = http_request("POST", url, &headers, body.as_bytes(), timeout_of(request))?;
    let text = to_string(resp)?;
    if text.is_empty() {
        return Err("Google2 empty response.".to_string());
    }

    let stripped = text.strip_prefix(")]}'").unwrap_or(&text);
    let data_line = stripped
        .lines()
        .nth(1)
        .map(|l| l.trim())
        .unwrap_or_else(|| stripped.trim());
    let json: Value = serde_json::from_str(data_line).map_err(|e| e.to_string())?;

    let translation_data = json
        .get(0)
        .and_then(|x| x.get(2))
        .and_then(|x| x.as_str())
        .ok_or_else(|| format!("Google2 parse error: {text}"))?;
    let td: Value = serde_json::from_str(translation_data).map_err(|e| e.to_string())?;
    let segments = td
        .get(1)
        .and_then(|x| x.get(0))
        .and_then(|x| x.get(0))
        .and_then(|x| x.get(5))
        .and_then(|x| x.as_array())
        .ok_or_else(|| format!("Google2 parse error: {text}"))?;

    let mut out = String::new();
    for seg in segments {
        if let Some(s) = seg.get(0).and_then(|x| x.as_str()) {
            out.push_str(s);
        }
    }
    if out.is_empty() {
        return Err(format!("Google2 empty translation: {text}"));
    }
    Ok(out)
}

// ---- DeepL（apiKey） ----

fn deepl_lang(code: &str) -> String {
    match code.to_lowercase().as_str() {
        "zh-cn" | "zh" | "zh-tw" => "ZH".to_string(),
        "auto" | "" => "".to_string(),
        other => other.to_uppercase(),
    }
}

fn deepl_translate(request: &TranslateRequest) -> Result<String, String> {
    let api_key = get_str(&request.settings, "apiKey");
    if api_key.is_empty() {
        return Err("DeepL API key is empty.".to_string());
    }
    let url = "https://api-free.deepl.com/v2/translate".to_string();
    let body = format!(
        "text={}&source_lang={}&target_lang={}",
        percent_encode(&request.text),
        deepl_lang(&request.source),
        deepl_lang(&request.target)
    );
    let headers = vec![
        format!("Authorization: DeepL-Auth-Key {api_key}"),
        "Content-Type: application/x-www-form-urlencoded".to_string(),
    ];
    let resp = http_request("POST", &url, &headers, body.as_bytes(), timeout_of(request))?;
    let text = to_string(resp)?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    json_str(&json, &["translations", "0", "text"]).ok_or_else(|| format!("DeepL parse error: {text}"))
}

// ---- OpenAI 兼容（baseUrl + apiKey + model） ----

fn openai_translate(request: &TranslateRequest) -> Result<String, String> {
    let base_url = get_str(&request.settings, "baseUrl");
    let api_key = get_str(&request.settings, "apiKey");
    let model = get_str(&request.settings, "model");
    if base_url.is_empty() || api_key.is_empty() {
        return Err("OpenAI baseUrl/apiKey is empty.".to_string());
    }
    let url = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));
    let model = if model.is_empty() { "gpt-4o-mini".to_string() } else { model };
    let payload = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": format!("You are a professional translator. Translate the user's text from {} to {}. Only output the translation.", request.source, request.target)},
            {"role": "user", "content": ai_user_prompt(request)},
        ],
    });
    let headers = vec![
        format!("Authorization: Bearer {api_key}"),
        "Content-Type: application/json".to_string(),
    ];
    let resp = http_request("POST", &url, &headers, payload.to_string().as_bytes(), timeout_of(request))?;
    let text = to_string(resp)?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    json_str(&json, &["choices", "0", "message", "content"])
        .map(|s| s.trim().to_string())
        .ok_or_else(|| format!("OpenAI parse error: {text}"))
}

// ---- Baidu（appId + appKey，MD5 签名） ----

fn baidu_translate(request: &TranslateRequest) -> Result<String, String> {
    let app_id = get_str(&request.settings, "appId");
    let app_key = get_str(&request.settings, "appKey");
    if app_id.is_empty() || app_key.is_empty() {
        return Err("Baidu appId/appKey is empty.".to_string());
    }
    let salt = format!(
        "{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let sign = md5_hex(&format!("{app_id}{}{salt}{app_key}", request.text));
    let body = format!(
        "q={}&from={}&to={}&appid={}&salt={}&sign={}",
        percent_encode(&request.text),
        request.source,
        request.target,
        app_id,
        salt,
        sign
    );
    let url = "https://fanyi-api.baidu.com/api/trans/vip/translate";
    let headers = vec!["Content-Type: application/x-www-form-urlencoded".to_string()];
    let resp = http_request("POST", url, &headers, body.as_bytes(), timeout_of(request))?;
    let text = to_string(resp)?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if let Some(code) = json.get("error_code").and_then(|x| x.as_str()) {
        let msg = json.get("error_msg").and_then(|x| x.as_str()).unwrap_or("");
        return Err(format!("Baidu error ({code}): {msg}"));
    }
    let arr = json
        .get("trans_result")
        .and_then(|x| x.as_array())
        .ok_or_else(|| json_err(&text))?;
    let mut out = String::new();
    for item in arr {
        if let Some(dst) = item.get("dst").and_then(|x| x.as_str()) {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(dst);
        }
    }
    if out.is_empty() {
        return Err(format!("Baidu parse error: {text}"));
    }
    Ok(out)
}

// ---- Aliyun（free 免费端点 / general+pro 签名端点） ----

fn aliyun_translate(request: &TranslateRequest) -> Result<String, String> {
    let version = get_str(&request.settings, "version");
    match version.as_str() {
        "pro" | "general" => aliyun_signed(request, &version),
        _ => aliyun_free(request),
    }
}

fn aliyun_free(request: &TranslateRequest) -> Result<String, String> {
    let token_url = "https://translate.alibaba.com/api/translate/csrftoken";
    let token_resp = http_request("GET", token_url, &[], &[], timeout_of(request))?;
    let token_text = to_string(token_resp)?;
    let token_json: Value = serde_json::from_str(&token_text).map_err(|e| e.to_string())?;
    let csrf = token_json
        .get("token")
        .and_then(|x| x.as_str())
        .ok_or_else(|| format!("Aliyun CSRF token not found: {token_text}"))?;

    let body = format!(
        "srcLang={}&tgtLang={}&domain=general&query={}&_csrf={}",
        request.source,
        request.target,
        percent_encode(&request.text),
        percent_encode(csrf)
    );
    let url = "https://translate.alibaba.com/api/translate/text";
    let headers = vec!["Content-Type: application/x-www-form-urlencoded".to_string()];
    let resp = http_request("POST", url, &headers, body.as_bytes(), timeout_of(request))?;
    let text = to_string(resp)?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let translation = json_str(&json, &["data", "translateText"])
        .ok_or_else(|| format!("Aliyun parse error: {text}"))?;
    Ok(html_unescape(&translation))
}

fn gmt_now() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs() as i64;
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let weekday = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"][((days + 4) % 7) as usize];
    let mut y = 1970i64;
    let mut d = days;
    loop {
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let len = if leap { 366 } else { 365 };
        if d < len {
            break;
        }
        d -= len;
        y += 1;
    }
    let months = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let mut month = 0;
    while month < 12 {
        let mlen = if month == 1 && leap { 29 } else { months[month] };
        if d < mlen {
            break;
        }
        d -= mlen;
        month += 1;
    }
    let mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month];
    format!("{weekday}, {d:02} {mon} {y} {h:02}:{m:02}:{s:02} GMT")
}

fn aliyun_signed(request: &TranslateRequest, version: &str) -> Result<String, String> {
    let auth_key = get_str(&request.settings, "authKey");
    let (access_key_id, access_key_secret) = match auth_key.split_once('|') {
        Some((id, key)) if !id.is_empty() && !key.is_empty() => (id.trim(), key.trim()),
        _ => return Err("Aliyun API key must be \"AccessKeyId|AccessKeySecret\".".to_string()),
    };

    let api_path = if version == "pro" {
        "/api/translate/web/ecommerce"
    } else {
        "/api/translate/web/general"
    };

    let payload = serde_json::json!({
        "FormatType": "text",
        "SourceLanguage": request.source,
        "TargetLanguage": request.target,
        "SourceText": request.text,
        "Scene": "general",
    });
    let body = payload.to_string();

    let content_md5 = base64_encode(&md5_digest(body.as_bytes()));
    let date = gmt_now();
    let nonce = format!(
        "{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let accept = "application/json";
    let content_type = "application/json;charset=utf-8";

    let string_to_sign = format!(
        "POST\n{accept}\n{content_md5}\n{content_type}\n{date}\nx-acs-signature-method:HMAC-SHA1\nx-acs-signature-nonce:{nonce}\nx-acs-version:2019-01-02\n{api_path}"
    );
    let signature = hmac_sha1_base64(access_key_secret, &string_to_sign);
    let authorization = format!("acs {access_key_id}:{signature}");

    let url = format!("https://mt.aliyuncs.com{api_path}");
    let headers = vec![
        format!("Accept: {accept}"),
        format!("Content-Type: {content_type}"),
        format!("Content-MD5: {content_md5}"),
        format!("Date: {date}"),
        format!("Authorization: {authorization}"),
        "x-acs-signature-method: HMAC-SHA1".to_string(),
        format!("x-acs-signature-nonce: {nonce}"),
        "x-acs-version: 2019-01-02".to_string(),
    ];
    let resp = http_request("POST", &url, &headers, body.as_bytes(), timeout_of(request))?;
    let text = to_string(resp)?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if let Some(code) = json.get("Code").and_then(|x| x.as_str()) {
        if code != "200" {
            let msg = json.get("Message").and_then(|x| x.as_str()).unwrap_or("");
            return Err(format!("Aliyun error ({code}): {msg}"));
        }
    }
    json_str(&json, &["Data", "Translated"])
        .or_else(|| json_str(&json, &["data", "translated"]))
        .ok_or_else(|| format!("Aliyun parse error: {text}"))
}

// ---- Bing（apiKey 可选：Azure 或免费 token） ----

/// 源语言是否为「自动检测」（前端值为 `auto-detect`，C++ 侧为 `?`）。
fn is_auto_source(source: &str) -> bool {
    source.is_empty() || source == "auto-detect" || source == "?"
}

fn bing_azure(request: &TranslateRequest, api_key: &str) -> Result<String, String> {
    let from = if is_auto_source(&request.source) {
        String::new()
    } else {
        format!("&from={}", request.source)
    };
    let url = format!(
        "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to={}{from}",
        request.target
    );
    let body = serde_json::json!([{"text": request.text}]).to_string();
    let headers = vec![
        "Content-Type: application/json; charset=UTF-8".to_string(),
        format!("Ocp-Apim-Subscription-Key: {api_key}"),
    ];
    let resp = http_request("POST", &url, &headers, body.as_bytes(), timeout_of(request))?;
    let text = to_string(resp)?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    json_str(&json, &["0", "translations", "0", "text"]).ok_or_else(|| json_err(&text))
}

fn bing_free_token() -> Result<String, String> {
    let resp = http_request("GET", "https://www.bing.com/translator", &[], &[], 10_000)?;
    let text = to_string(resp)?;
    let mut builder = String::new();
    let ts = (SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) / 100).to_string();
    if let Some(pos) = text.find(&format!("[{ts}")) {
        let after = &text[pos + 1..];
        builder.push_str("&key=");
        builder.push_str(after.get(0..13).unwrap_or(""));
        if let Some(tok) = after.get(16..48) {
            builder.push_str("&token=");
            builder.push_str(tok);
        }
    }
    if let Some(pos) = text.find("IG:\"") {
        if let Some(ig) = text.get(pos + 4..pos + 36) {
            builder.push_str("&IG=");
            builder.push_str(ig);
        }
    }
    if let Some(pos) = text.find("data-iid=\"") {
        if let Some(iid) = text.get(pos + 10..pos + 25) {
            builder.push_str("&IID=");
            builder.push_str(iid);
        }
    }
    if builder.is_empty() {
        return Err("Bing token not found in page.".to_string());
    }
    Ok(builder)
}

fn bing_translate(request: &TranslateRequest) -> Result<String, String> {
    let api_key = get_str(&request.settings, "apiKey");
    if !api_key.is_empty() {
        return bing_azure(request, &api_key);
    }
    let token = bing_free_token()?;
    let url = format!(
        "https://www.bing.com/ttranslatev3?fromLang={}&to={}&text={}{}",
        request.source,
        request.target,
        percent_encode(&request.text),
        token
    );
    let resp = http_request("POST", &url, &[], &[], timeout_of(request))?;
    let text = to_string(resp)?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    json_str(&json, &["0", "translations", "0", "text"]).ok_or_else(|| json_err(&text))
}

// ---- Bing2（edge.microsoft.com 免费接口） ----

/// Bing2 免费接口使用的 Edge UA（与 C++ bingtranslate2.cpp 一致；该端点要求像浏览器请求）。
const EDGE_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0 Textractor";

/// 免费接口改为直接 POST `edge.microsoft.com/translate/translatetext`：
/// 旧的「先 GET `/translate/auth` 取 Bearer token 再打 Azure 端点」流程已失效
/// （该 auth 端点现在返回 404），现在 from/to/isEnterpriseClient 直接放 URL，
/// body 为 `["文本"]`，响应取 `[0].translations[0].text`
/// （与 C++ bingtranslate2.cpp 无 authKey 分支一致）。
fn bing_translate2(request: &TranslateRequest) -> Result<String, String> {
    let api_key = get_str(&request.settings, "apiKey");
    if !api_key.is_empty() {
        return bing_azure(request, &api_key);
    }
    // 自动检测语言时 from 留空（edge 端点会返回 detectedLanguage）。
    let from = if is_auto_source(&request.source) {
        String::new()
    } else {
        request.source.clone()
    };
    let url = format!(
        "https://edge.microsoft.com/translate/translatetext?from={}&to={}&isEnterpriseClient=false",
        percent_encode(&from),
        percent_encode(&request.target)
    );
    let body = serde_json::json!([request.text]).to_string();
    let headers = vec![
        "Content-Type: application/json".to_string(),
        format!("User-Agent: {EDGE_USER_AGENT}"),
    ];
    let resp = http_request("POST", &url, &headers, body.as_bytes(), timeout_of(request))?;
    let text = to_string(resp)?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    json_str(&json, &["0", "translations", "0", "text"]).ok_or_else(|| json_err(&text))
}

// ---- Claude（Anthropic Messages API） ----

fn ai_lang_name(code: &str) -> String {
    if code.is_empty() || code == "auto" || code == "?" {
        "the same language".to_string()
    } else {
        code.to_string()
    }
}

fn ai_temperature(request: &TranslateRequest) -> f64 {
    request
        .settings
        .get("temperature")
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.3)
}

fn ai_system_prompt(request: &TranslateRequest) -> String {
    let s = get_str(&request.settings, "systemPrompt");
    if s.is_empty() {
        "You are a professional translator. Translate faithfully and keep original line breaks.".to_string()
    } else {
        s
    }
}

fn ai_user_prompt(request: &TranslateRequest) -> String {
    let mut prompt = format!(
        "Translate the following text from {} to {}. Return only the translation.",
        ai_lang_name(&request.source),
        ai_lang_name(&request.target),
    );
    if !request.context.is_empty() {
        prompt.push_str(
            "\nUse the PREVIOUS sentences for context only. NEVER translate or include them in the output.",
        );
        let n = request.context.len();
        for (i, sentence) in request.context.iter().enumerate() {
            prompt.push_str(&format!("\nPREVIOUS_{}: {}", n - i, sentence));
        }
    }
    prompt.push_str(&format!("\n\nTEXT TO TRANSLATE:\n{}", request.text));
    prompt
}

fn claude_translate(request: &TranslateRequest) -> Result<String, String> {
    let api_key = get_str(&request.settings, "apiKey");
    if api_key.is_empty() {
        return Err("Claude API key is empty.".to_string());
    }
    let host = get_str(&request.settings, "apiHost");
    let host = if host.is_empty() { "api.anthropic.com".to_string() } else { host };
    let path = get_str(&request.settings, "apiPath");
    let path = if path.is_empty() { "/v1/messages".to_string() } else { path };
    let model = get_str(&request.settings, "model");
    let model = if model.is_empty() { "claude-opus-4-7".to_string() } else { model };
    let system = ai_system_prompt(request);
    let temperature = ai_temperature(request);
    let enable_thinking = get_str(&request.settings, "enableThinking") == "true";

    let mut payload = serde_json::json!({
        "model": model,
        "max_tokens": if enable_thinking { 4096 } else { 1024 },
        "system": system,
        "temperature": temperature,
        "messages": [{"role": "user", "content": ai_user_prompt(request)}],
    });
    if enable_thinking {
        payload["thinking"] = serde_json::json!({"type": "enabled", "budget_tokens": 2048});
    }
    let url = format!("https://{}{}", host.trim_end_matches('/'), path);
    let headers = vec![
        format!("x-api-key: {api_key}"),
        "anthropic-version: 2023-06-01".to_string(),
        "Content-Type: application/json".to_string(),
    ];
    let resp = http_request("POST", &url, &headers, payload.to_string().as_bytes(), timeout_of(request))?;
    let text = to_string(resp)?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    // 思考模式下 content 数组的第一个块是 thinking，需要找到 text 块。
    json.get("content")
        .and_then(|x| x.as_array())
        .and_then(|arr| {
            arr.iter().find(|b| {
                b.get("type").and_then(|x| x.as_str()) == Some("text")
            })
        })
        .and_then(|b| b.get("text").and_then(|x| x.as_str()))
        .map(|s| s.trim().to_string())
        .ok_or_else(|| json_err(&text))
}

// ---- DeepSeek（OpenAI 兼容） ----

fn deepseek_translate(request: &TranslateRequest) -> Result<String, String> {
    let api_key = get_str(&request.settings, "apiKey");
    if api_key.is_empty() {
        return Err("DeepSeek API key is empty.".to_string());
    }
    let host = get_str(&request.settings, "apiHost");
    let host = if host.is_empty() { "api.deepseek.com".to_string() } else { host };
    let path = get_str(&request.settings, "apiPath");
    let path = if path.is_empty() { "/chat/completions".to_string() } else { path };
    let model = get_str(&request.settings, "model");
    let model = if model.is_empty() { "deepseek-flash".to_string() } else { model };
    let system = ai_system_prompt(request);
    let temperature = ai_temperature(request);
    let reasoning_effort = get_str(&request.settings, "reasoningEffort");
    let enable_thinking = get_str(&request.settings, "enableThinking") == "true";

    let mut payload = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": ai_user_prompt(request)},
        ],
    });
    if enable_thinking {
        payload["thinking"] = serde_json::json!({"type": "enabled"});
        let effort = if reasoning_effort.is_empty() {
            "high".to_string()
        } else {
            reasoning_effort
        };
        payload["reasoning_effort"] = serde_json::Value::String(effort);
    } else {
        // 关闭思考模式必须显式声明：deepseek-v4 系列默认开启思考（默认 effort=high），
        // 省略 thinking 字段会先输出大量思维链导致响应极慢。
        // 对齐 C++ ref/extensions/deepseektranslate.cpp 的 else 分支。
        payload["thinking"] = serde_json::json!({"type": "disabled"});
        payload["temperature"] = serde_json::json!(temperature);
    }

    let url = format!("https://{}{}", host.trim_end_matches('/'), path);
    let headers = vec![
        format!("Authorization: Bearer {api_key}"),
        "Content-Type: application/json".to_string(),
    ];
    let resp = http_request("POST", &url, &headers, payload.to_string().as_bytes(), timeout_of(request))?;
    let text = to_string(resp)?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    json_str(&json, &["choices", "0", "message", "content"])
        .map(|s| s.trim().to_string())
        .ok_or_else(|| json_err(&text))
}

// ---- Gemini（Google Generative Language API） ----

fn gemini_translate(request: &TranslateRequest) -> Result<String, String> {
    let api_key = get_str(&request.settings, "apiKey");
    if api_key.is_empty() {
        return Err("Gemini API key is empty.".to_string());
    }
    let host = get_str(&request.settings, "apiHost");
    let host = if host.is_empty() { "generativelanguage.googleapis.com".to_string() } else { host };
    let path = get_str(&request.settings, "apiPath");
    let path = if path.is_empty() {
        "/v1beta/models/".to_string()
    } else if path.ends_with('/') {
        path
    } else {
        format!("{path}/")
    };
    let model = get_str(&request.settings, "model");
    let model = if model.is_empty() { "gemini-3-flash-preview".to_string() } else { model };
    let system = ai_system_prompt(request);
    let temperature = ai_temperature(request);
    let enable_thinking = get_str(&request.settings, "enableThinking") == "true";

    let mut payload = serde_json::json!({
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": ai_user_prompt(request)}]}],
        "generationConfig": {"temperature": temperature},
    });
    if enable_thinking {
        payload["generationConfig"]["thinkingConfig"] = serde_json::json!({"thinkingBudget": 2048});
    }
    let url = format!(
        "https://{}{}{}:generateContent?key={}",
        host.trim_end_matches('/'),
        path,
        model,
        api_key
    );
    let headers = vec!["Content-Type: application/json".to_string()];
    let resp = http_request("POST", &url, &headers, payload.to_string().as_bytes(), timeout_of(request))?;
    let text = to_string(resp)?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    json_str(&json, &["candidates", "0", "content", "parts", "0", "text"])
        .map(|s| s.trim().to_string())
        .ok_or_else(|| json_err(&text))
}

// ---- Lingocloud（彩云小译） ----

fn lingocloud_translate(request: &TranslateRequest) -> Result<String, String> {
    let token = get_str(&request.settings, "apiKey");
    if token.is_empty() {
        return Err("Lingocloud token is empty.".to_string());
    }
    let detect = request.source == "auto" || request.source == "?";
    let payload = serde_json::json!({
        "source": [request.text],
        "trans_type": format!("{}2{}", request.source, request.target),
        "detect": detect,
    });
    let url = "https://api.interpreter.caiyunai.com/v1/translator";
    let headers = vec![
        "Content-Type: application/json".to_string(),
        format!("x-authorization: token {token}"),
    ];
    let resp = http_request("POST", url, &headers, payload.to_string().as_bytes(), timeout_of(request))?;
    let text = to_string(resp)?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if let Some(rc) = json.get("rc").and_then(|x| x.as_i64()) {
        if rc != 0 {
            let msg = json.get("message").and_then(|x| x.as_str()).unwrap_or("");
            return Err(format!("Lingocloud error (rc={rc}): {msg}"));
        }
    }
    let arr = json
        .get("target")
        .and_then(|x| x.as_array())
        .ok_or_else(|| json_err(&text))?;
    let mut out = String::new();
    for item in arr {
        if let Some(s) = item.as_str() {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(s);
        }
    }
    if out.is_empty() {
        return Err(format!("Lingocloud parse error: {text}"));
    }
    Ok(out)
}

// ---- Tencent（腾讯云 TMT，TC3-HMAC-SHA256 签名） ----

fn tencent_translate(request: &TranslateRequest) -> Result<String, String> {
    let secret_id = get_str(&request.settings, "secretId");
    let secret_key = get_str(&request.settings, "secretKey");
    let secret_id = secret_id.trim();
    let secret_key = secret_key.trim();
    if secret_id.is_empty() || secret_key.is_empty() {
        return Err("Tencent secretId/secretKey is empty.".to_string());
    }
    // 地域固定为上海。
    let region = "ap-shanghai";

    let service = "tmt";
    let host = "tmt.tencentcloudapi.com";
    let action = "TextTranslate";
    let version = "2018-03-21";
    let algorithm = "TC3-HMAC-SHA256";

    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let days = timestamp / 86400;
    let rem = timestamp % 86400;
    let _ = rem;
    let mut y = 1970i64;
    let mut d = days;
    loop {
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let len = if leap { 366 } else { 365 };
        if d < len {
            break;
        }
        d -= len;
        y += 1;
    }
    let months = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let mut month = 0;
    while month < 12 {
        let mlen = if month == 1 && leap { 29 } else { months[month] };
        if d < mlen {
            break;
        }
        d -= mlen;
        month += 1;
    }
    let date = {
        let month1 = month + 1;
        let day1 = d + 1;
        format!("{y:04}-{month1:02}-{day1:02}")
    };

    let payload = serde_json::json!({
        "SourceText": request.text,
        "Source": request.source,
        "Target": request.target,
        "ProjectId": 0,
    });
    let payload_str = payload.to_string();

    let canonical_headers = format!("content-type:application/json; charset=utf-8\nhost:{host}\n");
    let signed_headers = "content-type;host";
    let hashed_payload = sha256_hex(&payload_str);
    let canonical_request = format!("POST\n/\n\n{canonical_headers}\n{signed_headers}\n{hashed_payload}");
    let credential_scope = format!("{date}/{service}/tc3_request");
    let string_to_sign = format!(
        "{algorithm}\n{timestamp}\n{credential_scope}\n{}",
        sha256_hex(&canonical_request)
    );

    // TC3-HMAC-SHA256 链式签名：中间结果必须是原始 32 字节 digest，
    // 而不是 hex 字符串的 ASCII 字节（否则签名错误）。
    let k_date = hmac_sha256(format!("TC3{secret_key}").as_bytes(), date.as_bytes());
    let k_service = hmac_sha256(&k_date, service.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"tc3_request");
    let signature_bytes = hmac_sha256(&k_signing, string_to_sign.as_bytes());
    let signature: String = signature_bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();

    let authorization = format!(
        "{algorithm} Credential={secret_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );

    let headers = vec![
        "Content-Type: application/json; charset=utf-8".to_string(),
        format!("Authorization: {authorization}"),
        format!("X-TC-Action: {action}"),
        format!("X-TC-Timestamp: {timestamp}"),
        format!("X-TC-Version: {version}"),
        format!("X-TC-Region: {region}"),
    ];
    let url = "https://tmt.tencentcloudapi.com/";
    let resp = http_request("POST", url, &headers, payload_str.as_bytes(), timeout_of(request))?;
    let text = to_string(resp)?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if let Some(err) = json.get("Response").and_then(|r| r.get("Error")) {
        let code = err.get("Code").and_then(|x| x.as_str()).unwrap_or("");
        let msg = err.get("Message").and_then(|x| x.as_str()).unwrap_or("");
        return Err(format!("Tencent error ({code}): {msg}"));
    }
    json_str(&json, &["Response", "TargetText"]).ok_or_else(|| format!("Tencent parse error: {text}"))
}

// ---- Tencent transmart（免费端点） ----

fn tencent_transmart_translate(request: &TranslateRequest) -> Result<String, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let client_key = format!("browser-chrome-134.0.0-Windows_10-{}-{nanos}", nanos % 100000);
    let client_key = if client_key.len() > 100 { client_key[..100].to_string() } else { client_key };

    let payload = serde_json::json!({
        "header": {"fn": "auto_translation", "session": "", "client_key": client_key, "user": ""},
        "type": "plain",
        "model_category": "normal",
        "text_domain": "",
        "source": {"lang": request.source, "text_list": [request.text.replace('\u{200b}', "")]},
        "target": {"lang": request.target},
    });
    let url = "https://transmart.qq.com/api/imt";
    let headers = vec![
        "Content-Type: application/json".to_string(),
        "accept: application/json".to_string(),
    ];
    let resp = http_request("POST", url, &headers, payload.to_string().as_bytes(), timeout_of(request))?;
    let text = to_string(resp)?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    json_str(&json, &["auto_translation", "0"])
        .map(|s| html_unescape(&s))
        .ok_or_else(|| json_err(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bing2_request(source: &str, target: &str, text: &str) -> TranslateRequest {
        TranslateRequest {
            provider: "bing2".to_string(),
            source: source.to_string(),
            target: target.to_string(),
            text: text.to_string(),
            settings: Value::Null,
            timeout_ms: Some(20_000),
            context: Vec::new(),
            skip_cache: false,
        }
    }

    /// 联网测试（默认忽略）：`cargo test --lib bing2 -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bing2_free_endpoint() {
        let out = bing_translate2(&bing2_request("ja", "zh-Hans", "こんにちは、世界。")).unwrap();
        println!("bing2 ja -> zh-Hans: {out}");
        assert!(!out.trim().is_empty());
    }

    /// 自动检测源语言（`from=` 留空，由端点返回 detectedLanguage）。
    #[test]
    #[ignore]
    fn bing2_free_endpoint_auto_source() {
        let out = bing_translate2(&bing2_request("auto-detect", "zh-Hans", "Good morning")).unwrap();
        println!("bing2 auto -> zh-Hans: {out}");
        assert!(!out.trim().is_empty());
    }

    /// 离线验证“重新翻译”的跳过缓存语义：`skip_cache = true` 时即使缓存里有
    /// 结果也不会命中，而是再次调用提供商（这里用未知 provider 使调用失败，
    /// 从而证明缓存读取确实被绕过）。
    #[test]
    fn skip_cache_bypasses_cached_result() {
        let db = Mutex::new(rusqlite::Connection::open_in_memory().unwrap());
        {
            let conn = db.lock().unwrap();
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
        }

        let request = |skip_cache: bool| TranslateRequest {
            provider: "unknown-provider".to_string(),
            source: "ja".to_string(),
            target: "zh-Hans".to_string(),
            text: "こんにちは".to_string(),
            settings: Value::Null,
            timeout_ms: None,
            context: Vec::new(),
            skip_cache,
        };

        // 预置一条缓存记录（provider 与之匹配）。
        cache_put(&db.lock().unwrap(), &request(false), "你好").unwrap();

        // 常规路径：命中缓存，不调用提供商（未知 provider 也不会报错）。
        let cached = translate(&db, request(false)).unwrap();
        assert!(cached.from_cache);
        assert_eq!(cached.translation, "你好");

        // 重新翻译：绕过缓存 → 真的去调用提供商 → 未知 provider 报错。
        let message = match translate(&db, request(true)) {
            Ok(_) => panic!("skip_cache=true 应绕过缓存并调用提供商"),
            Err(e) => e,
        };
        assert!(message.contains("Unknown provider"), "意外错误：{message}");

        // 绕过缓存后仍会写回缓存。
        cache_put(&db.lock().unwrap(), &request(true), "您好").unwrap();
        assert_eq!(translate(&db, request(false)).unwrap().translation, "您好");
    }
}
