//! texthook 协议层：把 C++ 结构体（`ref/include/types.h` / `const.h` / `defs.h`）
//! 按目标进程位宽编解码。x86 与 x64 的差异集中在 `HookParam` / `SearchParam`
//! 里的函数指针与 `uintptr_t`，本模块按位宽选择布局，从而无需改动 texthook 源码。
#![allow(dead_code)]

pub const MAX_MODULE_SIZE: usize = 120;
pub const HOOK_NAME_SIZE: usize = 60;
pub const PATTERN_SIZE: usize = 30;
pub const MESSAGE_SIZE: usize = 500;
pub const MAX_HOOK: usize = 2500;
pub const PIPE_BUFFER_SIZE: usize = 50_000;

// ---- HookParamType 标志（const.h） ----
pub const USING_STRING: u32 = 0x1;
pub const USING_UNICODE: u32 = 0x2;
pub const BIG_ENDIAN: u32 = 0x4;
pub const DATA_INDIRECT: u32 = 0x8;
pub const USING_SPLIT: u32 = 0x10;
pub const SPLIT_INDIRECT: u32 = 0x20;
pub const MODULE_OFFSET: u32 = 0x40;
pub const FUNCTION_OFFSET: u32 = 0x80;
pub const USING_UTF8: u32 = 0x100;
pub const NO_CONTEXT: u32 = 0x200;
pub const HOOK_EMPTY: u32 = 0x400;
pub const FIXING_SPLIT: u32 = 0x800;
pub const DIRECT_READ: u32 = 0x1000;
pub const FULL_STRING: u32 = 0x2000;
pub const HEX_DUMP: u32 = 0x4000;
pub const HOOK_ENGINE: u32 = 0x8000;

// ---- 命令 / 通知类型（const.h） ----
pub const HOST_COMMAND_NEW_HOOK: i32 = 0;
pub const HOST_COMMAND_REMOVE_HOOK: i32 = 1;
pub const HOST_COMMAND_FIND_HOOK: i32 = 2;
pub const HOST_COMMAND_DETACH: i32 = 5;

pub const HOST_NOTIFICATION_TEXT: i32 = 0;
pub const HOST_NOTIFICATION_NEWHOOK: i32 = 1;
pub const HOST_NOTIFICATION_FOUND_HOOK: i32 = 2;
pub const HOST_NOTIFICATION_RMVHOOK: i32 = 3;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Bitness {
    X86,
    X64,
}

impl Bitness {
    pub fn hook_param_size(self) -> usize {
        match self {
            Bitness::X86 => 488,
            Bitness::X64 => 512,
        }
    }

    pub fn text_hook_size(self) -> usize {
        // 注意：sizeof(TextHook) 不只是 HookParam + 匿名 union，
        // 还包含 useCount / readerThread / readerEvent / err / trampoline。
        // 见 ref/texthook/texthook.h（x64 trampoline=140，x86=40）。
        match self {
            Bitness::X86 => 552,
            Bitness::X64 => 688,
        }
    }

    pub fn search_param_size(self) -> usize {
        match self {
            Bitness::X86 => 608,
            Bitness::X64 => 632,
        }
    }

    fn padding_off(self) -> usize {
        400
    }

    fn user_value_off(self) -> usize {
        match self {
            Bitness::X86 => 404,
            Bitness::X64 => 408,
        }
    }

    fn text_fun_off(self) -> usize {
        match self {
            Bitness::X86 => 408,
            Bitness::X64 => 416,
        }
    }

    fn name_off(self) -> usize {
        match self {
            Bitness::X86 => 424,
            Bitness::X64 => 448,
        }
    }
}

// ---- 规整后的 HookParam（Rust 原生表示） ----
#[derive(Clone, Debug, Default)]
pub struct HookParam {
    pub address: u64,
    pub offset: i32,
    pub index: i32,
    pub split: i32,
    pub split_index: i32,
    pub null_length: i32,
    pub module: String,
    pub function: String,
    pub type_flags: u32,
    pub codepage: u32,
    pub length_offset: i16,
    pub padding: u64,
    pub user_value: u32,
    pub name: String,
}

