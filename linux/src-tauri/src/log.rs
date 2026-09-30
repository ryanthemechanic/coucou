// Small append-only log at ~/.local/share/coucou/coucou.log — the Linux
// equivalent of nbLog() in HookServer.swift. Nothing leaves the machine.

use std::io::Write;

use crate::settings;

/// Local wall-clock time, broken down (year, month, day, hour, minute, second).
pub fn local_now() -> (i32, u32, u32, u32, u32, u32) {
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&now, &mut tm);
        (
            tm.tm_year + 1900,
            (tm.tm_mon + 1) as u32,
            tm.tm_mday as u32,
            tm.tm_hour as u32,
            tm.tm_min as u32,
            tm.tm_sec as u32,
        )
    }
}

pub fn line(message: impl AsRef<str>) {
    let (y, mo, d, h, mi, s) = local_now();
    let stamp = format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}");
    let dir = settings::local_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("coucou.log");
    // Keep it from growing forever: start fresh past ~1 MB.
    if std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{stamp} {}", message.as_ref());
    }
}
