fn main() {
    // BUILD_TIME 是通过 `cargo:rustc-env` 烤进二进制的，而 cargo 会**缓存 build
    // script 的输出**：只要脚本本身不重跑，旧的时间戳就会被一直复用。
    // tauri-build 只为 tauri.conf.json / capabilities 声明了 rerun-if-changed，
    // 而脚本一旦声明了 rerun-if-*，cargo 就不再使用“包内任意文件变化就重跑”的
    // 默认规则 —— 所以这里必须把 src 也声明进来，否则改了源码重新编译，
    // 二进制里仍是上一次脚本运行时注入的时间。
    println!("cargo:rerun-if-changed=src");

    tauri_build::build();

    println!("cargo:rustc-env=BUILD_TIME={}", build_time());
}

/// 编译时刻（本地时区），形如 `2026-09-30 01:40:20 +08:00`。
///
/// 注意这是 build script 运行的时刻（编译开始之前），不是链接完成的时刻；
/// 源码没有任何变化时 cargo 不会重编，这个值自然也不会变。
#[cfg(windows)]
fn build_time() -> String {
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;
    use windows_sys::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};

    /// `GetTimeZoneInformation` 的返回值：当前处于夏令时。
    const TIME_ZONE_ID_DAYLIGHT: u32 = 2;

    let mut now: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut now) };

    // 本地时间 = UTC - Bias（Bias 以分钟计，东八区是 -480；夏令时还要加 DaylightBias）。
    let mut tz: TIME_ZONE_INFORMATION = unsafe { std::mem::zeroed() };
    let state = unsafe { GetTimeZoneInformation(&mut tz) };
    let bias = if state == TIME_ZONE_ID_DAYLIGHT {
        tz.Bias + tz.DaylightBias
    } else {
        tz.Bias
    };
    let (sign, minutes) = if bias > 0 { ('-', bias) } else { ('+', -bias) };

    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02} {}{:02}:{:02}",
        now.wYear,
        now.wMonth,
        now.wDay,
        now.wHour,
        now.wMinute,
        now.wSecond,
        sign,
        minutes / 60,
        minutes % 60
    )
}

/// 非 Windows 平台退回 UTC（Howard Hinnant 的 civil_from_days 算法）。
#[cfg(not(windows))]
fn build_time() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (now / 86400) as i64;
    let secs = now % 86400;
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC",
        year,
        month,
        day,
        secs / 3600,
        (secs / 60) % 60,
        secs % 60
    )
}
