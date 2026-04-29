// Hermes 桌宠 - Tauri 后端入口
//
// 当前阶段（2026-04-29，穿透修正版）：
// - 透明 + floating + all-spaces + never-hide
// - 启动时默认鼠标穿透，透明区域不拦截桌面/其它 app
// - 前端注册可交互矩形，Rust 轮询全局鼠标坐标并自动切 ignoresMouseEvents
// - 鼠标按下后短暂捕获，避免拖动宠物时离开矩形导致事件丢失

mod runner;

use serde::Deserialize;
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[derive(Clone, Debug, Deserialize)]
struct HitRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl HitRegion {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.width && y >= self.y && y <= self.y + self.height
    }
}

#[derive(Default)]
struct MouseHitState {
    regions: Mutex<Vec<HitRegion>>,
}

/// 切换 pet 窗口的鼠标穿透状态。前端 hit-test 后调：
/// - `passthrough = true`  → 圆外，事件穿透到桌面
/// - `passthrough = false` → 圆内，webview 接收事件
#[tauri::command]
fn set_pet_passthrough(window: tauri::Window, passthrough: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(passthrough)
        .map_err(|e| format!("set_ignore_cursor_events failed: {e}"))
}

/// 前端把当前可交互 DOM 区域同步给后端，后端负责在穿透状态下找回鼠标。
#[tauri::command]
fn set_pet_hit_regions(
    state: tauri::State<'_, Arc<MouseHitState>>,
    regions: Vec<HitRegion>,
) -> Result<(), String> {
    let mut guard = state
        .regions
        .lock()
        .map_err(|_| "hit region lock poisoned".to_string())?;
    *guard = regions;
    Ok(())
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

#[cfg(target_os = "macos")]
fn start_mouse_passthrough_poller(win: tauri::WebviewWindow, hit_state: Arc<MouseHitState>) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSPoint, NSRect};
    use std::time::Duration;

    std::thread::spawn(move || {
        let mut last_passthrough: Option<bool> = None;
        let mut captured = false;

        loop {
            let regions = match hit_state.regions.lock() {
                Ok(guard) => guard.clone(),
                Err(_) => Vec::new(),
            };

            let Some((x, y, pressed_buttons)) = macos_mouse_in_window_points(&win) else {
                std::thread::sleep(Duration::from_millis(33));
                continue;
            };

            let primary_down = pressed_buttons & 1 != 0;
            let inside_region = regions.iter().any(|region| region.contains(x, y));

            if primary_down && inside_region {
                captured = true;
            } else if !primary_down {
                captured = false;
            }

            let passthrough = !(inside_region || captured);
            if last_passthrough != Some(passthrough) {
                if let Err(e) = win.set_ignore_cursor_events(passthrough) {
                    eprintln!("[hermes-pet] set_ignore_cursor_events({passthrough}) failed: {e}");
                } else {
                    last_passthrough = Some(passthrough);
                }
            }

            std::thread::sleep(Duration::from_millis(33));
        }
    });

    fn macos_mouse_in_window_points(win: &tauri::WebviewWindow) -> Option<(f64, f64, usize)> {
        let ns_window_ptr: *mut std::ffi::c_void = win.ns_window().ok()?;
        if ns_window_ptr.is_null() {
            return None;
        }

        unsafe {
            let window: *mut AnyObject = ns_window_ptr.cast();
            let mouse: NSPoint = msg_send![class!(NSEvent), mouseLocation];
            let frame: NSRect = msg_send![window, frame];
            let pressed_buttons: usize = msg_send![class!(NSEvent), pressedMouseButtons];

            // AppKit screen/window coordinates are bottom-left based; CSS uses top-left.
            let x = mouse.x - frame.origin.x;
            let y = frame.size.height - (mouse.y - frame.origin.y);
            Some((x, y, pressed_buttons))
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn start_mouse_passthrough_poller(_win: tauri::WebviewWindow, _hit_state: Arc<MouseHitState>) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hit_state = Arc::new(MouseHitState::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(hit_state.clone())
        .invoke_handler(tauri::generate_handler![
            set_pet_passthrough,
            set_pet_hit_regions,
            runner::hermes_discover,
            runner::hermes_start_chat,
            runner::hermes_cancel
        ])
        .setup(move |app| {
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

                // 启动默认穿透；等前端上报 hit region 后，后端 poller 会按需切回可交互。
                if let Err(e) = win.set_ignore_cursor_events(true) {
                    eprintln!("[hermes-pet] set_ignore_cursor_events(true) failed: {e}");
                }
                tame_macos_window(&win);
                start_mouse_passthrough_poller(win, hit_state.clone());
            } else {
                eprintln!("[hermes-pet] pet window not found at startup!");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
