//! `/H` / `/R` 码解析与生成（等价于 ref/host/hookcode.cpp 的 HookCode::Parse / Generate）。
//! 生成时不尝试把地址转成模块相对（等价于传入 processId=0）。

use crate::proto::{
    HookParam, BIG_ENDIAN, DATA_INDIRECT, DIRECT_READ, FULL_STRING, FUNCTION_OFFSET, HEX_DUMP,
    MODULE_OFFSET, NO_CONTEXT, SPLIT_INDIRECT, USING_SPLIT, USING_STRING, USING_UNICODE, USING_UTF8,
};

pub fn parse(code: &str) -> Option<HookParam> {
    let mut code = code.trim().to_string();
    if code.starts_with('/') {
        code.remove(0);
    }
    if let Some(pos) = code.find('/') {
        code.truncate(pos); // 兼容旧 AGTH 风格：忽略第一个 '/' 之后的部分
    }
    let code = code.trim().to_string();
    if code.starts_with('R') {
        parse_r(&code[1..])
    } else if code.starts_with('H') {
        parse_h(&code[1..])
    } else {
        None
    }
}

pub fn generate(hp: &HookParam) -> String {
    if hp.type_flags & DIRECT_READ != 0 {
        generate_r(hp)
    } else {
        generate_h(hp)
    }
}

fn parse_r(s: &str) -> Option<HookParam> {
    let mut hp = HookParam::default();
    hp.type_flags |= DIRECT_READ;

    let mut rest = s;
    let first = rest.chars().next()?;
    match first {
        'S' => {}
        'Q' => hp.type_flags |= USING_UNICODE,
        'V' => hp.type_flags |= USING_UTF8,
        'M' => hp.type_flags |= USING_UNICODE | HEX_DUMP,
        _ => return None,
    }
    rest = &rest[first.len_utf8()..];

    if let Some((v, len)) = consume_decimal_then(rest, '<') {
        hp.null_length = v;
        rest = &rest[len..];
    }
    if let Some((v, len)) = consume_decimal_then(rest, '#') {
        hp.codepage = v as u32;
        rest = &rest[len..];
    }

    if !rest.starts_with('@') {
        return None;
    }
    rest = &rest[1..];
    let (addr, _) = consume_hex_u64(rest)?;
    hp.address = addr;
    Some(hp)
}

fn parse_h(s: &str) -> Option<HookParam> {
    let mut hp = HookParam::default();

    let mut rest = s;
    let first = rest.chars().next()?;
    match first {
        'A' => {
            hp.type_flags |= BIG_ENDIAN;
            hp.length_offset = 1;
        }
        'B' => {
            hp.length_offset = 1;
        }
        'W' => {
            hp.type_flags |= USING_UNICODE;
            hp.length_offset = 1;
        }
        'H' => {
            hp.type_flags |= USING_UNICODE | HEX_DUMP;
            hp.length_offset = 1;
        }
        'S' => hp.type_flags |= USING_STRING,
        'Q' => hp.type_flags |= USING_STRING | USING_UNICODE,
        'V' => hp.type_flags |= USING_STRING | USING_UTF8,
        'M' => hp.type_flags |= USING_STRING | USING_UNICODE | HEX_DUMP,
        _ => return None,
    }
    rest = &rest[first.len_utf8()..];

    if hp.type_flags & USING_STRING != 0 {
        if rest.starts_with('F') {
            hp.type_flags |= FULL_STRING;
            rest = &rest[1..];
        }
        if let Some((v, len)) = consume_decimal_then(rest, '<') {
            hp.null_length = v;
            rest = &rest[len..];
        }
    }

    if rest.starts_with('N') {
        hp.type_flags |= NO_CONTEXT;
        rest = &rest[1..];
    }
    if let Some((v, len)) = consume_decimal_then(rest, '#') {
        hp.codepage = v as u32;
        rest = &rest[len..];
    }
    if let Some((v, len)) = consume_hex_then(rest, '+') {
        hp.padding = v as u64;
        rest = &rest[len..];
    }

    let (off, len) = consume_hex(rest).unwrap_or((0, 0));
    hp.offset = off as i32;
    rest = &rest[len..];

    if rest.starts_with('*') {
        hp.type_flags |= DATA_INDIRECT;
        rest = &rest[1..];
        let (v, len) = consume_hex(rest).unwrap_or((0, 0));
        hp.index = v as i32;
        rest = &rest[len..];
    }

    if rest.starts_with(':') {
        hp.type_flags |= USING_SPLIT;
        rest = &rest[1..];
        let (v, len) = consume_hex(rest).unwrap_or((0, 0));
        hp.split = v as i32;
        rest = &rest[len..];

        if rest.starts_with('*') {
            hp.type_flags |= SPLIT_INDIRECT;
            rest = &rest[1..];
            let (v, len) = consume_hex(rest).unwrap_or((0, 0));
            hp.split_index = v as i32;
            rest = &rest[len..];
        }
    }

    if !rest.starts_with('@') {
        return None;
    }
    rest = &rest[1..];
    let (addr, len) = consume_hex_u64(rest)?;
    hp.address = addr;
    rest = &rest[len..];

    if rest.starts_with(':') {
        hp.type_flags |= MODULE_OFFSET;
        rest = &rest[1..];
        let end = rest.find(':').unwrap_or(rest.len());
        hp.module = rest[..end].to_string();
        rest = &rest[end..];
    }
    if rest.starts_with(':') {
        hp.type_flags |= FUNCTION_OFFSET;
        hp.function = rest[1..].to_string();
    }

    // ITH 寄存器偏移比 AGTH 少 4，需要纠正
    if hp.offset < 0 {
        hp.offset -= 4;
    }
    if hp.split < 0 {
        hp.split -= 4;
    }

    Some(hp)
}

