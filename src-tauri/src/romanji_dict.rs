//! 罗马音（IPADIC）词典的运行时管理：状态查询、按需下载安装、删除。

use std::fs::{self, File};
use std::io::{self, Cursor};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager};

use crate::romanji;
use crate::http;
use crate::RomanjiDictStatus;

/// 词典版本：与 `Cargo.toml` 中的 `lindera` 版本保持一致。
pub const DICT_VERSION: &str = "6.2.0";

/// 压缩包内的词典目录名（安装时会去掉这一层目录）。
const ARCHIVE_DIR: &str = "lindera-ipadic";

/// 安装标记文件：记录安装时的词典版本，用于下次检测版本不匹配。
const VERSION_FILE: &str = "textractor-dict-version.txt";

/// 词典的关键文件（缺任何一个都说明安装不完整）。
const REQUIRED_FILES: &[&str] = &[
    "metadata.json",
    "char_def.bin",
    "unk.bin",
    "matrix.mtx",
    "dict.trie",
    "dict.vals",
    "dict.valsidx",
    "dict.words",
    "dict.wordsidx",
];

/// 下载用的 User-Agent（GitHub 不接受空 UA）。
const USER_AGENT: &str = "Textractor-tauri";

/// 下载超时（约 10MB 的包，留足余量）。
const DOWNLOAD_TIMEOUT_MS: i32 = 300_000;

/// 词典安装目录：`{app_config_dir}/dict/ipadic`。
pub fn dict_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    Ok(base.join("dict").join(ARCHIVE_DIR))
}

/// 预编译词典包的下载地址。
pub fn zip_url() -> String {
    format!(
        "https://github.com/lindera/lindera/releases/download/v{DICT_VERSION}/lindera-ipadic-{DICT_VERSION}.zip"
    )
}

/// 查询安装状态（体积供界面展示）。
pub fn status(app: &AppHandle) -> Result<RomanjiDictStatus, String> {
    let dir = dict_dir(app)?;
    let installed = romanji::is_installed(&dir);
    // 自定义词典：词条数/格式错误直接按当前文件内容解析，
    // 构建阶段（交给 lindera）的错误则来自上一次加载结果。
    let inspected = romanji::inspect_user_dict();
    let user_dict_error = inspected.error.or_else(|| romanji::user_dict_state().error);
    Ok(RomanjiDictStatus {
        installed,
        path: dir.to_string_lossy().to_string(),
        size_bytes: if installed { dir_size(&dir) } else { 0 },
        version: DICT_VERSION.to_string(),
        outdated: installed && needs_reinstall(&dir),
        load_error: if installed {
            romanji::load_error()
        } else {
            None
        },
        user_dict_exists: romanji::user_dict_path().is_some_and(|path| path.is_file()),
        user_dict_path: romanji::user_dict_path().map(|path| path.to_string_lossy().to_string()),
        user_dict_entries: inspected.entries,
        user_dict_error,
    })
}

/// 已安装的词典是否需要重新下载：
/// ① 版本标记与应用所需版本不一致（应用升级换了 lindera 版本）；
/// ② 关键文件缺失（安装不完整、被手工改动、或拷入了不匹配的词典）。
/// 没有版本标记时（例如用户手动拷入的完整词典）不据此判定，交给加载时校验。
fn needs_reinstall(dir: &Path) -> bool {
    if REQUIRED_FILES
        .iter()
        .any(|name| !dir.join(name).is_file())
    {
        return true;
    }
    match fs::read_to_string(dir.join(VERSION_FILE)) {
        Ok(text) => text.trim() != DICT_VERSION,
        Err(_) => false,
    }
}

/// 下载并安装词典（阻塞调用，调用方需放到 blocking 线程）。
pub fn install(app: &AppHandle) -> Result<(), String> {
    let dir = dict_dir(app)?;
    let parent = dir
        .parent()
        .ok_or_else(|| "invalid dictionary path".to_string())?
        .to_path_buf();
    fs::create_dir_all(&parent).map_err(|e| e.to_string())?;

    emit_stage(app, "downloading");
    let headers = vec![format!("User-Agent: {USER_AGENT}")];
    let archive = http::http_request("GET", &zip_url(), &headers, &[], DOWNLOAD_TIMEOUT_MS)?;
    // GitHub 的下载链接会重定向到 CDN；这里的校验顺带确认拿到的是 zip 而不是错误页。
    if archive.len() < 1024 || &archive[..2] != b"PK" {
        return Err(format!(
            "下载失败：返回内容不是词典压缩包（{} 字节）",
            archive.len()
        ));
    }

    emit_stage(app, "extracting");
    let tmp = parent.join("ipadic.tmp");
    let _ = fs::remove_dir_all(&tmp);
    extract_zip(&archive, &tmp)?;
    if !romanji::is_installed(&tmp) {
        let _ = fs::remove_dir_all(&tmp);
        return Err("词典压缩包内缺少 metadata.json".to_string());
    }
    // 记录安装版本，便于之后检测版本不匹配。
    fs::write(tmp.join(VERSION_FILE), DICT_VERSION).map_err(|e| {
        let _ = fs::remove_dir_all(&tmp);
        format!("写入词典版本标记失败：{e}")
    })?;

    let _ = fs::remove_dir_all(&dir);
    if let Err(err) = fs::rename(&tmp, &dir) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(format!("安装词典失败：{err}"));
    }

    // 让下次罗马音请求重新加载新词典。
    romanji::invalidate();
    emit_stage(app, "done");
    Ok(())
}

