//! 原生窗口背景效果（none / aero / acrylic / mica）。
//!
//! 直接调用 Win32 DWM / `SetWindowCompositionAttribute`（参考 ref2 的
//! `ApplyBackdropEffect`），以修复 Tauri 内置 `set_effects` 在新系统上
//! Aero（Blur）失效、以及亚克力 / 云母在夜间模式下色彩与 Windows 原生不一致
//! 的问题。圆角由前端 CSS 负责（透明窗口），原生效果在 Win11 上通过
//! `DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND` 请求系统圆角。
//! 注意：不要用 `SetWindowRgn` 裁剪 Tauri 的透明（layered）窗口 —— 那会导致
//! 透明失效、圆角变不透明并冒出老式标题栏。

use tauri::WebviewWindow;

/// 把本地图片读取为 data URI，便于在 CSS `backgroundImage` 中使用。
pub fn read_image_data_uri(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mime = guess_mime(path);
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

fn guess_mime(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "image/png"
    }
}

/// 为指定窗口应用原生背景效果（none/aero/acrylic/mica）。
/// `dark` 表示当前应用主题为暗色，用于让原生效果跟随主题色；
/// `tint`（#RRGGBB）与 `tint_alpha`（0..1）允许用户自定义 Aero/亚克力的 tint。
pub fn apply_effect(
    window: &WebviewWindow,
    effect: &str,
    dark: bool,
    tint: Option<&str>,
    tint_alpha: Option<f32>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        apply_effect_windows(window, effect, dark, tint, tint_alpha)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, effect, dark, tint, tint_alpha);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Windows 实现
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmEnableBlurBehindWindow, DwmSetWindowAttribute, DWM_BLURBEHIND,
        DWMWA_SYSTEMBACKDROP_TYPE, DWMWA_USE_IMMERSIVE_DARK_MODE,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND, DWMSBT_MAINWINDOW,
        DWMSBT_NONE, DWMSBT_TRANSIENTWINDOW,
    };
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

    // windows-sys 0.59 未收录 DWMWA_MICA_EFFECT（Win11 的旧版 Mica 开关）。
    const DWMWA_MICA_EFFECT: u32 = 1029;

    // SetWindowCompositionAttribute（未文档化 API）的常量与结构体。
    const ACCENT_DISABLED: i32 = 0;
    const ACCENT_ENABLE_BLURBEHIND: i32 = 3;
    const ACCENT_ENABLE_ACRYLICBLURBEHIND: i32 = 4;
    const WCA_ACCENT_POLICY: i32 = 19;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct AccentPolicy {
        accent_state: i32,
        accent_flags: i32,
        gradient_color: i32,
        animation_id: i32,
    }

    #[repr(C)]
    struct WindowCompositionAttribData {
        attrib: i32,
        pv_data: *mut c_void,
        cb_data: usize,
    }

    type SetWindowCompositionAttributeFn =
        unsafe extern "system" fn(HWND, *mut WindowCompositionAttribData) -> i32;

    pub fn apply_effect_windows(
        window: &tauri::WebviewWindow,
        effect: &str,
        dark: bool,
        tint: Option<&str>,
        tint_alpha: Option<f32>,
    ) -> Result<(), String> {
        let hwnd = hwnd_of(window)?;
        unsafe {
            clear_effects(hwnd);

            match effect {
                "aero" => apply_aero(hwnd, dark, tint, tint_alpha),
                "acrylic" => apply_acrylic(hwnd, dark, tint, tint_alpha),
                "mica" => apply_mica(hwnd, dark),
                _ => {}
            }

            // 原生效果会覆盖整个窗口矩形，这里请求 DWM 在 Win11 上统一圆角裁剪
            // 整个窗口（包括 none/透明模式），避免前端再叠一层 CSS 圆角造成双重圆角。
            let corner: i32 = DWMWCP_ROUND;
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE as u32,
                &corner as *const i32 as *const c_void,
                std::mem::size_of::<i32>() as u32,
            );
        }
        Ok(())
    }

    fn hwnd_of(window: &tauri::WebviewWindow) -> Result<HWND, String> {
        let h = window.hwnd().map_err(|e| e.to_string())?;
        // tauri 的 `windows` crate HWND → windows-sys 的 HWND（均为 *mut c_void 别名）。
        Ok(h.0)
    }

    /// 清除所有原生背景效果。
    unsafe fn clear_effects(hwnd: HWND) {
        set_accent(hwnd, ACCENT_DISABLED, 0, 0);

        let none: i32 = DWMSBT_NONE;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE as u32,
            &none as *const i32 as *const c_void,
            std::mem::size_of::<i32>() as u32,
        );
        let mica_off: i32 = 0;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_MICA_EFFECT,
            &mica_off as *const i32 as *const c_void,
            std::mem::size_of::<i32>() as u32,
        );
    }

    /// Aero（旧式模糊）：SetWindowCompositionAttribute 的 ACCENT_ENABLE_BLURBEHIND。
    unsafe fn apply_aero(hwnd: HWND, dark: bool, tint: Option<&str>, tint_alpha: Option<f32>) {
        let tint = compose_tint(dark, tint, tint_alpha);
        if set_window_composition_attribute().is_some() {
            set_accent(hwnd, ACCENT_ENABLE_BLURBEHIND, 0, tint);
        } else {
            // 兜底：老系统上 WCA 可能不可用，退回到 DWM 的 BlurBehind。
            let blur = DWM_BLURBEHIND {
                dwFlags: 0x1, // DWM_BB_ENABLE
                fEnable: 1,
                hRgnBlur: std::ptr::null_mut(),
                fTransitionOnMaximized: 0,
            };
            DwmEnableBlurBehindWindow(hwnd, &blur);
        }
    }

    /// 亚克力：优先 WCA 的 ACCENT_ENABLE_ACRYLICBLURBEHIND（可自定义 tint），
    /// 新系统上回退到 DWM 的 DWMSBT_TRANSIENTWINDOW。
    unsafe fn apply_acrylic(hwnd: HWND, dark: bool, tint: Option<&str>, tint_alpha: Option<f32>) {
        set_dark_mode(hwnd, dark);

        if set_window_composition_attribute().is_some() {
            let tint = compose_tint(dark, tint, tint_alpha);
            set_accent(hwnd, ACCENT_ENABLE_ACRYLICBLURBEHIND, 2, tint);
        } else {
            let sbt: i32 = DWMSBT_TRANSIENTWINDOW;
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_SYSTEMBACKDROP_TYPE as u32,
                &sbt as *const i32 as *const c_void,
                std::mem::size_of::<i32>() as u32,
            );
        }
    }

    /// 云母：DWM 的 DWMSBT_MAINWINDOW，老 Win11 回退 DWMWA_MICA_EFFECT。
    unsafe fn apply_mica(hwnd: HWND, dark: bool) {
        set_dark_mode(hwnd, dark);

        let sbt: i32 = DWMSBT_MAINWINDOW;
        let hr = DwmSetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE as u32,
            &sbt as *const i32 as *const c_void,
            std::mem::size_of::<i32>() as u32,
        );
        if hr < 0 {
            let mica_on: i32 = 1;
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_MICA_EFFECT,
                &mica_on as *const i32 as *const c_void,
                std::mem::size_of::<i32>() as u32,
            );
        }
    }

    unsafe fn set_dark_mode(hwnd: HWND, dark: bool) {
        let value: i32 = if dark { 1 } else { 0 };
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
            &value as *const i32 as *const c_void,
            std::mem::size_of::<i32>() as u32,
        );
    }

    /// 动态加载 `SetWindowCompositionAttribute`（未文档化，user32.dll）。
    fn set_window_composition_attribute() -> Option<SetWindowCompositionAttributeFn> {
        let name: Vec<u16> = "user32.dll".encode_utf16().chain(std::iter::once(0)).collect();
        let module = unsafe { GetModuleHandleW(name.as_ptr()) };
        if module.is_null() {
            return None;
        }
        let proc_name = b"SetWindowCompositionAttribute\0";
        let proc = unsafe { GetProcAddress(module, proc_name.as_ptr()) }?;
        Some(unsafe { std::mem::transmute(proc) })
    }

    unsafe fn set_accent(hwnd: HWND, state: i32, flags: i32, gradient: i32) {
        let Some(f) = set_window_composition_attribute() else {
            return;
        };
        let mut policy = AccentPolicy {
            accent_state: state,
            accent_flags: flags,
            gradient_color: gradient,
            animation_id: 0,
        };
        let mut data = WindowCompositionAttribData {
            attrib: WCA_ACCENT_POLICY,
            pv_data: &mut policy as *mut AccentPolicy as *mut c_void,
            cb_data: std::mem::size_of::<AccentPolicy>(),
        };
        f(hwnd, &mut data);
    }

    /// 生成 ABGR（Windows 存储为 0xAABBGGRR）的 tint 颜色。
    /// `tint` 为空时按主题使用默认的暗/亮 tint；`tint_alpha` 控制不透明度。
    fn compose_tint(dark: bool, tint: Option<&str>, tint_alpha: Option<f32>) -> i32 {
        let (r, g, b) = match tint.and_then(parse_hex_color) {
            Some((r, g, b)) => (r, g, b),
            None if dark => (32, 32, 32),
            None => (255, 255, 255),
        };
        let a = (tint_alpha.unwrap_or(0.75).clamp(0.0, 1.0) * 255.0).round() as u8;
        (((a as u32) << 24) | ((b as u32) << 16) | ((g as u32) << 8) | (r as u32)) as i32
    }

    /// 解析 #RGB / #RRGGBB 颜色。
    fn parse_hex_color(input: &str) -> Option<(u8, u8, u8)> {
        let s = input.trim().trim_start_matches('#');
        let expand = |h: &str| -> Option<u8> {
            u8::from_str_radix(h, 16).ok()
        };
        match s.len() {
            3 => {
                let r = expand(&s[0..1])?;
                let g = expand(&s[1..2])?;
                let b = expand(&s[2..3])?;
                Some((r * 17, g * 17, b * 17))
            }
            6 => {
                let r = expand(&s[0..2])?;
                let g = expand(&s[2..4])?;
                let b = expand(&s[4..6])?;
                Some((r, g, b))
            }
            _ => None,
        }
    }
}

#[cfg(target_os = "windows")]
use win::apply_effect_windows;
