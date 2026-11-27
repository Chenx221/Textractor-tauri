//! 翻译后端：查 SQLite 缓存 → 未命中调用翻译提供商 → 写缓存 → 返回译文。
//!
//! `TranslateResult` 带 `from_cache` 标记，前端据此展示“来自缓存”。
//! `TranslateRequest.skip_cache` 为 true 时跳过缓存读取（“重新翻译”），
//! 但仍会把新译文写回缓存，便于后续命中。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::crypto::{hmac_sha1_base64, hmac_sha256, md5_hex, sha256_hex};
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

// ---- Aliyun（OpenAPI：通用版 TranslateGeneral / 专业版 Translate） ----

/// 阿里云机器翻译（只有 OpenAPI 的通用版 / 专业版）。
///
/// 原来的 `free` 走 translate.alibaba.com 的网页接口，虽然没有鉴权、但会做敏感词
/// 审查，稍微露骨一点的句子就直接失败，实用价值很低，已经删掉。旧配置里
/// `version = "free"` 一律按通用版处理（凭据为空时会明确报错，而不是静默失败）。
fn aliyun_translate(request: &TranslateRequest) -> Result<String, String> {
    let version = get_str(&request.settings, "version");
    aliyun_signed(request, &version)
}

/// 把 Unix 秒拆成 UTC 的 (年, 月, 日, 时, 分, 秒)。
fn civil_utc(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (
        (rem / 3600) as u32,
        ((rem % 3600) / 60) as u32,
        (rem % 60) as u32,
    );

    let mut year = 1970i64;
    let mut day = days;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let len = if leap { 366 } else { 365 };
        if day < len {
            break;
        }
        day -= len;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let months = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 0usize;
    while month < 12 {
        let len = if month == 1 && leap { 29 } else { months[month] };
        if day < len {
            break;
        }
        day -= len;
        month += 1;
    }
    (year, month as u32 + 1, day as u32 + 1, h, mi, s)
}

/// 阿里云 RPC 要求的时间戳格式：`YYYY-MM-DDTHH:MM:SSZ`（UTC，不带毫秒）。
fn iso8601_utc_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = civil_utc(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// `SignatureNonce`：只要短时间窗口内唯一即可，用纳秒 + 进程号 + 序号拼成 UUID 形状。
fn aliyun_nonce() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed) as u16;
    let pid = std::process::id() as u16;
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (nanos >> 32) & 0xffff_ffff,
        (nanos >> 16) & 0xffff,
        seq & 0x0fff,
        pid,
        nanos & 0xffff_ffff_ffff
    )
}