impl HookParam {
    pub fn write_to(&self, out: &mut Vec<u8>, b: Bitness) {
        put_u64(out, self.address);
        put_i32(out, self.offset);
        put_i32(out, self.index);
        put_i32(out, self.split);
        put_i32(out, self.split_index);
        put_i32(out, self.null_length);
        put_wchars(out, &self.module, MAX_MODULE_SIZE);
        put_bytes_padded(out, self.function.as_bytes(), MAX_MODULE_SIZE);
        put_u32(out, self.type_flags);
        put_u32(out, self.codepage);
        put_i16(out, self.length_offset);
        pad_to(out, b.padding_off());
        match b {
            Bitness::X86 => put_u32(out, self.padding as u32),
            Bitness::X64 => put_u64(out, self.padding),
        }
        put_u32(out, self.user_value);
        // 四个函数指针（text_fun/hook_fun/filter_fun/length_fun），主机侧恒为 0。
        match b {
            Bitness::X86 => {
                pad_to(out, b.text_fun_off());
                for _ in 0..4 {
                    put_u32(out, 0);
                }
            }
            Bitness::X64 => {
                pad_to(out, b.text_fun_off());
                for _ in 0..4 {
                    put_u64(out, 0);
                }
            }
        }
        put_bytes_padded(out, self.name.as_bytes(), HOOK_NAME_SIZE);
    }

    pub fn read_from(data: &[u8], b: Bitness) -> HookParam {
        HookParam {
            address: get_u64(data, 0),
            offset: get_i32(data, 8),
            index: get_i32(data, 12),
            split: get_i32(data, 16),
            split_index: get_i32(data, 20),
            null_length: get_i32(data, 24),
            module: get_wchars(data, 28, MAX_MODULE_SIZE),
            function: get_cstr(data, 268, MAX_MODULE_SIZE),
            type_flags: get_u32(data, 388),
            codepage: get_u32(data, 392),
            length_offset: get_i16(data, 396),
            padding: match b {
                Bitness::X86 => get_u32(data, 400) as u64,
                Bitness::X64 => get_u64(data, 400),
            },
            user_value: get_u32(data, b.user_value_off()),
            name: get_cstr(data, b.name_off(), HOOK_NAME_SIZE),
        }
    }
}

// ---- 规整后的 SearchParam ----
#[derive(Clone, Debug)]
pub struct SearchParam {
    pub pattern: [u8; PATTERN_SIZE],
    pub length: i32,
    pub offset: i32,
    pub search_time: i32,
    pub max_records: i32,
    pub codepage: i32,
    pub padding: u64,
    pub min_address: u64,
    pub max_address: u64,
    pub boundary_module: String,
    pub export_module: String,
    pub text: String,
}

impl Default for SearchParam {
    fn default() -> Self {
        SearchParam {
            pattern: [0; PATTERN_SIZE],
            length: 0,
            offset: 0,
            search_time: 30_000,
            max_records: 100_000,
            codepage: 932,
            padding: 0,
            min_address: 0,
            max_address: u64::MAX,
            boundary_module: String::new(),
            export_module: String::new(),
            text: String::new(),
        }
    }
}

impl SearchParam {
    pub fn write_to(&self, out: &mut Vec<u8>, b: Bitness) {
        out.extend_from_slice(&self.pattern);
        put_i32(out, self.length);
        put_i32(out, self.offset);
        put_i32(out, self.search_time);
        put_i32(out, self.max_records);
        put_i32(out, self.codepage);
        match b {
            Bitness::X86 => {
                pad_to(out, 52);
                put_u32(out, self.padding as u32);
                put_u32(out, self.min_address as u32);
                put_u32(out, self.max_address as u32);
            }
            Bitness::X64 => {
                pad_to(out, 56);
                put_u64(out, self.padding);
                put_u64(out, self.min_address);
                put_u64(out, self.max_address);
            }
        }
        put_wchars(out, &self.boundary_module, MAX_MODULE_SIZE);
        put_wchars(out, &self.export_module, MAX_MODULE_SIZE);
        put_wchars(out, &self.text, PATTERN_SIZE);
        match b {
            Bitness::X86 => put_u32(out, 0), // hookPostProcessor
            Bitness::X64 => {
                pad_to(out, 624);
                put_u64(out, 0);
            }
        }
    }
}

// ---- ThreadParam（x86/x64 布局一致：4 + pad4 + 3×u64 = 32 字节） ----
pub fn read_thread_param(data: &[u8]) -> Option<(u32, u64, u64, u64)> {
    if data.len() < 32 {
        return None;
    }
    Some((
        get_u32(data, 0),
        get_u64(data, 8),
        get_u64(data, 16),
        get_u64(data, 24),
    ))
}

// ---- 共享内存 TextHook 表查找 ----
pub fn read_text_hook(data: &[u8], b: Bitness, address: u64) -> Option<HookParam> {
    let size = b.text_hook_size();
    let hp_size = b.hook_param_size();
    for i in 0..MAX_HOOK {
        let base = i * size;
        if base + hp_size > data.len() {
            break;
        }
        if get_u64(data, base + hp_size) == address {
            return Some(HookParam::read_from(&data[base..base + hp_size], b));
        }
    }
    None
}

// ---- 命令构造 ----
pub fn build_insert_hook_cmd(hp: &HookParam, b: Bitness) -> Vec<u8> {
    let mut v = Vec::new();
    put_i32(&mut v, HOST_COMMAND_NEW_HOOK);
    pad_to(&mut v, 8);
    hp.write_to(&mut v, b);
    v
}

