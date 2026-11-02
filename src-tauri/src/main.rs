#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod external;
mod storage;

use serde_json::Value;
use storage::{Saved, Snapshot, Store, StoreError};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

fn local_url(url: &tauri::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some("tauri.localhost")
            && url.port().is_none())
}

fn check_window(window: &tauri::WebviewWindow) -> Result<(), StoreError> {
    let url = window
        .url()
        .map_err(|_| StoreError::new(403, "无法确认窗口来源"))?;
    if window.label() != "main" || !local_url(&url) {
        return Err(StoreError::new(403, "拒绝非主窗口的数据请求"));
    }
    Ok(())
}

#[tauri::command]
async fn load_workspace(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, Store>,
    initial_state: Value,
) -> Result<Snapshot, StoreError> {
    check_window(&window)?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.load(initial_state))
        .await
        .map_err(|_| StoreError::new(500, "本地数据读取任务失败，原文件已保留"))?
}

#[tauri::command]
async fn save_workspace(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, Store>,
    state: Value,
    revision: u64,
) -> Result<Saved, StoreError> {
    check_window(&window)?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.save(state, revision))
        .await
        .map_err(|_| StoreError::new(500, "本地数据保存任务失败，原文件已保留"))?
}

#[tauri::command]
fn hide_to_tray(window: tauri::WebviewWindow) -> Result<(), StoreError> {
    check_window(&window)?;
    if window.app_handle().tray_by_id("main-tray").is_none() {
        return Err(StoreError::new(500, "托盘图标不可用，窗口保持打开"));
    }
    window
        .hide()
        .map_err(|_| StoreError::new(500, "无法隐藏到托盘，请重试"))
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(Store::from_environment(app.path().app_data_dir()?)?);
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .cloned()
                .ok_or_else(|| StoreError::new(500, "未配置主窗口"))?;
            tauri::WebviewWindowBuilder::from_config(app, &config)?
                .on_navigation(local_url)
                .on_download(|webview, event| {
                    if let tauri::webview::DownloadEvent::Finished { path, success, .. } = event {
                        let _ = webview.emit(
                            "backup-download-finished",
                            serde_json::json!({"success": success, "path": path}),
                        );
                    }
                    true
                })
                .on_new_window(|url, _| {
                    external::open(&url);
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;
            let show = MenuItem::with_id(app, "tray-show", "显示主窗口", true, None::<&str>)?;
            let exit = MenuItem::with_id(app, "tray-exit", "退出软件", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &exit])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or_else(|| StoreError::new(500, "缺少托盘图标，无法启用托盘功能"))?;
            TrayIconBuilder::with_id("main-tray")
                .icon(icon)
                .tooltip("一事")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray-show" => show_main_window(app),
                    "tray-exit" => {
                        // Keep save/conflict checks in the frontend's shared close guard.
                        show_main_window(app);
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("tray-exit-requested", ());
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                    | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => show_main_window(tray.app_handle()),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            save_workspace,
            hide_to_tray
        ])
        .run(tauri::generate_context!())
        .expect("一事桌面窗口启动失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_bundled_origins_can_navigate_or_access_workspace_commands() {
        for address in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/app.mjs",
        ] {
            assert!(local_url(&tauri::Url::parse(address).unwrap()));
        }
        for address in [
            "http://localhost:4317/",
            "http://127.0.0.1/",
            "https://example.com/",
            "http://tauri.localhost:4317/",
            "file:///C:/data/workspace.json",
        ] {
            assert!(!local_url(&tauri::Url::parse(address).unwrap()));
        }
    }
}