/// 参数按 key 排序后做 RFC3986 编码，得到待签名 query（也就是表单 body 的前半段）。
fn aliyun_canonical(params: &[(String, String)]) -> String {
    let mut sorted: Vec<&(String, String)> = params.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    sorted
        .iter()
        .map(|(k, v)| format!("{}={}", percent_encode(k), percent_encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// 阿里云 RPC 签名：
/// `base64(HMAC-SHA1(secret + "&", METHOD + "&" + encode("/") + "&" + encode(canonicalQuery)))`。
fn aliyun_sign(method: &str, params: &[(String, String)], access_key_secret: &str) -> String {
    let string_to_sign = format!(
        "{method}&{}&{}",
        percent_encode("/"),
        percent_encode(&aliyun_canonical(params))
    );
    hmac_sha1_base64(&format!("{access_key_secret}&"), &string_to_sign)
}

/// 响应里的 `Code` 既可能是字符串 `"200"` 也可能是数字 `200`，也可能不存在（成功时）。
fn json_code(json: &Value) -> Option<String> {
    match json.get("Code") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// 阿里云机器翻译（OpenAPI RPC 风格）。
///
/// 旧实现是 ROA 风格：`Authorization: acs {id}:{sig}` + `x-acs-signature-*` 头部，
/// 时间放在 HTTP `Date` 头里。这套签名请求 `mt.aliyuncs.com` 会一直被拒：
/// 该接口按 RPC 规则从**表单参数** `Timestamp` 里取时间，头部那套它根本不读，
/// 于是表现成 `InvalidTimeStamp.Expired`（"没有可用的时间戳"）。
///
/// 现在与阿里云文档 / translator-go 的实现保持一致：
/// 全部参数走表单、按 key 排序做 RFC3986 编码、HMAC-SHA1 签名，版本固定 `2018-10-12`。
fn aliyun_signed(request: &TranslateRequest, version: &str) -> Result<String, String> {
    // 新版配置是两个独立字段。旧配置把它们用 `|` 拼在 `authKey` 里（前端
    // `mergeConfig` 会迁移），这里保留兜底，覆盖"被旧版本写回的配置"这种情况。
    let mut access_key_id = get_str(&request.settings, "accessKeyId");
    let mut access_key_secret = get_str(&request.settings, "accessKeySecret");
    if access_key_id.trim().is_empty() || access_key_secret.trim().is_empty() {
        if let Some((id, secret)) = get_str(&request.settings, "authKey").split_once('|') {
            if access_key_id.trim().is_empty() {
                access_key_id = id.trim().to_string();
            }
            if access_key_secret.trim().is_empty() {
                access_key_secret = secret.trim().to_string();
            }
        }
    }
    let access_key_id = access_key_id.trim().to_string();
    let access_key_secret = access_key_secret.trim().to_string();
    if access_key_id.is_empty() || access_key_secret.is_empty() {
        return Err(
            "Aliyun needs both AccessKey ID and AccessKey Secret (from the RAM console)."
                .to_string(),
        );
    }

    // pro = Translate（专业版），general = TranslateGeneral（通用版）。
    let action = if version == "pro" {
        "Translate"
    } else {
        "TranslateGeneral"
    };
    let params: Vec<(String, String)> = vec![
        ("AccessKeyId".to_string(), access_key_id.clone()),
        ("Action".to_string(), action.to_string()),
        ("Format".to_string(), "JSON".to_string()),
        ("FormatType".to_string(), "text".to_string()),
        ("Scene".to_string(), "general".to_string()),
        ("SignatureMethod".to_string(), "HMAC-SHA1".to_string()),
        ("SignatureNonce".to_string(), aliyun_nonce()),
        ("SignatureVersion".to_string(), "1.0".to_string()),
        ("SourceLanguage".to_string(), request.source.clone()),
        ("SourceText".to_string(), request.text.clone()),
        ("TargetLanguage".to_string(), request.target.clone()),
        ("Timestamp".to_string(), iso8601_utc_now()),
        ("Version".to_string(), "2018-10-12".to_string()),
    ];

    let signature = aliyun_sign("POST", &params, &access_key_secret);
    let mut body = aliyun_canonical(&params);
    body.push_str("&Signature=");
    body.push_str(&percent_encode(&signature));

    let headers = vec![
        "Content-Type: application/x-www-form-urlencoded; charset=utf-8".to_string(),
        "Accept: application/json".to_string(),
    ];
    let resp = http_request(
        "POST",
        "https://mt.aliyuncs.com/",
        &headers,
        body.as_bytes(),
        timeout_of(request),
    )?;
    let text = to_string(resp)?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if let Some(code) = json_code(&json) {
        if code != "200" {
            let msg = json.get("Message").and_then(|x| x.as_str()).unwrap_or("");
            return Err(format!("Aliyun error ({code}): {msg}"));
        }
    }
    json_str(&json, &["Data", "Translated"])
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
    /// 阿里云 RPC 签名文档里的 DescribeRegions 例子（与 translator-go 的用例一致）。
    #[test]
    fn aliyun_signature_matches_documented_example() {
        let params = vec![
            ("AccessKeyId".to_string(), "testid".to_string()),
            ("Action".to_string(), "DescribeRegions".to_string()),
            ("Format".to_string(), "XML".to_string()),
            ("SignatureMethod".to_string(), "HMAC-SHA1".to_string()),
            (
                "SignatureNonce".to_string(),
                "3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf".to_string(),
            ),
            ("SignatureVersion".to_string(), "1.0".to_string()),
            (
                "Timestamp".to_string(),
                "2016-02-23T12:46:24Z".to_string(),
            ),
            ("Version".to_string(), "2014-05-26".to_string()),
        ];
        assert_eq!(
            aliyun_sign("GET", &params, "testsecret"),
            "OLeaidS1JvxuMvnyHOwuJ+uX5qY="
        );
    }

    /// 参数必须按 key 排序，并按 RFC3986 编码（空格 %20、`*` %2A）。
    #[test]
    fn aliyun_canonical_sorts_and_encodes() {
        let params = vec![
            ("b".to_string(), "2".to_string()),
            ("a".to_string(), "1 2".to_string()),
            ("c".to_string(), "x*y".to_string()),
        ];
        assert_eq!(aliyun_canonical(&params), "a=1%202&b=2&c=x%2Ay");
    }

    /// 时间戳必须是 `YYYY-MM-DDTHH:MM:SSZ`（20 字符、UTC、无毫秒）。
    #[test]
    fn iso8601_timestamp_has_rpc_shape() {
        let stamp = iso8601_utc_now();
        assert_eq!(stamp.len(), 20, "意外格式：{stamp}");
        assert!(stamp.ends_with('Z'), "意外格式：{stamp}");
        assert_eq!(&stamp[10..11], "T", "意外格式：{stamp}");
        assert_eq!(&stamp[4..5], "-", "意外格式：{stamp}");
    }

    /// nonce 每次都要不同（同一纳秒内也要靠序号区分）。
    #[test]
    fn aliyun_nonce_is_unique() {
        let a = aliyun_nonce();
        let b = aliyun_nonce();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36, "应是 UUID 形状：{a}");
    }
}