pub fn build_remove_hook_cmd(address: u64) -> Vec<u8> {
    let mut v = Vec::new();
    put_i32(&mut v, HOST_COMMAND_REMOVE_HOOK);
    pad_to(&mut v, 8);
    put_u64(&mut v, address);
    v
}

pub fn build_detach_cmd() -> Vec<u8> {
    HOST_COMMAND_DETACH.to_le_bytes().to_vec()
}

pub fn build_find_hook_cmd(sp: &SearchParam, b: Bitness) -> Vec<u8> {
    let mut v = Vec::new();
    put_i32(&mut v, HOST_COMMAND_FIND_HOOK);
    pad_to(&mut v, 8);
    sp.write_to(&mut v, b);
    v
}

// ---- 通知解析 ----
pub fn parse_hook_found(data: &[u8], b: Bitness) -> Option<(HookParam, String)> {
    let text_off = 8 + b.hook_param_size();
    if data.len() < text_off + 2 {
        return None;
    }
    let hp = HookParam::read_from(&data[8..], b);
    let text = get_wchars(data, text_off, MESSAGE_SIZE);
    Some((hp, text))
}

pub fn parse_hook_removed(data: &[u8]) -> Option<u64> {
    if data.len() < 16 {
        return None;
    }
    Some(get_u64(data, 8))
}

// ---- 编码 ----
pub fn codepage_to_encoding(cp: u32) -> &'static encoding_rs::Encoding {
    match cp {
        65001 => encoding_rs::UTF_8,
        1200 | 1201 => encoding_rs::UTF_16LE,
        932 => encoding_rs::SHIFT_JIS,
        936 | 54936 => encoding_rs::GBK,
        950 => encoding_rs::BIG5,
        51932 => encoding_rs::EUC_JP,
        874 => encoding_rs::WINDOWS_874,
        1250 => encoding_rs::WINDOWS_1250,
        1251 => encoding_rs::WINDOWS_1251,
        1252 => encoding_rs::WINDOWS_1252,
        1253 => encoding_rs::WINDOWS_1253,
        1254 => encoding_rs::WINDOWS_1254,
        1256 => encoding_rs::WINDOWS_1256,
        1257 => encoding_rs::WINDOWS_1257,
        1258 => encoding_rs::WINDOWS_1258,
        // 未知/默认回退到原版默认 codepage（Shift-JIS 932）
        _ => encoding_rs::SHIFT_JIS,
    }
}

// ---- 字节读写辅助 ----
fn put_u16(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn put_i16(v: &mut Vec<u8>, x: i16) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn put_u32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn put_i32(v: &mut Vec<u8>, x: i32) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn put_u64(v: &mut Vec<u8>, x: u64) {
    v.extend_from_slice(&x.to_le_bytes());
}

fn put_bytes_padded(v: &mut Vec<u8>, bytes: &[u8], n: usize) {
    let take = bytes.len().min(n);
    v.extend_from_slice(&bytes[..take]);
    for _ in take..n {
        v.push(0);
    }
}

fn put_wchars(v: &mut Vec<u8>, s: &str, n: usize) {
    let mut units: Vec<u16> = s.encode_utf16().collect();
    if units.len() > n {
        units.truncate(n);
    }
    for u in &units {
        put_u16(v, *u);
    }
    for _ in units.len()..n {
        put_u16(v, 0);
    }
}

fn pad_to(v: &mut Vec<u8>, offset: usize) {
    while v.len() < offset {
        v.push(0);
    }
}

fn get_u16(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([d[o], d[o + 1]])
}
fn get_i16(d: &[u8], o: usize) -> i16 {
    i16::from_le_bytes([d[o], d[o + 1]])
}
fn get_u32(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]])
}
fn get_i32(d: &[u8], o: usize) -> i32 {
    i32::from_le_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]])
}
fn get_u64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes([
        d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5], d[o + 6], d[o + 7],
    ])
}

fn get_wchars(d: &[u8], o: usize, n: usize) -> String {
    let mut units = Vec::new();
    for i in 0..n {
        if o + i * 2 + 1 >= d.len() {
            break;
        }
        let u = get_u16(d, o + i * 2);
        if u == 0 {
            break;
        }
        units.push(u);
    }
    String::from_utf16_lossy(&units)
}

fn get_cstr(d: &[u8], o: usize, n: usize) -> String {
    let mut bytes = Vec::new();
    for i in 0..n {
        if o + i >= d.len() {
            break;
        }
        let c = d[o + i];
        if c == 0 {
            break;
        }
        bytes.push(c);
    }
    String::from_utf8_lossy(&bytes).to_string()
}
