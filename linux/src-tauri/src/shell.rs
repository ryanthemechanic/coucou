// The GNOME Shell side of the island.
//
// On Wayland an application may not place its own windows, keep them above
// others, or read the pointer outside them. The companion extension
// (`linux/gnome-extension/`) does those three things for us and nothing else,
// over the session bus. Every call here is short and fails soft: without the
// extension the island still works, it just sits wherever Mutter puts it and
// only sees the pointer while the pointer is over it.

use std::sync::Mutex;
use std::time::Duration;

use dbus::blocking::Connection;

const DEST: &str = "org.gnome.Shell";
const PATH: &str = "/io/github/ryanthemechanic/Coucou";
const IFACE: &str = "io.github.ryanthemechanic.Coucou";
/// The cursor poll runs at 60 Hz; a call that takes longer than this is useless.
const TIMEOUT: Duration = Duration::from_millis(50);

/// GDK_BUTTON1_MASK in Clutter's modifier state.
const BUTTON1_MASK: u32 = 1 << 8;

static BUS: Mutex<Option<Connection>> = Mutex::new(None);
/// Logged once, not 60 times a second.
static WARNED: Mutex<bool> = Mutex::new(false);

fn call<R: dbus::arg::ReadAll, A: dbus::arg::AppendAll>(method: &str, args: A) -> Option<R> {
    let mut guard = BUS.lock().ok()?;
    if guard.is_none() {
        *guard = Connection::new_session().ok();
    }
    let conn = guard.as_ref()?;
    let proxy = conn.with_proxy(DEST, PATH, TIMEOUT);
    match proxy.method_call::<R, A, _, _>(IFACE, method, args) {
        Ok(r) => Some(r),
        Err(err) => {
            let mut warned = WARNED.lock().unwrap();
            if !*warned {
                *warned = true;
                crate::log::line(format!(
                    "GNOME Shell extension not answering ({}) — island placement and pointer are degraded",
                    err.message().unwrap_or("?")
                ));
            }
            None
        }
    }
}

fn pid() -> u32 {
    std::process::id()
}

/// Logical geometry of a display: x, y, width, height, scale.
pub struct Display {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// The display the island belongs on: "primary" or "cursor".
pub fn display(pref: &str) -> Option<Display> {
    let (x, y, width, height, scale): (f64, f64, f64, f64, f64) =
        call("Display", (pref.to_string(),))?;
    Some(Display { x, y, width, height, scale })
}

/// Centre the island window at the top of the chosen display and keep it above
/// everything, on every workspace. `width`/`height` are logical pixels.
pub fn place(width: f64, height: f64, pref: &str) -> bool {
    call::<(bool,), _>("Place", (pid(), width, height, pref.to_string()))
        .map(|(ok,)| ok)
        .unwrap_or(false)
}

/// Give the island keyboard focus (a text field wants typing).
pub fn activate() -> bool {
    call::<(bool,), _>("Activate", (pid(),)).map(|(ok,)| ok).unwrap_or(false)
}

pub struct Pointer {
    /// Window-relative, logical pixels.
    pub x: f64,
    pub y: f64,
    pub left_down: bool,
}

/// The pointer relative to the island window, wherever it is on screen.
pub fn pointer() -> Option<Pointer> {
    let (found, x, y, mods): (bool, f64, f64, u32) = call("Pointer", (pid(),))?;
    found.then_some(Pointer { x, y, left_down: mods & BUTTON1_MASK != 0 })
}
