//! 日语文本 → 罗马音。
//!
//! 用 lindera（IPADIC）做形态素分析取得每个词的读音（片假名），再转成
//! Hepburn 罗马音。供“罗马音标注”增强扩展调用，只影响显示，不影响翻译。
//!
//! 词典不再编译进可执行文件（内嵌约占 46MB），改为由 `romanji_dict` 在运行时
//! 下载/解压到数据目录，这里按需从该目录动态加载；未安装时不显示罗马音。
//!
//! 除 IPADIC 外，还支持一份用户自建的文本词典（见 [`USER_DICT_FILE_NAME`]）：
//! IPADIC 对固有名词（人名、地名、作品名等）经常分词/注音错误，用户可以在
//! 这个 txt 里按「表记　读音」逐行补充，加载时被编译成 lindera 的用户词典
//! 与 IPADIC 合并使用（用户词条代价最低，优先级最高）。

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use lindera::dictionary::{load_dictionary, Dictionary, DictionaryBuilder, UserDictionary};
use lindera::mode::Mode;
use lindera::segmenter::Segmenter;

/// 词典目录（应用启动时由 [`init`] 注入）。
static DICT_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 自定义词典文件名（放在词典目录的同级，重装/删除 IPADIC 不会连带删掉）。
pub const USER_DICT_FILE_NAME: &str = "romanji-user.txt";

/// 新建自定义词典时写入的模板（含用法说明）。
const USER_DICT_TEMPLATE: &str = "# 罗马音自定义词典
#
# 每行一条：<表记><分隔符><读音>
#   分隔符可用 TAB、逗号或空格（推荐用 TAB）。
#   读音推荐写假名（自动转罗马音），也可以直接写罗马音。
#   以 # 开头的行为注释，空行忽略。
#   这里的词条优先于内置词典，用来纠正人名、地名等错误的断词与读音。
#
# 例：
# 刀哉	とうや
# よいか	よいか
#
# 保存后回到“罗马音词典”面板点“重载词典”即可生效。
";

/// 自定义词典文件的最近一次解析/构建结果。
#[derive(Clone, Debug, Default)]
pub struct UserDictState {
    /// 生效的词条数。
    pub entries: usize,
    /// 解析或构建失败的原因（无错误时为 `None`）。
    pub error: Option<String>,
}

/// 分词器缓存：`None` = 词典未安装或加载失败。
static SEGMENTER: OnceLock<Mutex<Option<Segmenter>>> = OnceLock::new();

/// 加载失败标记：避免每个文本块都重试加载数十 MB 的词典。
static LOAD_FAILED: AtomicBool = AtomicBool::new(false);

/// 最近一次加载失败的原因（供词典状态界面展示）。
static LOAD_ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();

/// 自定义词典的解析/构建结果（供词典状态界面展示）。
static USER_DICT_STATE: OnceLock<Mutex<UserDictState>> = OnceLock::new();

/// 注入词典目录（`setup` 中调用一次）。
pub fn init(dict_dir: PathBuf) {
    let _ = DICT_DIR.set(dict_dir);
}

/// 当前词典目录（未初始化时返回 `None`）。
pub fn dict_dir() -> Option<&'static Path> {
    DICT_DIR.get().map(PathBuf::as_path)
}

/// 自定义词典文件路径（`{词典目录}/../romanji-user.txt`）。
pub fn user_dict_path() -> Option<PathBuf> {
    DICT_DIR
        .get()
        .and_then(|dir| dir.parent())
        .map(|root| root.join(USER_DICT_FILE_NAME))
}

