// Coucou runs without a console window: Mochi is the whole UI.

fn main() {
    // WebKitGTK's DMA-BUF renderer kills the app on NVIDIA under Wayland
    // ("Error 71 (Protocol error) dispatching to Wayland display"). The shared
    // memory path is plenty for one small island. An explicit value wins.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    coucou_lib::run()
}
