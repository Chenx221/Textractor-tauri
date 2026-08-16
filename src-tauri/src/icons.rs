//! 进程图标提取：用 SHGetFileInfoW 取小图标，画到 32bpp DIB（保留 alpha），
//! 封装为 PNG data URI（base64），前端直接 `<img src=...>` 渲染。

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;

use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDIBits, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, HBITMAP, HGDIOBJ,
};
use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON};
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, DrawIconEx, HICON, DI_NORMAL};

const ICON_SIZE: i32 = 16;

/// 返回 `data:image/bmp;base64,...`，失败返回 None。
pub fn process_icon_data_uri(exe: &str) -> Option<String> {
    unsafe {
        let wide: Vec<u16> = std::ffi::OsStr::new(exe)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut sfi: SHFILEINFOW = std::mem::zeroed();
        let res = SHGetFileInfoW(
            wide.as_ptr(),
            0,
            &mut sfi,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_SMALLICON,
        );
        if res == 0 || sfi.hIcon.is_null() {
            return None;
        }
        let result = icon_to_png(sfi.hIcon);
        DestroyIcon(sfi.hIcon);
        result
    }
}

unsafe fn icon_to_png(hicon: HICON) -> Option<String> {
    let w = ICON_SIZE;
    let h = ICON_SIZE;

    let mut bih: BITMAPINFOHEADER = std::mem::zeroed();
    bih.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bih.biWidth = w;
    bih.biHeight = -h; // 负值表示 top-down
    bih.biPlanes = 1;
    bih.biBitCount = 32;
    bih.biCompression = BI_RGB;

    let mut bmi: BITMAPINFO = std::mem::zeroed();
    bmi.bmiHeader = bih;

    let mut bits: *mut c_void = std::ptr::null_mut();
    let hdc: HDC = CreateCompatibleDC(std::ptr::null_mut());
    if hdc.is_null() {
        return None;
    }
    let hbmp: HBITMAP = CreateDIBSection(hdc, &bmi, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
    if hbmp.is_null() {
        DeleteDC(hdc);
        return None;
    }
    // 透明背景（全零）。
    std::ptr::write_bytes(bits as *mut u8, 0, (w * h * 4) as usize);

    let old: HGDIOBJ = SelectObject(hdc, hbmp as HGDIOBJ);
    DrawIconEx(hdc, 0, 0, hicon, w, h, 0, std::ptr::null_mut(), DI_NORMAL);

    let mut bgra = vec![0u8; (w * h * 4) as usize];
    GetDIBits(
        hdc,
        hbmp,
        0,
        h as u32,
        bgra.as_mut_ptr() as *mut c_void,
        &mut bmi,
        DIB_RGB_COLORS,
    );

    SelectObject(hdc, old);
    DeleteObject(hbmp as HGDIOBJ);
    DeleteDC(hdc);

    // BGRA → RGBA
    let mut rgba = Vec::with_capacity(bgra.len());
    for px in bgra.chunks_exact(4) {
        rgba.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
    }

    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, w as u32, h as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&rgba).ok()?;
    }

    Some(format!(
        "data:image/png;base64,{}",
        base64_encode(&png_bytes)
    ))
}

fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}
