//! 日语文本 → 罗马音。
//!
//! 用 lindera（IPADIC）做形态素分析取得每个词的读音（片假名），再转成
//! Hepburn 罗马音。供“罗马音标注”增强扩展调用，只影响显示，不影响翻译。
//!
//! 词典不再编译进可执行文件（内嵌约占 46MB），改为由 `romanji_dict` 在运行时
//! 下载/解压到数据目录，这里按需从该目录动态加载；未安装时不显示罗马音。

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use lindera::dictionary::load_dictionary;
use lindera::mode::Mode;
use lindera::segmenter::Segmenter;

/// 词典目录（应用启动时由 [`init`] 注入）。
static DICT_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 分词器缓存：`None` = 词典未安装或加载失败。
static SEGMENTER: OnceLock<Mutex<Option<Segmenter>>> = OnceLock::new();

/// 加载失败标记：避免每个文本块都重试加载数十 MB 的词典。
static LOAD_FAILED: AtomicBool = AtomicBool::new(false);

/// 最近一次加载失败的原因（供词典状态界面展示）。
static LOAD_ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();

/// 注入词典目录（`setup` 中调用一次）。
pub fn init(dict_dir: PathBuf) {
    let _ = DICT_DIR.set(dict_dir);
}

/// 当前词典目录（未初始化时返回 `None`）。
pub fn dict_dir() -> Option<&'static Path> {
    DICT_DIR.get().map(PathBuf::as_path)
}

/// 词典是否已就位（只看 `metadata.json`，避免为探测而加载整个词典）。
pub fn is_installed(dir: &Path) -> bool {
    dir.join("metadata.json").is_file()
}

/// 丢弃缓存的分词器（安装/删除词典后调用）。
pub fn invalidate() {
    LOAD_FAILED.store(false, Ordering::Relaxed);
    if let Ok(mut guard) = errors().lock() {
        *guard = None;
    }
    if let Ok(mut guard) = cache().lock() {
        *guard = None;
    }
}

/// 最近一次词典加载失败的原因（无失败时为 `None`）。
pub fn load_error() -> Option<String> {
    errors().lock().ok().and_then(|guard| guard.clone())
}

fn errors() -> &'static Mutex<Option<String>> {
    LOAD_ERROR.get_or_init(|| Mutex::new(None))
}

fn cache() -> &'static Mutex<Option<Segmenter>> {
    SEGMENTER.get_or_init(|| Mutex::new(None))
}

/// 取分词器锁，并确保词典已加载（未安装/加载失败时内部为 `None`）。
fn loaded() -> Option<MutexGuard<'static, Option<Segmenter>>> {
    let mut guard = cache().lock().ok()?;
    if guard.is_none() && !LOAD_FAILED.load(Ordering::Relaxed) {
        let Some(dir) = dict_dir() else {
            return Some(guard);
        };
        let path = dir.to_string_lossy().to_string();
        match load_dictionary(&path) {
            Ok(dictionary) => *guard = Some(Segmenter::new(Mode::Normal, dictionary, None)),
            Err(err) => {
                // 词典缺失或格式版本不匹配：本次及后续调用都不再重试
                // （安装/删除词典后会调用 `invalidate` 重置）。
                let message = err.to_string();
                eprintln!("[romanji] failed to load ipadic dictionary from {path}: {message}");
                if let Ok(mut guard) = errors().lock() {
                    *guard = Some(message);
                }
                LOAD_FAILED.store(true, Ordering::Relaxed);
            }
        }
    }
    Some(guard)
}

/// 把一段日文转成罗马音（词间以空格分隔）。
/// 词典未安装时返回空串（前端据此不显示罗马音）；无法分词的输入原样返回。
pub fn romanize_ja(text: &str) -> String {
    let Some(mut guard) = loaded() else {
        return String::new();
    };
    let Some(segmenter) = guard.as_mut() else {
        return String::new();
    };
    let Ok(tokens) = segmenter.segment(Cow::Borrowed(text)) else {
        return text.to_string();
    };

    let mut out = String::new();
    for mut token in tokens {
        let reading = reading_of(&mut token);
        if reading.is_empty() {
            continue;
        }
        let prev_alnum = out.chars().last().is_some_and(|c| c.is_alphanumeric());
        let cur_alnum = reading.chars().next().is_some_and(|c| c.is_alphanumeric());
        if prev_alnum && cur_alnum {
            out.push(' ');
        }
        out.push_str(&reading);
    }
    out
}

/// 取单个 token 的读音：
/// - 表面形式全为假名 → 直接转罗马音；
/// - 否则优先用词典读音（IPADIC details 第 8 列）；
/// - 都没有则原样保留表面形式（标点、数字、拉丁等）。
fn reading_of(token: &mut lindera::token::Token) -> String {
    let surface = token.surface.to_string();
    if surface.chars().all(is_kana) {
        return kana_to_romaji(&surface);
    }
    let details = token.details();
    if details.len() > 7 {
        let reading = details[7];
        if !reading.is_empty() && reading != "*" {
            return kana_to_romaji(reading);
        }
    }
    surface
}

fn is_kana(c: char) -> bool {
    matches!(c, '\u{3040}'..='\u{309F}' | '\u{30A0}'..='\u{30FF}')
}

/// 片假名 → 平假名（Unicode 偏移 0x60），用于统一映射表。
fn normalize_kana(c: char) -> char {
    match c {
        '\u{30A1}'..='\u{30F6}' => char::from_u32(c as u32 - 0x60).unwrap_or(c),
        other => other,
    }
}