/// 若自定义词典文件不存在则写入模板，返回其路径。
pub fn ensure_user_dict_file() -> Result<PathBuf, String> {
    let path = user_dict_path()
        .ok_or_else(|| "romanji dictionary directory is not initialized".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if !path.is_file() {
        std::fs::write(&path, USER_DICT_TEMPLATE).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

/// 词典是否已就位（只看 `metadata.json`，避免为探测而加载整个词典）。
pub fn is_installed(dir: &Path) -> bool {
    dir.join("metadata.json").is_file()
}

/// 丢弃缓存的分词器（安装/删除词典、修改自定义词典后调用）。
pub fn invalidate() {
    LOAD_FAILED.store(false, Ordering::Relaxed);
    if let Ok(mut guard) = errors().lock() {
        *guard = None;
    }
    if let Ok(mut state) = user_state().lock() {
        *state = UserDictState::default();
    }
    if let Ok(mut guard) = cache().lock() {
        *guard = None;
    }
}

/// 丢弃缓存并立即重新加载（IPADIC + 自定义词典），返回自定义词典的结果。
/// 供“重载词典”按钮调用：能立刻把自定义词典里的语法错误反馈给界面。
pub fn reload() -> UserDictState {
    invalidate();
    // 触发一次加载：缓存已清空，`loaded()` 会重新读取词典与自定义词典。
    drop(loaded());
    user_dict_state()
}

/// 最近一次自定义词典加载的结果（未加载过时为默认值）。
pub fn user_dict_state() -> UserDictState {
    user_state()
        .lock()
        .map(|state| state.clone())
        .unwrap_or_default()
}

/// 直接按当前文件内容解析自定义词典（不加载 IPADIC），供状态界面显示。
pub fn inspect_user_dict() -> UserDictState {
    let Some(path) = user_dict_path() else {
        return UserDictState::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let parsed = parse_user_dict(&text);
            UserDictState {
                entries: parsed.entries.len(),
                error: parsed.error,
            }
        }
        // 文件不存在：视为没有自定义词典（不是错误）。
        Err(_) => UserDictState::default(),
    }
}

/// 最近一次词典加载失败的原因（无失败时为 `None`）。
pub fn load_error() -> Option<String> {
    errors().lock().ok().and_then(|guard| guard.clone())
}

fn errors() -> &'static Mutex<Option<String>> {
    LOAD_ERROR.get_or_init(|| Mutex::new(None))
}

fn user_state() -> &'static Mutex<UserDictState> {
    USER_DICT_STATE.get_or_init(|| Mutex::new(UserDictState::default()))
}

/// 自定义词典文本的解析结果：词条 + 第一条格式错误（如有）。
#[derive(Default)]
struct ParsedUserDict {
    entries: Vec<(String, String)>,
    error: Option<String>,
}

/// 把自定义词典文本解析成 `(表记, 读音)` 列表。
///
/// 格式：每行一条，`#` 开头为注释，空行忽略；表记与读音之间用第一个
/// TAB / 逗号 / 全角逗号 / 全角空格 / 半角空格分隔。
fn parse_user_dict(text: &str) -> ParsedUserDict {
    let mut parsed = ParsedUserDict::default();
    for (index, raw) in text.lines().enumerate() {
        // 去掉行首 BOM（用记事本“UTF-8 with BOM”保存时会出现）。
        let line = raw.trim().trim_start_matches('\u{FEFF}').trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("//") || line.starts_with(';')
        {
            continue;
        }
        match split_user_entry(line) {
            Some((surface, reading)) => {
                parsed.entries.push((surface.to_string(), reading.to_string()))
            }
            None if parsed.error.is_none() => {
                parsed.error = Some(format!("第 {} 行格式无效：{line}", index + 1));
            }
            None => {}
        }
    }
    parsed
}

/// 按第一个分隔符切开一行；表记或读音为空时返回 `None`。
fn split_user_entry(line: &str) -> Option<(&str, &str)> {
    for (index, character) in line.char_indices() {
        if matches!(character, '\t' | ',' | '，' | '　' | ' ') {
            let surface = line[..index].trim();
            let reading = line[index + character.len_utf8()..].trim();
            if !surface.is_empty() && !reading.is_empty() {
                return Some((surface, reading));
            }
            return None;
        }
    }
    None
}

