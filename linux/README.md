# Coucou for Linux (Fedora / GNOME Wayland)

Personal port of the Windows (Tauri 2) build. Mochi hangs just below the GNOME
top bar, shows Claude Code sessions, and lets you approve permissions, chat and
drop files.

## Pieces

```
linux/
  src/, src-tauri/     the app (same front end as windows/, Rust backend ported)
  hook/                coucou-hook, the Claude Code relay (Unix socket)
  gnome-extension/     companion Shell extension: placement, keep-above, pointer
```

Wayland lets only the Shell place windows, keep them above others and read the
pointer everywhere, so the extension does those three things over D-Bus
(`org.gnome.Shell` → `/io/github/ryanthemechanic/Coucou`). Without it the app
still runs, the island just sits wherever Mutter puts it.

| Windows build            | Linux build                                  |
|--------------------------|----------------------------------------------|
| named pipe `coucou-<sid>`| `$XDG_RUNTIME_DIR/coucou.sock`, 0600, SO_PEERCRED check |
| Credential Manager       | Secret Service (GNOME Keyring)               |
| `%APPDATA%\Coucou`       | `~/.config/coucou/settings.json`             |
| `%LOCALAPPDATA%\Coucou`  | `~/.local/share/coucou/` (relay, inbox, log) |
| Win32 cursor poll        | extension `Pointer()`                        |

## Build

```
sudo dnf install rust cargo webkit2gtk4.1-devel libappindicator-gtk3-devel \
    librsvg2-devel openssl-devel gtk3-devel libsoup3-devel dbus-devel
cd linux
npm install
npm run tauri dev                 # development
npx tauri build --no-bundle       # target/release/coucou
npx tauri build                   # .rpm in target/release/bundle/rpm/
```

Extension (log out and back in once after linking, Wayland only rescans at login):

```
ln -sfn "$PWD/gnome-extension" ~/.local/share/gnome-shell/extensions/coucou@ryanthemechanic.github.io
gnome-extensions enable coucou@ryanthemechanic.github.io
```

The tray icon needs the AppIndicator extension (`appindicatorsupport@rgcjonas.gmail.com`).

## Notes

- NVIDIA + Wayland: WebKitGTK's DMA-BUF renderer crashes the app with
  `Error 71 (Protocol error)`; `main.rs` sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
- Log: `~/.local/share/coucou/coucou.log`.
