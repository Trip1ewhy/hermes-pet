// Hermes 桌宠 - Tauri 后端入口
//
// 当前阶段（2026-04-28，spike 阶段一稳定版）：
// - 透明 + always-on-top + all-spaces + never-hide
// - 启动时铺满主屏，ignoresMouseEvents = false（webview 接管鼠标）
// - 暴露 Tauri command set_pet_passthrough，前端按需切（暂未启用）
//
// 已知有意保留的尾巴：
// 圆外的桌面图标点不到——整屏被 webview 接管。
// 之前尝试的两个穿透方案都失败：
//   * 方案 X1：webview 自己监听 mousemove + 进出圆切 ignoresMouseEvents
//     → 一旦穿透，webview 就再也收不到 mousemove，没法切回
//   * 方案 X2：Rust 30Hz 轮询 NSEvent.mouseLocation + emit "global-mouse"
//     → poller 跑起来了但前端 listen 不响应，调试条死掉
// 这条 spike 暂搁置，等核心交互（流 B/C）跑通后再单独啃。

use tauri::Manager;

/// 切换 pet 窗口的鼠标穿透状态。前端 hit-test 后调：
/// - `passthrough = true`  → 圆外，事件穿透到桌面
/// - `passthrough = false` → 圆内，webview 接收事件
#[tauri::command]
fn set_pet_passthrough(window: tauri::Window, passthrough: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(passthrough)
        .map_err(|e| format!("set_ignore_cursor_events failed: {e}"))
}

#[cfg(target_os = "macos")]
fn tame_macos_window(win: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let ns_window_ptr: *mut std::ffi::c_void = match win.ns_window() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[hermes-pet] ns_window() failed: {e}");
            return;
        }
    };
    if ns_window_ptr.is_null() {
        eprintln!("[hermes-pet] ns_window pointer null");
        return;
    }

    unsafe {
        let window: *mut AnyObject = ns_window_ptr.cast();

        // 1. 跨所有 Spaces + 浮动在全屏应用上方 + 不在 ⌘Tab
        // canJoinAllSpaces (1<<0) | fullScreenAuxiliary (1<<8)
        // | stationary (1<<4) | ignoresCycle (1<<3)
        let behavior: usize = (1 << 0) | (1 << 4) | (1 << 8) | (1 << 3);
        let _: () = msg_send![window, setCollectionBehavior: behavior];

        // 2. 拉到 floating window level
        let _: () = msg_send![window, setLevel: 3i64];

        // 3. 切 App 后不隐藏
        let _: () = msg_send![window, setHidesOnDeactivate: false];
    }

    eprintln!("[hermes-pet] macOS window tamed: floating, all-spaces, never hide");
}

#[cfg(not(target_os = "macos"))]
fn tame_macos_window(_win: &tauri::WebviewWindow) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![set_pet_passthrough])
        .setup(|app| {
            if let Some(win) = app.get_webview_window("pet") {
                if let Ok(Some(monitor)) = win.primary_monitor() {
                    let size = monitor.size();
                    let pos = monitor.position();
                    let _ = win.set_size(tauri::PhysicalSize::new(size.width, size.height));
                    let _ = win.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
                    eprintln!(
                        "[hermes-pet] resized to primary monitor: {}x{} @ ({},{})",
                        size.width, size.height, pos.x, pos.y
                    );
                }

                // 启动不穿透，让 webview 接管整个屏幕的鼠标
                if let Err(e) = win.set_ignore_cursor_events(false) {
                    eprintln!("[hermes-pet] set_ignore_cursor_events(false) failed: {e}");
                }
                tame_macos_window(&win);
            } else {
                eprintln!("[hermes-pet] pet window not found at startup!");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