fn generate_r(hp: &HookParam) -> String {
    let mut code = String::from("R");
    if hp.type_flags & USING_UNICODE != 0 {
        if hp.type_flags & HEX_DUMP != 0 {
            code.push('M');
        } else {
            code.push('Q');
        }
        if hp.null_length != 0 {
            code.push_str(&format!("{}<", hp.null_length));
        }
    } else {
        code.push('S');
        if hp.null_length != 0 {
            code.push_str(&format!("{}<", hp.null_length));
        }
        if hp.codepage != 0 {
            code.push_str(&format!("{}#", hp.codepage));
        }
    }
    code.push('@');
    code.push_str(&hex_u64(hp.address));
    code
}

fn generate_h(hp: &HookParam) -> String {
    let mut code = String::from("H");
    if hp.type_flags & USING_UNICODE != 0 {
        if hp.type_flags & HEX_DUMP != 0 {
            code.push(if hp.type_flags & USING_STRING != 0 { 'M' } else { 'H' });
        } else {
            code.push(if hp.type_flags & USING_STRING != 0 { 'Q' } else { 'W' });
        }
    } else if hp.type_flags & USING_STRING != 0 {
        code.push('S');
    } else if hp.type_flags & BIG_ENDIAN != 0 {
        code.push('A');
    } else {
        code.push('B');
    }

    if hp.type_flags & FULL_STRING != 0 {
        code.push('F');
    }
    if hp.null_length != 0 {
        code.push_str(&format!("{}<", hp.null_length));
    }
    if hp.type_flags & NO_CONTEXT != 0 {
        code.push('N');
    }
    if hp.codepage != 0 && hp.type_flags & USING_UNICODE == 0 {
        code.push_str(&format!("{}#", hp.codepage));
    }
    if hp.padding != 0 {
        code.push_str(&hex_i64(hp.padding as i64));
        code.push('+');
    }

    let mut offset = hp.offset;
    let mut split = hp.split;
    if offset < 0 {
        offset += 4;
    }
    if split < 0 {
        split += 4;
    }

    code.push_str(&hex_i32(offset));
    if hp.type_flags & DATA_INDIRECT != 0 {
        code.push('*');
        code.push_str(&hex_i32(hp.index));
    }
    if hp.type_flags & USING_SPLIT != 0 {
        code.push(':');
        code.push_str(&hex_i32(split));
    }
    if hp.type_flags & SPLIT_INDIRECT != 0 {
        code.push('*');
        code.push_str(&hex_i32(hp.split_index));
    }

    code.push('@');
    code.push_str(&hex_u64(hp.address));
    if hp.type_flags & MODULE_OFFSET != 0 {
        code.push(':');
        code.push_str(&hp.module);
    }
    if hp.type_flags & FUNCTION_OFFSET != 0 {
        code.push(':');
        code.push_str(&hp.function);
    }
    code
}

// ---- 扫描辅助 ----

fn consume_decimal_then(s: &str, ch: char) -> Option<(i32, usize)> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    let val: i32 = s[..i].parse().ok()?;
    if !s[i..].starts_with(ch) {
        return None;
    }
    Some((val, i + ch.len_utf8()))
}

fn consume_hex(s: &str) -> Option<(i64, usize)> {
    let bytes = s.as_bytes();
    let mut i = 0;
    let neg = if i < bytes.len() && bytes[i] == b'-' {
        i += 1;
        true
    } else {
        false
    };
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_hexdigit() {
        i += 1;
    }
    if i == start {
        return None;
    }
    let val = i64::from_str_radix(&s[start..i], 16).ok()?;
    Some((if neg { -val } else { val }, i))
}

fn consume_hex_u64(s: &str) -> Option<(u64, usize)> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_hexdigit() {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    let val = u64::from_str_radix(&s[..i], 16).ok()?;
    Some((val, i))
}

fn consume_hex_then(s: &str, ch: char) -> Option<(i64, usize)> {
    let (v, len) = consume_hex(s)?;
    if !s[len..].starts_with(ch) {
        return None;
    }
    Some((v, len + ch.len_utf8()))
}

// ---- 十六进制格式化 ----

fn hex_i32(v: i32) -> String {
    if v < 0 {
        format!("-{:X}", -v)
    } else {
        format!("{:X}", v)
    }
}

fn hex_i64(v: i64) -> String {
    if v < 0 {
        format!("-{:X}", -v)
    } else {
        format!("{:X}", v)
    }
}

fn hex_u64(v: u64) -> String {
    format!("{:X}", v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_samples() {
        assert!(parse("/HQN936#-c*C:C*1C@4AA:gdi.dll:GetTextOutA").is_some());
        assert!(parse("/HQN936#-c*C:C*1C@4AA:gdi.dll:GetTextOutA /KF").is_some());
        assert!(parse("HB4@0").is_some());
        assert!(parse("/RS65001#@44").is_some());
        assert!(parse("HQ@4").is_some());
        assert!(parse("/RW@44").is_none());
        assert!(parse("/HWG@33").is_none());
    }
}