/// 单个 CSV 字段的转义（含逗号/引号/换行时加引号）。
fn csv_field(field: &str) -> String {
    if field
        .chars()
        .any(|c| matches!(c, ',' | '"' | '\n' | '\r'))
    {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

/// 用解析结果构建 lindera 用户词典。
///
/// IPADIC 的 `user_dictionary_schema` 是 `表记,词性,读音` 三列，用户词典
/// 构建器会把这三列映射到完整 schema（读音落到 `details[7]`，即
/// [`reading_of`] 使用的那一列）。词性对罗马音显示没有影响，统一填 `名詞`。
fn build_user_dictionary(
    dictionary: &Dictionary,
    parsed: &ParsedUserDict,
) -> Result<UserDictionary, String> {
    let mut csv = String::new();
    for (surface, reading) in &parsed.entries {
        csv.push_str(&csv_field(surface));
        csv.push_str(",名詞,");
        csv.push_str(&csv_field(reading));
        csv.push('\n');
    }
    let builder = DictionaryBuilder::new((*dictionary.metadata).clone());
    builder
        .build_user_dict_from_reader(csv.as_bytes())
        .map_err(|e| e.to_string())
}

/// 读取并构建自定义词典（文件不存在或没有词条时返回 `None`，即只用 IPADIC）。
fn load_user_dictionary(dictionary: &Dictionary) -> Option<UserDictionary> {
    let path = user_dict_path()?;
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => return None,
    };
    let parsed = parse_user_dict(&text);
    // 空文件或只有注释（例如刚由模板创建）：不启用自定义词典，但不算错误。
    // 解析警告（个别行格式无效）无论如何都要展示出来。
    if parsed.entries.is_empty() {
        set_user_dict_state(0, parsed.error);
        return None;
    }
    match build_user_dictionary(dictionary, &parsed) {
        Ok(user_dictionary) => {
            set_user_dict_state(parsed.entries.len(), parsed.error);
            Some(user_dictionary)
        }
        Err(err) => {
            eprintln!(
                "[romanji] failed to build user dictionary from {}: {err}",
                path.display()
            );
            set_user_dict_state(0, Some(err));
            None
        }
    }
}

/// 记录自定义词典的解析/构建结果（供状态界面展示）。
fn set_user_dict_state(entries: usize, error: Option<String>) {
    if let Ok(mut guard) = user_state().lock() {
        *guard = UserDictState { entries, error };
    }
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
            Ok(dictionary) => {
                // 用户自定义词典（可选）：与 IPADIC 合并，词条优先级更高。
                let user_dictionary = load_user_dictionary(&dictionary);
                *guard = Some(Segmenter::new(Mode::Normal, dictionary, user_dictionary));
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_entries_with_all_delimiters() {
        let parsed = parse_user_dict(
            "# 注释\n\
             \n\
             刀哉\tとうや\n\
             よいか,よいか\n\
             竜宮城　りゅうぐうじょう\n\
             世界 せかい\n\
             ; 也是注释\n\
             // 还是注释\n",
        );
        assert_eq!(parsed.error, None);
        assert_eq!(
            parsed.entries,
            vec![
                ("刀哉".to_string(), "とうや".to_string()),
                ("よいか".to_string(), "よいか".to_string()),
                ("竜宮城".to_string(), "りゅうぐうじょう".to_string()),
                ("世界".to_string(), "せかい".to_string()),
            ]
        );
    }

    #[test]
    fn reports_first_malformed_line_and_keeps_valid_ones() {
        let parsed = parse_user_dict("刀哉\tとうや\n没有分隔符\n城\tしろ\n");
        assert_eq!(parsed.entries.len(), 2);
        let error = parsed.error.unwrap();
        assert!(error.contains("第 2 行"), "unexpected error: {error}");
    }

    #[test]
    fn strips_bom_and_ignores_blanks() {
        let parsed = parse_user_dict("\u{FEFF}刀哉\tとうや\n\n");
        assert_eq!(parsed.error, None);
        assert_eq!(parsed.entries.len(), 1);
        assert_eq!(parsed.entries[0].0, "刀哉");
    }

    #[test]
    fn csv_fields_are_escaped() {
        assert_eq!(csv_field("刀哉"), "刀哉");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("a\"b"), "\"a\"\"b\"");
    }

    /// 自定义词典模板本身必须是能被解析的（除了注释没有任何词条）。
    #[test]
    fn template_has_no_entries_and_no_error() {
        let parsed = parse_user_dict(USER_DICT_TEMPLATE);
        assert_eq!(parsed.entries.len(), 0);
        assert_eq!(parsed.error, None);
    }
}