/// 删除已安装的词典。
pub fn uninstall(app: &AppHandle) -> Result<(), String> {
    let dir = dict_dir(app)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    romanji::invalidate();
    Ok(())
}

/// 解压 zip 内 `lindera-ipadic/` 下的文件到 `dest`（去掉这一层目录）。
fn extract_zip(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        // `enclosed_name` 会拒绝 `..` 之类的越界路径。
        let Some(path) = entry.enclosed_name() else {
            continue;
        };
        let Ok(rel) = path.strip_prefix(ARCHIVE_DIR) else {
            continue;
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out_path = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = File::create(&out_path).map_err(|e| e.to_string())?;
        io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn dir_size(dir: &Path) -> u64 {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.metadata().ok())
                .map(|meta| meta.len())
                .sum()
        })
        .unwrap_or(0)
}

#[derive(Clone, serde::Serialize)]
struct StageEvent {
    stage: &'static str,
}

/// 通知前端当前阶段（`downloading` / `extracting` / `done`）。
fn emit_stage(app: &AppHandle, stage: &'static str) {
    let _ = app.emit("romanji-dict-progress", StageEvent { stage });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 联网测试（默认忽略）：确认 release 资产能下载下来（含 GitHub 重定向）。
    /// 运行：`cargo test --lib romanji_dict -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn downloads_release_zip() {
        let headers = vec![format!("User-Agent: {USER_AGENT}")];
        let bytes =
            http::http_request("GET", &zip_url(), &headers, &[], DOWNLOAD_TIMEOUT_MS).unwrap();
        println!("downloaded {} bytes", bytes.len());
        assert!(bytes.len() > 1_000_000, "unexpected size: {}", bytes.len());
        assert_eq!(&bytes[..2], b"PK", "not a zip payload");
    }

    /// 联网测试（默认忽略）：完整跑一遍「下载 → 解压 → 加载 → 分词」。
    ///
    /// 若设置了 `TEXTACTOR_ROMANJI_TEST_ZIP`（本地已下载的 zip 路径）则跳过下载：
    /// 联网测试（默认忽略）：完整跑一遍「下载 → 解压 → 加载 → 分词」，
    /// 并验证自定义词典能覆盖 IPADIC 的错误断词/读音（如人名「刀哉」）。
    ///
    /// 若设置了 `TEXTACTOR_ROMANJI_TEST_ZIP`（本地已下载的 zip 路径）则跳过下载：
    /// `$env:TEXTACTOR_ROMANJI_TEST_ZIP="$env:TEMP\lindera-dict\ipadic.zip"`
    ///
    /// 注意：`romanji::init` 用的是 `OnceLock`（一个进程只生效一次），所以
    /// 词典加载与自定义词典必须放在同一个测试里，否则同时跑两个测试时
    /// 第二个 `init` 会被忽略。
    #[test]
    #[ignore]
    fn installs_and_loads_dictionary() {
        let bytes = match std::env::var("TEXTACTOR_ROMANJI_TEST_ZIP") {
            Ok(path) => fs::read(path).expect("failed to read the zip"),
            Err(_) => {
                let headers = vec![format!("User-Agent: {USER_AGENT}")];
                http::http_request("GET", &zip_url(), &headers, &[], DOWNLOAD_TIMEOUT_MS).unwrap()
            }
        };

        // 自定义词典与词典目录同级，所以这里多套一层 root。
        let root = std::env::temp_dir().join("textractor-romanji-dict-test");
        let _ = fs::remove_dir_all(&root);
        let dest = root.join("lindera-ipadic");
        extract_zip(&bytes, &dest).unwrap();

        // 解压应去掉 zip 内的 `lindera-ipadic/` 一层，直接得到词典文件。
        assert!(
            romanji::is_installed(&dest),
            "metadata.json missing after extraction"
        );
        assert!(
            dest.join("dict.words").is_file(),
            "dict.words missing after extraction"
        );

        romanji::init(dest);
        let out = romanji::romanize_ja("こんにちは、世界。");
        println!("romanji: {out}");
        assert!(out.starts_with("konnichi"), "unexpected romanji: {out}");

        // 没有自定义词典时，IPADIC 会把「刀哉」拆成「刀 + 哉」。
        let before = romanji::romanize_ja("刀哉");
        println!("without user dictionary: {before}");

        let user_dict = root.join(romanji::USER_DICT_FILE_NAME);
        fs::write(&user_dict, "刀哉\tとうや\n").unwrap();
        let state = romanji::reload();
        println!("user dictionary state: {state:?}");
        assert_eq!(state.entries, 1, "user dictionary was not parsed");

        let after = romanji::romanize_ja("よいか、刀哉よ");
        println!("with user dictionary: {after}");
        assert!(
            after.contains("touya"),
            "custom reading was not applied: {after}"
        );

        let _ = fs::remove_dir_all(&root);
    }
}