/// 假名串 → Hepburn 罗马音。
fn kana_to_romaji(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // 促音「っ/ッ」：双写下一个假名罗马音的首辅音。
        if c == 'っ' || c == 'ッ' {
            if i + 1 < chars.len() {
                if let Some(next) = single_romaji(chars[i + 1]) {
                    if let Some(first) = next.chars().next() {
                        if first.is_ascii_alphabetic()
                            && !matches!(first, 'a' | 'i' | 'u' | 'e' | 'o')
                        {
                            out.push(first);
                        }
                    }
                }
            }
            i += 1;
            continue;
        }
        // 拗音（两个假名的组合）。
        if i + 1 < chars.len() {
            if let Some(r) = digraph_romaji(chars[i], chars[i + 1]) {
                out.push_str(r);
                i += 2;
                continue;
            }
        }
        match single_romaji(c) {
            Some(r) => out.push_str(r),
            None => out.push(c),
        }
        i += 1;
    }
    out
}

/// 单假名 → 罗马音（含片假名，长音符和「ヴ」特殊处理）。
fn single_romaji(c: char) -> Option<&'static str> {
    let c = match c {
        'ー' => return Some(""),
        'ヴ' => return Some("vu"),
        other => normalize_kana(other),
    };
    let romaji = match c {
        'あ' => "a",
        'い' => "i",
        'う' => "u",
        'え' => "e",
        'お' => "o",
        'か' => "ka",
        'き' => "ki",
        'く' => "ku",
        'け' => "ke",
        'こ' => "ko",
        'が' => "ga",
        'ぎ' => "gi",
        'ぐ' => "gu",
        'げ' => "ge",
        'ご' => "go",
        'さ' => "sa",
        'し' => "shi",
        'す' => "su",
        'せ' => "se",
        'そ' => "so",
        'ざ' => "za",
        'じ' => "ji",
        'ず' => "zu",
        'ぜ' => "ze",
        'ぞ' => "zo",
        'た' => "ta",
        'ち' => "chi",
        'つ' => "tsu",
        'て' => "te",
        'と' => "to",
        'だ' => "da",
        'ぢ' => "ji",
        'づ' => "zu",
        'で' => "de",
        'ど' => "do",
        'な' => "na",
        'に' => "ni",
        'ぬ' => "nu",
        'ね' => "ne",
        'の' => "no",
        'は' => "ha",
        'ひ' => "hi",
        'ふ' => "fu",
        'へ' => "he",
        'ほ' => "ho",
        'ば' => "ba",
        'び' => "bi",
        'ぶ' => "bu",
        'べ' => "be",
        'ぼ' => "bo",
        'ぱ' => "pa",
        'ぴ' => "pi",
        'ぷ' => "pu",
        'ぺ' => "pe",
        'ぽ' => "po",
        'ま' => "ma",
        'み' => "mi",
        'む' => "mu",
        'め' => "me",
        'も' => "mo",
        'や' => "ya",
        'ゆ' => "yu",
        'よ' => "yo",
        'ら' => "ra",
        'り' => "ri",
        'る' => "ru",
        'れ' => "re",
        'ろ' => "ro",
        'わ' => "wa",
        'を' => "o",
        'ん' => "n",
        'ぁ' => "a",
        'ぃ' => "i",
        'ぅ' => "u",
        'ぇ' => "e",
        'ぉ' => "o",
        'ゃ' => "ya",
        'ゅ' => "yu",
        'ょ' => "yo",
        'ゎ' => "wa",
        _ => return None,
    };
    Some(romaji)
}

/// 拗音组合（きゃ、しゃ、ちゃ…）→ 罗马音。
fn digraph_romaji(a: char, b: char) -> Option<&'static str> {
    let a = normalize_kana(a);
    let b = normalize_kana(b);
    let romaji = match (a, b) {
        ('き', 'ゃ') => "kya",
        ('き', 'ゅ') => "kyu",
        ('き', 'ょ') => "kyo",
        ('し', 'ゃ') => "sha",
        ('し', 'ゅ') => "shu",
        ('し', 'ょ') => "sho",
        ('ち', 'ゃ') => "cha",
        ('ち', 'ゅ') => "chu",
        ('ち', 'ょ') => "cho",
        ('に', 'ゃ') => "nya",
        ('に', 'ゅ') => "nyu",
        ('に', 'ょ') => "nyo",
        ('ひ', 'ゃ') => "hya",
        ('ひ', 'ゅ') => "hyu",
        ('ひ', 'ょ') => "hyo",
        ('み', 'ゃ') => "mya",
        ('み', 'ゅ') => "myu",
        ('み', 'ょ') => "myo",
        ('り', 'ゃ') => "rya",
        ('り', 'ゅ') => "ryu",
        ('り', 'ょ') => "ryo",
        ('ぎ', 'ゃ') => "gya",
        ('ぎ', 'ゅ') => "gyu",
        ('ぎ', 'ょ') => "gyo",
        ('じ', 'ゃ') => "ja",
        ('じ', 'ゅ') => "ju",
        ('じ', 'ょ') => "jo",
        ('び', 'ゃ') => "bya",
        ('び', 'ゅ') => "byu",
        ('び', 'ょ') => "byo",
        ('ぴ', 'ゃ') => "pya",
        ('ぴ', 'ゅ') => "pyu",
        ('ぴ', 'ょ') => "pyo",
        _ => return None,
    };
    Some(romaji)
}
